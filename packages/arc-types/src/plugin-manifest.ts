/**
 * Plugin manifest provenance (ADR-005 Phase 5b — extends ADR-004). A plugin's binary —
 * `.wasm` for the wasmtime backend, an executable for the OOP backend — is mounted only if
 * a signed manifest pins its SHA-256 *and* names a publisher we trust. Closes the "anyone
 * can mount any artifact off disk" gap: a tampered binary, or a binary from an unknown
 * signer, refuses to spawn. No new crypto — `signObject` / `verifyObject` over JCS.
 *
 * `kind` selects which artifact the digest binds: the WASM module itself, or the OOP
 * plugin's executable. Same envelope shape for both keeps verification uniform.
 */
import type { SignatureEnvelope } from "./envelope";

export type PluginArtifactKind = "wasm" | "process";

/** The signable manifest body — flat JSON so JCS canonicalisation is unambiguous. */
export interface PluginManifestClaims {
  v: 1;
  /** Plugin's wire name, e.g. `arc-plugin-aws`. Audit/UI label, *not* a trust input. */
  name: string;
  /** Manifest schema's idea of the plugin's version (semver-ish). */
  version: string;
  kind: PluginArtifactKind;
  /** Lowercase hex SHA-256 of the artifact bytes. The binding to "what actually runs". */
  sha256: string;
  /** Publisher subject (e.g. `publisher:arc-core` / a SPIFFE id) — verifier maps to a pub. */
  publisher: string;
  /** Capabilities the plugin declares it needs (advisory in v1; gated in a follow-up). */
  capabilities?: readonly string[];
  /** ISO timestamp the manifest was minted at. Stamps the bytes; verifier ignores skew. */
  issuedAt: string;
}

/** Signed manifest — the on-the-wire artifact: claims + the publisher's Ed25519 signature. */
export interface SignedPluginManifest {
  claims: PluginManifestClaims;
  signature: SignatureEnvelope;
}
