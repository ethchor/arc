/**
 * Thin HTTP client to arc-server. The MCP server forwards each agent's bearer token verbatim,
 * so authentication + authorization + audit happen on arc-server's side (`JwtAuthGuard` +
 * `CapabilityGuard`) — the MCP server never decides who is allowed to do what.
 *
 * Two route families are reachable:
 *  - the engines surface under `/v1/*` (KV v2, Transit, PKI, dynamic creds, sys/*) — the default;
 *  - root-relative arc-server routes (`vault/agents/*`, `vault/approvals/*`) via `{ root: true }`,
 *    because Engine-C's control plane is mounted outside the `/v1` prefix.
 */

export interface ArcHttpError extends Error {
  status: number;
  body: unknown;
}

export interface CallOptions {
  /**
   * Target a root-relative arc-server route instead of the `/v1/*` engines surface.
   * Used by the Engine-C tools, whose controllers are mounted at `vault/agents/…`.
   */
  root?: boolean;
}

export class ArcClient {
  constructor(private readonly baseUrl: string, private readonly fetchFn: typeof fetch = globalThis.fetch) {}

  /** GET the engines surface (`/v1/<path>`), or a root-relative route with `{ root: true }`. */
  get<T = unknown>(
    bearer: string,
    path: string,
    query?: Record<string, string>,
    opts: CallOptions = {},
  ): Promise<T> {
    return this.request<T>(bearer, "GET", path, undefined, query, opts);
  }

  /** POST with a JSON body. */
  post<T = unknown>(bearer: string, path: string, body: unknown, opts: CallOptions = {}): Promise<T> {
    return this.request<T>(bearer, "POST", path, body, undefined, opts);
  }

  /** PUT with a JSON body. */
  put<T = unknown>(bearer: string, path: string, body: unknown, opts: CallOptions = {}): Promise<T> {
    return this.request<T>(bearer, "PUT", path, body, undefined, opts);
  }

  /** DELETE. */
  delete<T = unknown>(bearer: string, path: string, opts: CallOptions = {}): Promise<T> {
    return this.request<T>(bearer, "DELETE", path, undefined, undefined, opts);
  }

  private async request<T>(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    opts: CallOptions = {},
  ): Promise<T> {
    const prefix = opts.root === true ? "" : "/v1";
    const url = new URL(`${prefix}/${path.replace(/^\/+/, "")}`, this.baseUrl);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const res = await this.fetchFn(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const err = new Error(`arc-server ${method} ${path} failed (${res.status})`) as ArcHttpError;
      err.status = res.status;
      err.body = parsed ?? text;
      throw err;
    }
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
