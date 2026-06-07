/**
 * arc-server HTTP client for the operator. Handles two things the MCP adapter doesn't:
 *
 *  1. **Login via the Kubernetes auth method.** The operator runs with a ServiceAccount
 *     projected token (`/var/run/secrets/kubernetes.io/serviceaccount/token`); on startup,
 *     and again whenever the cached arc JWT expires, we POST that to
 *     `/v1/auth/kubernetes/login`. The arc JWT is what gates every subsequent request via
 *     `@arc/grants`.
 *  2. **Refresh-ahead.** A small clock-skew (60s) is subtracted from the JWT's expiry so we
 *     never use a token that's about to expire mid-request.
 */
import { readFile } from "node:fs/promises";

export interface KvSecretResponse {
  data: {
    data: Record<string, unknown>;
    metadata: { version: number; created_time?: string };
  };
}

export interface DynamicCredsResponse {
  data: Record<string, unknown>;
  lease_id: string;
  lease_duration: number;
  renewable: boolean;
}

export interface LoginResponse {
  data: {
    token: string;
    identityId: string;
    policies: string[];
    tokenTtlSeconds: number;
  };
}

export interface ArcClientOptions {
  /** Base URL of arc-server, e.g. https://arc.svc.cluster.local:3001. */
  baseUrl: string;
  /** Auth mount the operator should log into, e.g. "kubernetes". */
  authMount: string;
  /** Role configured on that mount; binds to the operator's policies. */
  authRole: string;
  /** Optional fetch override for tests. */
  fetchFn?: typeof fetch;
  /** Optional override of where to read the SA token (tests pass this). */
  tokenSource?: () => Promise<string>;
  /** Optional clock for tests. */
  now?: () => number;
  /** Refresh the arc JWT this many seconds before expiry. */
  refreshLeadSeconds?: number;
}

export class ArcClient {
  private readonly fetchFn: typeof fetch;
  private readonly tokenSource: () => Promise<string>;
  private readonly now: () => number;
  private readonly refreshLeadMs: number;
  private cachedJwt?: { token: string; expiresAtMs: number };

  constructor(private readonly opts: ArcClientOptions) {
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch);
    this.tokenSource = opts.tokenSource ?? defaultSaTokenSource;
    this.now = opts.now ?? Date.now;
    this.refreshLeadMs = (opts.refreshLeadSeconds ?? 60) * 1000;
  }

  /** Force-clear the cached arc JWT (e.g. on a 401 from a downstream call). */
  forgetToken(): void {
    this.cachedJwt = undefined;
  }

  /** Read a KV v2 secret. Caller's role on arc-server gates the `read` capability. */
  async kvGet(mount: string, path: string, version?: number): Promise<KvSecretResponse> {
    const query = version !== undefined ? `?version=${version}` : "";
    return this.authedJson<KvSecretResponse>("GET", `${mount}/data/${path}${query}`);
  }

  /** Issue dynamic credentials. */
  async issueDynamic(mount: string, role: string, ttlSeconds?: number): Promise<DynamicCredsResponse> {
    const query = ttlSeconds !== undefined ? `?ttl=${ttlSeconds}` : "";
    return this.authedJson<DynamicCredsResponse>("GET", `${mount}/creds/${role}${query}`);
  }

  /** Revoke a lease — best-effort; failures are swallowed by the caller. */
  async revokeLease(leaseId: string): Promise<void> {
    await this.authedJson<unknown>("POST", `sys/leases/revoke`, { lease_id: leaseId });
  }

  /** Force an immediate login. Exposed for tests + cold-start sanity checks. */
  async login(): Promise<string> {
    const saToken = await this.tokenSource();
    const res = await this.fetchFn(
      new URL(`/v1/auth/${this.opts.authMount}/login`, this.opts.baseUrl).toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ role: this.opts.authRole, jwt: saToken }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`arc login failed (${res.status}): ${text}`);
    }
    const parsed = (await res.json()) as LoginResponse;
    const ttlMs = parsed.data.tokenTtlSeconds * 1000;
    this.cachedJwt = { token: parsed.data.token, expiresAtMs: this.now() + ttlMs };
    return parsed.data.token;
  }

  /** Return a non-expired arc JWT, logging in if necessary. */
  private async getJwt(): Promise<string> {
    if (this.cachedJwt && this.cachedJwt.expiresAtMs - this.refreshLeadMs > this.now()) {
      return this.cachedJwt.token;
    }
    return this.login();
  }

  private async authedJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const jwt = await this.getJwt();
    const url = new URL(`/v1/${path.replace(/^\/+/, "")}`, this.opts.baseUrl).toString();
    const res = await this.fetchFn(url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // One retry on 401 (the cached token may have been invalidated server-side, e.g. policy
    // detach + the cache is stale). Drop the cached token and try again.
    if (res.status === 401) {
      this.forgetToken();
      const fresh = await this.getJwt();
      const retry = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${fresh}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return parseOrThrow<T>(retry, method, path);
    }
    return parseOrThrow<T>(res, method, path);
  }
}

async function parseOrThrow<T>(res: Response, method: string, path: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`arc-server ${method} ${path} failed (${res.status}): ${text}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
async function defaultSaTokenSource(): Promise<string> {
  return (await readFile(SA_TOKEN_PATH, "utf8")).trim();
}
