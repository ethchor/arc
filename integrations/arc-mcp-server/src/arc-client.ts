/**
 * Thin HTTP client to arc-server. The MCP server forwards each agent's bearer token verbatim,
 * so authentication + authorization + audit happen on arc-server's side (`JwtAuthGuard` +
 * `CapabilityGuard`) — the MCP server never decides who is allowed to do what.
 *
 * Every call is a one-shot fetch against `/v1/*`; arc-server's existing engines surface
 * (KV v2, Transit, PKI, dynamic creds, sys/*) is the source of truth.
 */

export interface ArcHttpError extends Error {
  status: number;
  body: unknown;
}

export class ArcClient {
  constructor(private readonly baseUrl: string, private readonly fetchFn: typeof fetch = globalThis.fetch) {}

  /** GET /v1/<path>. */
  get<T = unknown>(bearer: string, path: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>(bearer, "GET", path, undefined, query);
  }

  /** POST /v1/<path> with a JSON body. */
  post<T = unknown>(bearer: string, path: string, body: unknown): Promise<T> {
    return this.request<T>(bearer, "POST", path, body);
  }

  /** PUT /v1/<path> with a JSON body. */
  put<T = unknown>(bearer: string, path: string, body: unknown): Promise<T> {
    return this.request<T>(bearer, "PUT", path, body);
  }

  /** DELETE /v1/<path>. */
  delete<T = unknown>(bearer: string, path: string): Promise<T> {
    return this.request<T>(bearer, "DELETE", path);
  }

  private async request<T>(
    bearer: string,
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`/v1/${path.replace(/^\/+/, "")}`, this.baseUrl);
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
