/**
 * Unit spec for `arc-plugin-sign`'s pure library. Confirms the surface every CI script will
 * use directly: keygen → sign → verify round-trip; key/cap/hash refusals match the same
 * reasons arc-server's `PluginManifestService` surfaces, so a local failure tells the
 * operator exactly what would have failed in production.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KNOWN_PLUGIN_CAPABILITIES,
  generatePublisherKey,
  signArtifact,
  verifyArtifact,
} from "../src/lib";

function writeTempArtifact(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "arc-pms-"));
  const file = join(dir, "artifact.bin");
  writeFileSync(file, bytes);
  return file;
}

describe("generatePublisherKey", () => {
  it("returns matching b64url priv + pub of the expected length (32 bytes each)", () => {
    const k = generatePublisherKey();
    expect(typeof k.privB64u).toBe("string");
    expect(typeof k.pubB64u).toBe("string");
    // Ed25519 keys are 32 bytes; b64url-encoded is ~43 chars (no padding).
    expect(k.privB64u.length).toBeGreaterThanOrEqual(42);
    expect(k.pubB64u.length).toBeGreaterThanOrEqual(42);
    expect(k.privB64u).not.toEqual(k.pubB64u);
  });

  it("generates fresh keys on each call (no global state)", () => {
    const a = generatePublisherKey();
    const b = generatePublisherKey();
    expect(a.privB64u).not.toEqual(b.privB64u);
    expect(a.pubB64u).not.toEqual(b.pubB64u);
  });
});

describe("signArtifact + verifyArtifact round-trip", () => {
  it("signs an artifact and the resulting manifest verifies with the pub key", async () => {
    const k = generatePublisherKey();
    const file = writeTempArtifact(Buffer.from("real-bytes"));
    const m = await signArtifact({
      artifactPath: file,
      publisherPrivB64u: k.privB64u,
      publisher: "publisher:arc-core",
      name: "arc-plugin-fake",
      version: "0.1.0",
      kind: "process",
      capabilities: ["read", "update"],
      issuedAt: "2026-06-07T00:00:00.000Z",
    });
    expect(m.claims).toMatchObject({
      v: 1,
      name: "arc-plugin-fake",
      version: "0.1.0",
      publisher: "publisher:arc-core",
      kind: "process",
      capabilities: ["read", "update"],
      issuedAt: "2026-06-07T00:00:00.000Z",
    });
    expect(m.claims.sha256).toMatch(/^[0-9a-f]{64}$/);

    const r = await verifyArtifact({
      manifest: m,
      artifactPath: file,
      publisherPubB64u: k.pubB64u,
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it("refuses to sign an unknown capability (typo surfaces locally, not at runtime)", async () => {
    const k = generatePublisherKey();
    const file = writeTempArtifact(Buffer.from("x"));
    await expect(
      signArtifact({
        artifactPath: file,
        publisherPrivB64u: k.privB64u,
        publisher: "publisher:arc-core",
        name: "arc-plugin-x",
        version: "0.1.0",
        kind: "process",
        capabilities: ["read", "write"], // "write" isn't in arc-grants vocabulary
      }),
    ).rejects.toThrow(/unknown capability "write"/);
  });

  it("default issuedAt is an ISO-8601 string when not provided", async () => {
    const k = generatePublisherKey();
    const file = writeTempArtifact(Buffer.from("y"));
    const m = await signArtifact({
      artifactPath: file,
      publisherPrivB64u: k.privB64u,
      publisher: "publisher:p",
      name: "p",
      version: "0.0.1",
      kind: "wasm",
    });
    expect(m.claims.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("rejects a verify when the artifact bytes changed after signing", async () => {
    const k = generatePublisherKey();
    const file = writeTempArtifact(Buffer.from("v1"));
    const m = await signArtifact({
      artifactPath: file,
      publisherPrivB64u: k.privB64u,
      publisher: "publisher:p",
      name: "p",
      version: "0.0.1",
      kind: "process",
    });
    // tamper the bytes
    writeFileSync(file, Buffer.from("v2"));
    expect(
      (await verifyArtifact({ manifest: m, artifactPath: file, publisherPubB64u: k.pubB64u })).reason,
    ).toBe("artifact_hash_mismatch");
  });

  it("rejects a verify against a different publisher pub key", async () => {
    const signer = generatePublisherKey();
    const stranger = generatePublisherKey();
    const file = writeTempArtifact(Buffer.from("a"));
    const m = await signArtifact({
      artifactPath: file,
      publisherPrivB64u: signer.privB64u,
      publisher: "publisher:p",
      name: "p",
      version: "0.0.1",
      kind: "process",
    });
    expect(
      (await verifyArtifact({ manifest: m, artifactPath: file, publisherPubB64u: stranger.pubB64u }))
        .reason,
    ).toBe("invalid_signature");
  });

  it("rejects a verify when the manifest declared an unknown capability", async () => {
    const k = generatePublisherKey();
    const file = writeTempArtifact(Buffer.from("c"));
    const m = await signArtifact({
      artifactPath: file,
      publisherPrivB64u: k.privB64u,
      publisher: "publisher:p",
      name: "p",
      version: "0.0.1",
      kind: "process",
    });
    // Inject an unknown verb into the manifest (skips signArtifact's filter for the test).
    m.claims.capabilities = ["read", "manage"];
    expect(
      (await verifyArtifact({ manifest: m, artifactPath: file, publisherPubB64u: k.pubB64u })).reason,
    ).toBe("capability_unknown");
  });
});

describe("KNOWN_PLUGIN_CAPABILITIES", () => {
  it("matches the arc-grants vocabulary", () => {
    expect([...KNOWN_PLUGIN_CAPABILITIES].sort()).toEqual(
      ["create", "delete", "list", "read", "sudo", "update"],
    );
  });
});
