import { describe, expect, it } from "vitest";
import {
  generateSigningKeyPair,
  pluginArtifactDigest,
  signPluginManifest,
  verifyPluginManifest,
} from "../src/index";
import type { PluginManifestClaims } from "@arc/types";

function fresh(over: Partial<PluginManifestClaims> = {}): PluginManifestClaims {
  return {
    v: 1,
    name: "arc-plugin-aws",
    version: "0.1.0",
    kind: "wasm",
    sha256: "0".repeat(64),
    publisher: "publisher:arc-core",
    issuedAt: "2026-06-07T00:00:00.000Z",
    ...over,
  };
}

describe("plugin manifest sign / verify", () => {
  it("round-trips", () => {
    const k = generateSigningKeyPair();
    const m = fresh();
    expect(verifyPluginManifest(k.pub, m, signPluginManifest(k.priv, m))).toBe(true);
  });

  it("rejects every field tamper", () => {
    const k = generateSigningKeyPair();
    const m = fresh();
    const sig = signPluginManifest(k.priv, m);
    const tampers: Array<Partial<PluginManifestClaims>> = [
      { name: "evil-plugin" },
      { version: "0.1.1" },
      { kind: "process" },
      { sha256: "1".repeat(64) },
      { publisher: "publisher:other" },
      { issuedAt: "2026-06-08T00:00:00.000Z" },
    ];
    for (const t of tampers) {
      expect(verifyPluginManifest(k.pub, { ...m, ...t }, sig)).toBe(false);
    }
  });

  it("rejects a wrong verifying key", () => {
    const k = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const m = fresh();
    expect(verifyPluginManifest(other.pub, m, signPluginManifest(k.priv, m))).toBe(false);
  });
});

describe("pluginArtifactDigest", () => {
  it("is the lowercase hex SHA-256 of the bytes", () => {
    // SHA-256("") known answer.
    expect(pluginArtifactDigest(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("differs for differing bytes", () => {
    expect(pluginArtifactDigest(new Uint8Array([1, 2, 3]))).not.toBe(
      pluginArtifactDigest(new Uint8Array([1, 2, 4])),
    );
  });
});
