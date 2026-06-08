import { Injectable, Logger } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import {
  fromB64u,
  pluginArtifactDigest,
  verifyPluginManifest,
} from "@arc/crypto";
import type {
  PluginArtifactKind,
  PluginManifestClaims,
  SignedPluginManifest,
} from "@arc/types";

/**
 * Plugin manifest provenance (ADR-005 Phase 5b — extends ADR-004). The plugin host calls
 * {@link verify} before spawning a plugin: a manifest is required when
 * `ARC_PLUGIN_MANIFEST=required`, and even in `optional` mode an attached manifest is
 * fully verified — a *broken* signature or hash mismatch is always a refusal.
 *
 * Trust roots are configured by env: `ARC_PLUGIN_TRUST_ANCHORS` is a comma-separated list
 * of `publisher:<id>=<b64url-Ed25519-pub>` pairs. A manifest is accepted only when its
 * `publisher` resolves to one of these pubs *and* the Ed25519 signature verifies *and* the
 * pinned `sha256` matches the actual artifact bytes.
 *
 * **Capability gate (ADR-005 Phase 5b runtime extension).** A manifest's `capabilities`
 * list — when present — must consist solely of names from the canonical arc-grants verb
 * vocabulary (`create | read | update | delete | list | sudo`); an unknown verb fails
 * verification. The resolved set is then surfaced on {@link ManifestVerifyResult} so the
 * plugin host can stamp it onto the mount; the engine dispatcher refuses every request
 * for an undeclared capability at runtime. This is what turns the manifest from "who
 * built it + what it is" into "what it's *allowed* to do" — sandbox / sigstore-level
 * intent is still ADR-004's job.
 */
export interface ManifestVerifyResult {
  ok: boolean;
  /** Resolved publisher subject + version + capabilities, when `ok`. */
  publisher?: string;
  version?: string;
  capabilities?: readonly string[];
  /** Machine-readable rejection reason when `!ok`. Never leaks which pubs are configured. */
  reason?:
    | "manifest_required"
    | "untrusted_publisher"
    | "invalid_signature"
    | "kind_mismatch"
    | "artifact_hash_mismatch"
    | "manifest_unsupported_version"
    | "artifact_unreadable"
    | "capability_unknown";
}

/**
 * Canonical capability vocabulary, mirroring `@arc/grants`'s `Capability` and Vault's verb
 * set. A manifest that declares anything outside this set is rejected at verify-time so
 * operator typos surface immediately rather than turning into permissive-by-accident gates.
 */
export const KNOWN_PLUGIN_CAPABILITIES: ReadonlySet<string> = new Set([
  "create",
  "read",
  "update",
  "delete",
  "list",
  "sudo",
]);

@Injectable()
export class PluginManifestService {
  private readonly logger = new Logger(PluginManifestService.name);
  private readonly anchors: ReadonlyMap<string, Uint8Array>;
  readonly required: boolean;

  constructor() {
    this.required = (process.env.ARC_PLUGIN_MANIFEST ?? "optional").toLowerCase() === "required";
    this.anchors = parseTrustAnchors(process.env.ARC_PLUGIN_TRUST_ANCHORS ?? "");
    this.logger.log(
      `PluginManifestService (required=${this.required}, trust anchors=${this.anchors.size})`,
    );
  }

  /**
   * Verify `manifest` against the artifact at `artifactPath`. When `manifest` is `undefined`,
   * permitted iff `required=false` (returns `{ ok: true }` with no publisher binding). Any
   * present manifest is verified strictly — a broken signature or hash mismatch is always a
   * refusal regardless of the required-mode setting.
   */
  async verify(
    manifest: SignedPluginManifest | undefined,
    artifactPath: string,
    expectedKind: PluginArtifactKind,
  ): Promise<ManifestVerifyResult> {
    if (!manifest) {
      return this.required ? reject("manifest_required") : { ok: true };
    }
    const claims = manifest.claims as PluginManifestClaims;
    if (claims.v !== 1) return reject("manifest_unsupported_version");
    if (claims.kind !== expectedKind) return reject("kind_mismatch");

    const pub = this.anchors.get(claims.publisher);
    if (!pub) return reject("untrusted_publisher");

    if (!verifyPluginManifest(pub, claims, manifest.signature as Parameters<typeof verifyPluginManifest>[2])) {
      return reject("invalid_signature");
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(artifactPath);
    } catch (err) {
      this.logger.warn(`artifact ${artifactPath} unreadable: ${(err as Error).message}`);
      return reject("artifact_unreadable");
    }
    const actual = pluginArtifactDigest(bytes);
    if (actual.toLowerCase() !== claims.sha256.toLowerCase()) {
      return reject("artifact_hash_mismatch");
    }

    if (claims.capabilities !== undefined) {
      for (const cap of claims.capabilities) {
        if (!KNOWN_PLUGIN_CAPABILITIES.has(cap)) return reject("capability_unknown");
      }
    }

    const out: ManifestVerifyResult = {
      ok: true,
      publisher: claims.publisher,
      version: claims.version,
    };
    if (claims.capabilities !== undefined) out.capabilities = claims.capabilities;
    return out;
  }
}

function reject(reason: NonNullable<ManifestVerifyResult["reason"]>): ManifestVerifyResult {
  return { ok: false, reason };
}

/**
 * Parse `ARC_PLUGIN_TRUST_ANCHORS` — `publisher:<id>=<b64url>,publisher:<id>=<b64url>,…`.
 * Malformed entries are skipped with a warning rather than failing boot, so a typo in one
 * anchor doesn't take Engine-A down; the rest still resolve.
 */
export function parseTrustAnchors(raw: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const log = new Logger("PluginManifestService");
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      log.warn(`ignored malformed trust anchor "${entry}" (expected "<publisher>=<b64url-pub>")`);
      continue;
    }
    const publisher = entry.slice(0, eq).trim();
    const encoded = entry.slice(eq + 1).trim();
    try {
      out.set(publisher, fromB64u(encoded));
    } catch {
      log.warn(`ignored trust anchor "${publisher}" — public key not valid b64url`);
    }
  }
  return out;
}
