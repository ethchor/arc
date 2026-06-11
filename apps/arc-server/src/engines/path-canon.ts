import { BadRequestException } from "@nestjs/common";

/**
 * Bad-request thrown by {@link canonicalizeEnginePath} when a request path contains
 * a traversal marker (`.` / `..` / empty / `%2e%2e` / malformed encoding). Stable
 * `error: "invalid_engine_path"` code so SDKs / operators can detect rejection
 * deterministically without scraping prose error strings.
 */
export class EnginePathError extends BadRequestException {
  constructor(public readonly reason: string, public readonly segment?: string) {
    super({ error: "invalid_engine_path", reason, ...(segment !== undefined ? { segment } : {}) });
  }
}

/**
 * Canonicalize an Engine-A request path: strip the `/v1/` prefix, strip any query string,
 * normalize leading slashes, validate that **no segment is `.` / `..` / empty / mal-encoded**,
 * and return the joined form ready for ACL match + OpenBao dispatch.
 *
 * This is the single source of truth used by {@link CapabilityGuard} (to pick the policy
 * prefix to match) and by `EnginesController` (to assemble the OpenBao URL). If the two
 * layers had different ideas about what "the path" was, a caller authorized for `secret/`
 * could reach `sys/` by sending `/v1/secret/data/../../sys/seal-status` — the ACL match
 * runs on the raw text (`startsWith("secret/")` → allow), `fetch` collapses the `..` before
 * sending, and the OpenBao bearer is `root` under the helm dev-mode default. That is the
 * HIGH-A finding from the untrusted-code audit.
 *
 * Defense in depth: the OpenBao adapter (`integrations/arc-openbao-adapter`) ALSO refuses
 * `..` segments. Either layer's rejection produces the same `invalid_engine_path` shape.
 */
export function canonicalizeEnginePath(rawUrlOrPath: string): string {
  const noQuery = rawUrlOrPath.split("?", 1)[0]!;
  // Match `/v1`, `/v1/`, `///v1/` (any number of leading slashes) — but require either a
  // trailing slash or end-of-string so a hypothetical mount named `v1something/` isn't
  // accidentally swallowed.
  const m = noQuery.match(/^\/*v1(\/|$)(.*)$/);
  if (!m) throw new EnginePathError("not_an_engine_path");
  const inner = (m[2] ?? "").replace(/^\/+/, "");
  if (inner.length === 0) throw new EnginePathError("empty_path");

  // Preserve a trailing slash flag: KV v2 metadata reads use a trailing `/`, and the
  // OpenBao engine paths sometimes care. We split + validate, then re-attach.
  const hasTrailingSlash = inner.endsWith("/");
  const trimmed = hasTrailingSlash ? inner.slice(0, -1) : inner;
  if (trimmed.length === 0) throw new EnginePathError("empty_path");

  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (isUnsafeSegment(seg)) {
      throw new EnginePathError(
        seg.length === 0 ? "empty_segment" : "dot_segment",
        seg,
      );
    }
  }
  return hasTrailingSlash ? `${trimmed}/` : trimmed;
}

/**
 * True iff `rawSeg` is empty, equals `.` / `..` after percent-decoding, or contains
 * malformed percent-encoding. Bare-string check + decoded-string check covers
 * `%2e%2e`, `%2E%2E`, `.%2e`, `%2e.`, and any other encoded permutation; a malformed
 * `%ZZ` throws `URIError` from `decodeURIComponent`, which we treat as invalid input.
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
 * Validate a path that was already split into segments by Express's `*splat` capture.
 * Mirrors {@link canonicalizeEnginePath} but skips the `/v1/`/query stripping (the
 * controller already received segments). The same rejection rules apply; the same
 * `EnginePathError` shape is thrown.
 */
export function joinSplatStrict(splat: string[] | string): string {
  const segments = Array.isArray(splat)
    ? [...splat]
    : splat.replace(/^\/+/, "").split("/");
  if (segments.length === 0) throw new EnginePathError("empty_path");
  for (const seg of segments) {
    if (isUnsafeSegment(seg)) {
      throw new EnginePathError(
        seg.length === 0 ? "empty_segment" : "dot_segment",
        seg,
      );
    }
  }
  return segments.join("/");
}
