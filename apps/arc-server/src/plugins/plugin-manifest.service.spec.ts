import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateSigningKeyPair,
  pluginArtifactDigest,
  signPluginManifest,
  toB64u,
} from "@arc/crypto";
import type { PluginManifestClaims, SignedPluginManifest } from "@arc/types";
import { PluginManifestService, parseTrustAnchors } from "./plugin-manifest.service";

async function writeTempArtifact(bytes: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "arc-pm-"));
  const file = path.join(dir, "artifact.wasm");
  await fs.writeFile(file, bytes);
  return file;
}

function freshClaims(sha256: string, over: Partial<PluginManifestClaims> = {}): PluginManifestClaims {
  return {
    v: 1,
    name: "arc-plugin-fake",
    version: "0.1.0",
    kind: "wasm",
    sha256,
    publisher: "publisher:arc-core",
    issuedAt: "2026-06-07T00:00:00.000Z",
    ...over,
  };
}

describe("PluginManifestService", () => {
  const savedEnv = {
    req: process.env.ARC_PLUGIN_MANIFEST,
    anchors: process.env.ARC_PLUGIN_TRUST_ANCHORS,
  };
  afterEach(() => {
    if (savedEnv.req === undefined) delete process.env.ARC_PLUGIN_MANIFEST;
    else process.env.ARC_PLUGIN_MANIFEST = savedEnv.req;
    if (savedEnv.anchors === undefined) delete process.env.ARC_PLUGIN_TRUST_ANCHORS;
    else process.env.ARC_PLUGIN_TRUST_ANCHORS = savedEnv.anchors;
  });

  it("permits a missing manifest in optional mode", async () => {
    delete process.env.ARC_PLUGIN_MANIFEST;
    const s = new PluginManifestService();
    expect(s.required).toBe(false);
    expect((await s.verify(undefined, "/does/not/matter", "wasm")).ok).toBe(true);
  });

  it("rejects a missing manifest in required mode", async () => {
    process.env.ARC_PLUGIN_MANIFEST = "required";
    const s = new PluginManifestService();
    expect(s.required).toBe(true);
    expect((await s.verify(undefined, "/x", "wasm")).reason).toBe("manifest_required");
  });

  it("accepts a valid signed manifest whose hash matches the artifact", async () => {
    const k = generateSigningKeyPair();
    const bytes = Buffer.from("fake-wasm-body");
    const file = await writeTempArtifact(bytes);
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${toB64u(k.pub)}`;
    const s = new PluginManifestService();
    const claims = freshClaims(pluginArtifactDigest(bytes));
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(k.priv, claims) };
    const r = await s.verify(manifest, file, "wasm");
    expect(r).toMatchObject({ ok: true, publisher: "publisher:arc-core", version: "0.1.0" });
  });

  it("rejects an untrusted publisher", async () => {
    const k = generateSigningKeyPair();
    const file = await writeTempArtifact(Buffer.from("x"));
    delete process.env.ARC_PLUGIN_TRUST_ANCHORS; // no anchors configured
    const s = new PluginManifestService();
    const claims = freshClaims(pluginArtifactDigest(Buffer.from("x")));
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(k.priv, claims) };
    expect((await s.verify(manifest, file, "wasm")).reason).toBe("untrusted_publisher");
  });

  it("rejects a hash mismatch (tampered artifact bytes)", async () => {
    const k = generateSigningKeyPair();
    const file = await writeTempArtifact(Buffer.from("real-bytes"));
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${toB64u(k.pub)}`;
    const s = new PluginManifestService();
    // Manifest claims the artifact's hash is something else entirely.
    const claims = freshClaims(pluginArtifactDigest(Buffer.from("different")));
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(k.priv, claims) };
    expect((await s.verify(manifest, file, "wasm")).reason).toBe("artifact_hash_mismatch");
  });

  it("rejects a tampered signature", async () => {
    const k = generateSigningKeyPair();
    const wrong = generateSigningKeyPair();
    const bytes = Buffer.from("legit");
    const file = await writeTempArtifact(bytes);
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${toB64u(k.pub)}`;
    const s = new PluginManifestService();
    const claims = freshClaims(pluginArtifactDigest(bytes));
    // Signed by a different key than the trust anchor.
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(wrong.priv, claims) };
    expect((await s.verify(manifest, file, "wasm")).reason).toBe("invalid_signature");
  });

  it("rejects a kind mismatch (wasm manifest on a process mount)", async () => {
    const k = generateSigningKeyPair();
    const bytes = Buffer.from("x");
    const file = await writeTempArtifact(bytes);
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${toB64u(k.pub)}`;
    const s = new PluginManifestService();
    const claims = freshClaims(pluginArtifactDigest(bytes), { kind: "wasm" });
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(k.priv, claims) };
    expect((await s.verify(manifest, file, "process")).reason).toBe("kind_mismatch");
  });

  it("rejects an unreadable artifact path", async () => {
    const k = generateSigningKeyPair();
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${toB64u(k.pub)}`;
    const s = new PluginManifestService();
    const claims = freshClaims("0".repeat(64));
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(k.priv, claims) };
    expect((await s.verify(manifest, "/this/path/does/not/exist", "wasm")).reason).toBe(
      "artifact_unreadable",
    );
  });

  it("surfaces declared capabilities on a valid manifest (for the runtime gate)", async () => {
    const k = generateSigningKeyPair();
    const bytes = Buffer.from("with-caps");
    const file = await writeTempArtifact(bytes);
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${toB64u(k.pub)}`;
    const s = new PluginManifestService();
    const claims = freshClaims(pluginArtifactDigest(bytes), { capabilities: ["read", "update"] });
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(k.priv, claims) };
    const r = await s.verify(manifest, file, "wasm");
    expect(r.ok).toBe(true);
    expect(r.capabilities).toEqual(["read", "update"]);
  });

  it("rejects a manifest declaring an unknown capability (typo surfaces immediately, not at runtime)", async () => {
    const k = generateSigningKeyPair();
    const bytes = Buffer.from("bad-cap");
    const file = await writeTempArtifact(bytes);
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${toB64u(k.pub)}`;
    const s = new PluginManifestService();
    const claims = freshClaims(pluginArtifactDigest(bytes), {
      // "write" isn't in the arc-grants vocabulary; intent was "update".
      capabilities: ["read", "write"],
    });
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(k.priv, claims) };
    expect((await s.verify(manifest, file, "wasm")).reason).toBe("capability_unknown");
  });

  it("accepts a manifest with no `capabilities` field — gate is bypassed at runtime, matching pre-gate posture", async () => {
    const k = generateSigningKeyPair();
    const bytes = Buffer.from("no-caps");
    const file = await writeTempArtifact(bytes);
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${toB64u(k.pub)}`;
    const s = new PluginManifestService();
    const claims = freshClaims(pluginArtifactDigest(bytes)); // no capabilities key
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(k.priv, claims) };
    const r = await s.verify(manifest, file, "wasm");
    expect(r.ok).toBe(true);
    expect(r.capabilities).toBeUndefined();
  });

  it("accepts `sudo` (it's a legitimate verb, even though it short-circuits the runtime gate)", async () => {
    const k = generateSigningKeyPair();
    const bytes = Buffer.from("sudo");
    const file = await writeTempArtifact(bytes);
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:arc-core=${toB64u(k.pub)}`;
    const s = new PluginManifestService();
    const claims = freshClaims(pluginArtifactDigest(bytes), { capabilities: ["sudo"] });
    const manifest: SignedPluginManifest = { claims, signature: signPluginManifest(k.priv, claims) };
    const r = await s.verify(manifest, file, "wasm");
    expect(r.ok).toBe(true);
    expect(r.capabilities).toEqual(["sudo"]);
  });
});

describe("parseTrustAnchors", () => {
  it("parses comma-separated <publisher>=<b64url> pairs", () => {
    const k = generateSigningKeyPair();
    const m = parseTrustAnchors(`publisher:a=${toB64u(k.pub)}, publisher:b=${toB64u(k.pub)}`);
    expect(m.size).toBe(2);
    expect(m.get("publisher:a")).toBeInstanceOf(Uint8Array);
  });

  it("skips malformed entries (typo doesn't take the rest down)", () => {
    const k = generateSigningKeyPair();
    const m = parseTrustAnchors(`broken-entry, publisher:ok=${toB64u(k.pub)}`);
    expect(m.size).toBe(1);
    expect(m.has("publisher:ok")).toBe(true);
  });

  it("skips entries with non-b64url payloads", () => {
    const m = parseTrustAnchors("publisher:a=not%b64url");
    expect(m.size).toBe(0);
  });
});
