/**
 * Minimal HTTP client for a colocated OpenBao server. OpenBao (MPL 2.0) is API-compatible with
 * Vault, so it accepts the historical `X-Vault-Token` / `X-Vault-Namespace` headers. This file
 * speaks only the documented HTTP API — it contains no HashiCorp Vault (BSL) source.
 */

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponseLike>;

export interface OpenBaoClientOptions {
  /** Base address, e.g. "http://127.0.0.1:8200" (BAO_ADDR). */
  addr: string;
  /** Token (BAO_TOKEN). */
  token?: string;
  /** Optional namespace (OpenBao namespaces are free; Vault gates them behind Enterprise). */
  namespace?: string;
  /** Injectable fetch implementation (defaults to the global fetch). */
  fetchFn?: FetchLike;
}

export interface SealStatus {
  type: string;
  initialized: boolean;
  sealed: boolean;
  version: string;
  [key: string]: unknown;
}

/** A logical OpenBao response. Dynamic-secret endpoints populate the lease_* fields. */
export interface OpenBaoResponse {
  data?: Record<string, unknown>;
  lease_id?: string;
  lease_duration?: number;
  renewable?: boolean;
  [key: string]: unknown;
}

export class OpenBaoError extends Error {
  readonly status: number;
  readonly errors: string[];
  constructor(status: number, errors: string[]) {
    super(`OpenBao request failed (${status}): ${errors.join("; ") || "unknown error"}`);
    this.name = "OpenBaoError";
    this.status = status;
    this.errors = errors;
  }
}

/**
 * Thrown when a request path contains a traversal artifact (`.` / `..` / empty segment /
 * `%2e%2e` / mal-encoded percent). Last-line defense in depth: arc-server already rejects
 * traversal in `CapabilityGuard` and `EnginesController`, but a future call into this
 * adapter from elsewhere (a sidecar, a CLI, a leasing-driven revoke) must not silently
 * relay a path that `fetch` would collapse to a different mount on the upstream OpenBao.
 */
export class OpenBaoPathError extends Error {
  constructor(public readonly reason: string, public readonly segment?: string) {
    super(`OpenBao path rejected: ${reason}${segment !== undefined ? ` (segment="${segment}")` : ""}`);
    this.name = "OpenBaoPathError";
  }
}

/**
 * True iff `rawSeg` is a path-traversal artifact: empty, equals `.` / `..` after percent-
 * decoding, or contains malformed percent-encoding. Mirrors arc-server's canonicalizer.
 */
function isUnsafeSegment(rawSeg: string): boolean {
  if (rawSeg.length === 0) return true;
  if (rawSeg === "." || rawSeg === "..") return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSeg);
  } catch {
    return true;
  }
  return decoded === "." || decoded === "..";
}

/**
 * Validate that an OpenBao request path has no traversal segments. Returns the path
 * unchanged on success (so the caller still picks its own slash handling); throws
 * {@link OpenBaoPathError} on rejection.
 */
function assertSafePath(path: string): void {
  const stripped = path.replace(/^\/+/, "");
  if (stripped.length === 0) throw new OpenBaoPathError("empty_path");
  // Trailing slash is fine for KV v2 metadata, just don't let it cause an empty segment.
  const trimmed = stripped.endsWith("/") ? stripped.slice(0, -1) : stripped;
  if (trimmed.length === 0) throw new OpenBaoPathError("empty_path");
  for (const seg of trimmed.split("/")) {
    if (isUnsafeSegment(seg)) {
      throw new OpenBaoPathError(
        seg.length === 0 ? "empty_segment" : "dot_segment",
        seg,
      );
    }
  }
}

const TOKEN_HEADER = "X-Vault-Token";
const NAMESPACE_HEADER = "X-Vault-Namespace";

export class OpenBaoClient {
  private readonly addr: string;
  private readonly token?: string;
  private readonly namespace?: string;
  private readonly fetchFn: FetchLike;

  constructor(options: OpenBaoClientOptions) {
    this.addr = options.addr.replace(/\/+$/, "");
    this.token = options.token;
    this.namespace = options.namespace;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** `GET /v1/sys/seal-status` — the `bao status` round-trip. */
  async sealStatus(): Promise<SealStatus> {
    return (await this.request("GET", "sys/seal-status")) as unknown as SealStatus;
  }

  /** `GET /v1/sys/health` (raw status object). */
  async health(): Promise<Record<string, unknown>> {
    return (await this.request("GET", "sys/health")) as Record<string, unknown>;
  }

  read(path: string): Promise<OpenBaoResponse> {
    return this.request("GET", path);
  }

  write(path: string, body: Record<string, unknown>): Promise<OpenBaoResponse> {
    return this.request("POST", path, body);
  }

  list(path: string): Promise<OpenBaoResponse> {
    return this.request("LIST", path);
  }

  async delete(path: string): Promise<void> {
    await this.request("DELETE", path);
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<OpenBaoResponse> {
    assertSafePath(path);
    const url = `${this.addr}/v1/${path.replace(/^\/+/, "")}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers[TOKEN_HEADER] = this.token;
    if (this.namespace) headers[NAMESPACE_HEADER] = this.namespace;
    const res = await this.fetchFn(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    const parsed: Record<string, unknown> =
      raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!res.ok) {
      const errors = Array.isArray(parsed.errors) ? (parsed.errors as string[]) : [];
      throw new OpenBaoError(res.status, errors);
    }
    return parsed as OpenBaoResponse;
  }
}
