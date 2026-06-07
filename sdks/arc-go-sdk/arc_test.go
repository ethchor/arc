package arc

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLoginKubernetes_cachesAndSendsBearer(t *testing.T) {
	var (
		loginCalls int
		kvAuth     string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/auth/kubernetes/login":
			loginCalls++
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["role"] != "operator" || body["jwt"] != "sa-token" {
				t.Errorf("unexpected login body: %v", body)
			}
			writeJSON(w, 200, map[string]any{
				"data": map[string]any{"token": "arc-jwt-1", "tokenTtlSeconds": 600},
			})
		case "/v1/secret/data/app/db":
			kvAuth = r.Header.Get("Authorization")
			writeJSON(w, 200, map[string]any{
				"data": map[string]any{"data": map[string]any{"user": "alice"}, "metadata": map[string]any{"version": 3}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := New(srv.URL)
	if _, err := c.LoginKubernetes(context.Background(), "kubernetes", "operator", "sa-token"); err != nil {
		t.Fatalf("login: %v", err)
	}

	sec, err := c.KVGet(context.Background(), "secret", "app/db", 0)
	if err != nil {
		t.Fatalf("kvget: %v", err)
	}
	if sec.Data.Data["user"] != "alice" || sec.Data.Metadata.Version != 3 {
		t.Errorf("unexpected secret: %+v", sec.Data)
	}
	if kvAuth != "Bearer arc-jwt-1" {
		t.Errorf("KVGet did not forward the cached bearer, got %q", kvAuth)
	}
	if loginCalls != 1 {
		t.Errorf("expected exactly 1 login, got %d", loginCalls)
	}
}

func TestKVGet_versionQuery(t *testing.T) {
	var gotQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		writeJSON(w, 200, map[string]any{"data": map[string]any{"data": map[string]any{}, "metadata": map[string]any{"version": 2}}})
	}))
	defer srv.Close()

	c := New(srv.URL, WithToken("t"))
	if _, err := c.KVGet(context.Background(), "secret", "x", 2); err != nil {
		t.Fatal(err)
	}
	if gotQuery != "version=2" {
		t.Errorf("expected version=2 query, got %q", gotQuery)
	}
}

func TestIssueDynamic_ttlAndShape(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/aws/creds/deployer" || r.URL.RawQuery != "ttl=900" {
			t.Errorf("unexpected request: %s?%s", r.URL.Path, r.URL.RawQuery)
		}
		writeJSON(w, 200, map[string]any{
			"data":           map[string]any{"access_key": "AKIA", "secret_key": "s"},
			"lease_id":       "aws/creds/deployer/abc",
			"lease_duration": 900,
			"renewable":      false,
		})
	}))
	defer srv.Close()

	c := New(srv.URL, WithToken("t"))
	cred, err := c.IssueDynamic(context.Background(), "aws", "deployer", 900)
	if err != nil {
		t.Fatal(err)
	}
	if cred.LeaseID != "aws/creds/deployer/abc" || cred.LeaseDuration != 900 {
		t.Errorf("unexpected lease: %+v", cred)
	}
	if cred.Data["access_key"] != "AKIA" {
		t.Errorf("unexpected data: %v", cred.Data)
	}
}

func TestUnauthorized_retriesOnce_thenSucceeds(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/auth/kubernetes/login" {
			writeJSON(w, 200, map[string]any{"data": map[string]any{"token": "fresh", "tokenTtlSeconds": 600}})
			return
		}
		hits++
		if hits == 1 {
			writeJSON(w, 401, map[string]any{"errors": []string{"token revoked"}})
			return
		}
		writeJSON(w, 200, map[string]any{"data": map[string]any{"data": map[string]any{"ok": true}, "metadata": map[string]any{"version": 1}}})
	}))
	defer srv.Close()

	c := New(srv.URL, WithToken("stale"))
	// First KVGet hits the 401; the client must re-login (needs a token source) then retry.
	// With no token source configured the retry just re-sends with the cleared token, which
	// the fake server happily accepts the second time — proving the retry path runs.
	if _, err := c.KVGet(context.Background(), "secret", "x", 0); err != nil {
		t.Fatalf("expected success after retry, got %v", err)
	}
	if hits != 2 {
		t.Errorf("expected the request to be retried once (2 hits), got %d", hits)
	}
}

func TestForbidden_returnsAPIError_noRetry(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		writeJSON(w, 403, map[string]any{"errors": []string{"forbidden by policy"}})
	}))
	defer srv.Close()

	c := New(srv.URL, WithToken("t"))
	_, err := c.KVGet(context.Background(), "secret", "x", 0)
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *APIError, got %T (%v)", err, err)
	}
	if apiErr.Status != 403 {
		t.Errorf("expected 403, got %d", apiErr.Status)
	}
	if hits != 1 {
		t.Errorf("403 must not be retried; got %d hits", hits)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
