/**
 * Pure functions behind the `arc-plugin-sign` CLI — kept separate so they're unit-testable
 * without spawning the bin and so they're importable from CI scripts that don't want to
 * shell out. Every function is side-effect-free; file I/O happens only in `bin.ts`.
 *
 * No new crypto: the underlying primitives are `signPluginManifest` /
 * `verifyPluginManifest` from `@arc/crypto`, both of which are Ed25519 over
 * SHA-256(JCS(claims)). The CLI's job is purely surface-level — bytes ↔ JSON, base64-url
 * key encoding, capability validation, structured errors.
 */
import { readFile } from "node:fs/promises";
import {
  fromB64u,
  generateSigningKeyPair,
  pluginArtifactDigest,
  signPluginManifest,
  toB64u,
  verifyPluginManifest,
} from "@arc/crypto";
import type {
  PluginArtifactKind,
  PluginManifestClaims,
  SignedPluginManifest,
} from "@arc/types";

/**
 * Canonical plugin-capability vocabulary, mirrored from arc-server's
 * `PluginManifestService` (which is itself sourced from `@arc/grants`). Duplicated here so
 * the signing CLI can refuse a typo before it ever reaches the server's verifier.
 */
export const KNOWN_PLUGIN_CAPABILITIES: ReadonlySet<string> = new Set([
  "create",
  "read",
  "update",
  "delete",
  "list",
  "sudo",
]);

export interface GeneratedKey {
  /** Ed25519 private (seed | pub) — keep secret; ships to CI as a stored secret. */
  privB64u: string;
  /** Ed25519 public — published, pinned in `ARC_PLUGIN_TRUST_ANCHORS` on the server. */
  pubB64u: string;
}

/**
 * Generate a fresh Ed25519 keypair and return both halves base64url-encoded. Operators run
 * this once per publisher — keep `privB64u` in CI secrets, publish `pubB64u` so server
 * operators can pin it as `publisher:<id>=<pub>` in `ARC_PLUGIN_TRUST_ANCHORS`.
 */
export function generatePublisherKey(): GeneratedKey {
  const { priv, pub } = generateSigningKeyPair();
  return { privB64u: toB64u(priv), pubB64u: toB64u(pub) };
}

export interface SignArtifactInput {
  /** Path to the artifact bytes that arc-server will execute (or hash, for `wasm`). */
  artifactPath: string;
  /** Ed25519 private key — base64url-encoded (`generatePublisherKey().privB64u`). */
  publisherPrivB64u: string;
  /**
   * Publisher subject (e.g. `publisher:arc-core`, or a SPIFFE id). Must match the operator's
   * `ARC_PLUGIN_TRUST_ANCHORS` allowlist entry on the server, otherwise the server refuses
   * the mount with `untrusted_publisher`.
   */
  publisher: string;
  /** Plugin's wire name, e.g. `arc-plugin-aws`. Audit/UI label, not a trust input. */
  name: string;
  /** Plugin's version string (semver-ish). */
  version: string;
  /** Which artifact kind the digest binds — `"wasm"` for the wasmtime path, `"process"` for OOP. */
  kind: PluginArtifactKind;
  /**
   * Capabilities the plugin declares it needs. Validated against
   * {@link KNOWN_PLUGIN_CAPABILITIES} before signing — an unknown verb refuses to sign so
   * operator typos surface here, not in production logs.
   */
  capabilities?: readonly string[];
  /** Override `issuedAt`; defaults to `new Date().toISOString()`. Mostly for deterministic tests. */
  issuedAt?: string;
}

/**
 * Build + sign a `SignedPluginManifest`. Reads the artifact bytes, computes the SHA-256,
 * validates the capability set, packages the claims, and Ed25519-signs the JCS form. The
 * returned manifest is server-ready: `JSON.stringify(result)` is the file the host expects.
 */
export async function signArtifact(input: SignArtifactInput): Promise<SignedPluginManifest> {
  if (input.capabilities) {
    for (const cap of input.capabilities) {
      if (!KNOWN_PLUGIN_CAPABILITIES.has(cap)) {
        throw new Error(
          `unknown capability "${cap}" — must be one of ${[...KNOWN_PLUGIN_CAPABILITIES].sort().join(", ")}`,
        );
      }
    }
  }
  const bytes = await readFile(input.artifactPath);
  const sha256 = pluginArtifactDigest(bytes);
  const priv = decodeB64uKey(input.publisherPrivB64u, "private");

  const claims: PluginManifestClaims = {
    v: 1,
    name: input.name,
    version: input.version,
    kind: input.kind,
    sha256,
    publisher: input.publisher,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    ...(input.capabilities !== undefined ? { capabilities: [...input.capabilities] } : {}),
  };

  const signature = signPluginManifest(priv, claims);
  return { claims, signature };
}

export interface VerifyArtifactInput {
  /** The signed manifest. */
  manifest: SignedPluginManifest;
  /** Path to the artifact bytes — re-hashed and compared to `manifest.claims.sha256`. */
  artifactPath: string;
  /** Publisher's published Ed25519 verifying key (base64url). */
  publisherPubB64u: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?:
    | "manifest_unsupported_version"
    | "publisher_mismatch"
    | "invalid_signature"
    | "artifact_hash_mismatch"
    | "capability_unknown";
}

/**
 * Verify a signed manifest against the publisher's pub key + the artifact bytes. Mirrors
 * arc-server's `PluginManifestService.verify` semantics so an operator can run this exact
 * check locally before staging a release — and a CI publish job can fail-fast on the same
 * conditions.
 */
export async function verifyArtifact(input: VerifyArtifactInput): Promise<VerifyResult> {
  const { manifest, artifactPath, publisherPubB64u } = input;
  if (manifest.claims.v !== 1) return { ok: false, reason: "manifest_unsupported_version" };

  if (manifest.claims.capabilities) {
    for (const cap of manifest.claims.capabilities) {
      if (!KNOWN_PLUGIN_CAPABILITIES.has(cap)) return { ok: false, reason: "capability_unknown" };
    }
  }

  const pub = decodeB64uKey(publisherPubB64u, "public");
  if (!verifyPluginManifest(pub, manifest.claims, manifest.signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const bytes = await readFile(artifactPath);
  const actual = pluginArtifactDigest(bytes);
  if (actual.toLowerCase() !== manifest.claims.sha256.toLowerCase()) {
    return { ok: false, reason: "artifact_hash_mismatch" };
  }

  return { ok: true };
}

function decodeB64uKey(s: string, label: "private" | "public"): Uint8Array {
  try {
    const bytes = fromB64u(s);
    if (bytes.length !== 32) {
      throw new Error(`${label} key must decode to exactly 32 bytes (got ${bytes.length})`);
    }
    return bytes;
  } catch (err) {
    throw new Error(`${label} key is not valid base64url: ${(err as Error).message}`);
  }
}
