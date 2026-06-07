// Package arc is the official Go client for arc's Engine-A (infrastructure secrets) HTTP
// API. It targets the same surface the operator + agent use: log in via an auth method,
// read KV v2 secrets, issue dynamic credentials, and manage leases.
//
// It is deliberately dependency-free (standard library only) so it drops into any Go
// service without dragging in a transitive graph. Engine-B (the end-to-end vault) is NOT
// exposed here — that's a client-side zero-knowledge cryptosystem; use the TypeScript SDK
// for vault items.
//
// Trust model: this client never decides authorization. arc-server's JwtAuthGuard +
// CapabilityGuard (@arc/grants) gate every call; a 403 is returned as an *APIError without
// retry. On a 401 the client drops its cached token and retries the request once.
package arc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Client is a handle to an arc-server instance. Construct it with New and (optionally)
// authenticate via LoginKubernetes or SetToken. Safe for concurrent use.
type Client struct {
	baseURL    string
	httpClient *http.Client

	mu    sync.Mutex
	token string
}

// Option configures a Client.
type Option func(*Client)

// WithHTTPClient overrides the default *http.Client (useful for custom transports / tests).
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.httpClient = h }
}

// WithToken seeds the client with an existing arc JWT (e.g. obtained out of band).
func WithToken(token string) Option {
	return func(c *Client) { c.token = token }
}

// New returns a Client for the arc-server at baseURL (e.g. "https://arc.svc:3001").
func New(baseURL string, opts ...Option) *Client {
	c := &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// SetToken sets the bearer token used on subsequent requests.
func (c *Client) SetToken(token string) {
	c.mu.Lock()
	c.token = token
	c.mu.Unlock()
}

func (c *Client) currentToken() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.token
}

// APIError is returned for any non-2xx response from arc-server.
type APIError struct {
	Status int
	Method string
	Path   string
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("arc-server %s %s failed (%d): %s", e.Method, e.Path, e.Status, e.Body)
}

// ----- Auth -----

// LoginResponse is the payload of POST /v1/auth/<mount>/login.
type LoginResponse struct {
	Data struct {
		Token           string   `json:"token"`
		IdentityID      string   `json:"identityId"`
		Policies        []string `json:"policies"`
		TokenTTLSeconds int      `json:"tokenTtlSeconds"`
	} `json:"data"`
}

// LoginKubernetes authenticates with a Kubernetes ServiceAccount token via the named auth
// mount + role, caches the returned arc JWT, and returns it. `mount` defaults to
// "kubernetes" when empty.
func (c *Client) LoginKubernetes(ctx context.Context, mount, role, saToken string) (*LoginResponse, error) {
	if mount == "" {
		mount = "kubernetes"
	}
	body := map[string]string{"role": role, "jwt": saToken}
	var out LoginResponse
	if err := c.do(ctx, http.MethodPost, "auth/"+mount+"/login", body, &out, withoutAuth()); err != nil {
		return nil, err
	}
	c.SetToken(out.Data.Token)
	return &out, nil
}

// ----- KV v2 -----

// KVSecret is the response of GET /v1/<mount>/data/<path>.
type KVSecret struct {
	Data struct {
		Data     map[string]any `json:"data"`
		Metadata struct {
			Version int `json:"version"`
		} `json:"metadata"`
	} `json:"data"`
}

// KVGet reads a versioned KV v2 secret. `mount` defaults to "secret" when empty. Pass
// version <= 0 for the latest version.
func (c *Client) KVGet(ctx context.Context, mount, path string, version int) (*KVSecret, error) {
	if mount == "" {
		mount = "secret"
	}
	p := fmt.Sprintf("%s/data/%s", strings.Trim(mount, "/"), strings.TrimLeft(path, "/"))
	if version > 0 {
		p += "?version=" + fmt.Sprint(version)
	}
	var out KVSecret
	if err := c.do(ctx, http.MethodGet, p, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// KVPut writes a KV v2 secret (previous versions are retained).
func (c *Client) KVPut(ctx context.Context, mount, path string, data map[string]any) error {
	if mount == "" {
		mount = "secret"
	}
	p := fmt.Sprintf("%s/data/%s", strings.Trim(mount, "/"), strings.TrimLeft(path, "/"))
	return c.do(ctx, http.MethodPost, p, map[string]any{"data": data}, nil)
}

// ----- Dynamic credentials -----

// DynamicCredential is the response of GET /v1/<mount>/creds/<role>.
type DynamicCredential struct {
	Data          map[string]any `json:"data"`
	LeaseID       string         `json:"lease_id"`
	LeaseDuration int            `json:"lease_duration"`
	Renewable     bool           `json:"renewable"`
}

// IssueDynamic mints a short-lived dynamic credential from a plugin-backed mount (aws, gcp,
// github-app, database, …). Pass ttlSeconds <= 0 to use the role default.
func (c *Client) IssueDynamic(ctx context.Context, mount, role string, ttlSeconds int) (*DynamicCredential, error) {
	p := fmt.Sprintf("%s/creds/%s", strings.Trim(mount, "/"), strings.TrimLeft(role, "/"))
	if ttlSeconds > 0 {
		p += "?ttl=" + fmt.Sprint(ttlSeconds)
	}
	var out DynamicCredential
	if err := c.do(ctx, http.MethodGet, p, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeLease revokes a lease by id (POST /v1/sys/leases/revoke).
func (c *Client) RevokeLease(ctx context.Context, leaseID string) error {
	return c.do(ctx, http.MethodPost, "sys/leases/revoke", map[string]string{"lease_id": leaseID}, nil)
}

// ----- internals -----

type reqOpts struct{ noAuth bool }

func withoutAuth() func(*reqOpts) { return func(o *reqOpts) { o.noAuth = true } }

// do issues a request to /v1/<path>, JSON-encoding body (if any) and decoding into out (if
// non-nil). On a 401 it clears the cached token and retries once.
func (c *Client) do(ctx context.Context, method, path string, body, out any, opts ...func(*reqOpts)) error {
	var o reqOpts
	for _, fn := range opts {
		fn(&o)
	}

	resp, err := c.send(ctx, method, path, body, o)
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusUnauthorized && !o.noAuth {
		// Cached token may have been revoked server-side; drop it and retry once.
		_ = resp.Body.Close()
		c.SetToken("")
		resp, err = c.send(ctx, method, path, body, o)
		if err != nil {
			return err
		}
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{Status: resp.StatusCode, Method: method, Path: path, Body: string(raw)}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("arc-server %s %s: decode response: %w", method, path, err)
		}
	}
	return nil
}

func (c *Client) send(ctx context.Context, method, path string, body any, o reqOpts) (*http.Response, error) {
	u := c.baseURL + "/v1/" + strings.TrimLeft(path, "/")
	if _, err := url.Parse(u); err != nil {
		return nil, fmt.Errorf("invalid url %q: %w", u, err)
	}

	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode request body: %w", err)
		}
		rdr = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, u, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if !o.noAuth {
		if tok := c.currentToken(); tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
	}
	return c.httpClient.Do(req)
}
