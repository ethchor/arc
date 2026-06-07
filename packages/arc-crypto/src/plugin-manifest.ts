/**
 * Plugin manifest signing helpers (ADR-005 Phase 5b). Thin wrappers over
 * `signObject` / `verifyObject` (Ed25519 over `SHA-256(JCS(object))`) — no new algorithm.
 * Pinned in `@arc/crypto` so a Rust verifier reproduces the byte layout (docs/04).
 */
import type { PluginManifestClaims } from "@arc/types";
import { sha256 } from "./primitives";
import { signObject, verifyObject } from "./sign";
import { toHex } from "./bytes";
import type { SignatureEnvelope } from "./envelope";
import type { JsonValue } from "./types";

/** Sign a manifest with the publisher's identity Ed25519 key. */
export function signPluginManifest(
  publisherSigningPriv: Uint8Array,
  claims: PluginManifestClaims,
  kid?: string,
): SignatureEnvelope {
  return signObject(publisherSigningPriv, claims as unknown as JsonValue, kid);
}

/** Verify a manifest against the publisher's published Ed25519 verifying key. */
export function verifyPluginManifest(
  publisherSigningPub: Uint8Array,
  claims: PluginManifestClaims,
  sig: SignatureEnvelope,
): boolean {
  return verifyObject(publisherSigningPub, claims as unknown as JsonValue, sig);
}

/** Lowercase hex SHA-256 of opaque artifact bytes — the value pinned in `claims.sha256`. */
export function pluginArtifactDigest(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}
