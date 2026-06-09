/**
 * CLI-level spec for `arc-plugin-sign`. Drives `runCli` directly (no child process so the
 * tests stay fast and TS-source-resolvable) and asserts: keygen writes a 0600 priv file,
 * sign + verify round-trip via the CLI surface produces a manifest that arc-server would
 * accept, env:VAR priv source works for CI secrets, and verify exits 2 on tamper.
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/bin";

interface Captured {
  out: string[];
  err: string[];
  code: number;
}

async function run(argv: string[], env: Record<string, string | undefined> = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env: { ...env },
  });
  return { out, err, code };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "arc-pms-cli-"));
});

afterEach(() => {
  // Test dirs are tiny and the OS GCs /tmp; no need to clean up explicitly.
});

describe("arc-plugin-sign CLI", () => {
  it("keygen writes the priv as mode-0600 and prints the pub to stdout", async () => {
    const priv = join(tmp, "publisher.key");
    const r = await run(["keygen", "--out-priv", priv]);
    expect(r.code).toBe(0);
    expect(existsSync(priv)).toBe(true);
    // 0o600 (rw-------) — mask off the file-type bits.
    expect(statSync(priv).mode & 0o777).toBe(0o600);
    expect(r.out).toHaveLength(1);
    expect(r.out[0]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("keygen --out-pub writes pub to a file (no stdout)", async () => {
    const priv = join(tmp, "publisher.key");
    const pub = join(tmp, "publisher.pub");
    const r = await run(["keygen", "--out-priv", priv, "--out-pub", pub]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([]);
    expect(readFileSync(pub, "utf8").trim()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("sign + verify round-trip through the CLI", async () => {
    const priv = join(tmp, "publisher.key");
    const pub = join(tmp, "publisher.pub");
    await run(["keygen", "--out-priv", priv, "--out-pub", pub]);

    const artifact = join(tmp, "arc-plugin-fake.cjs");
    writeFileSync(artifact, "console.log('fake');\n");

    const manifestPath = join(tmp, "manifest.json");
    const signed = await run([
      "sign",
      "--artifact", artifact,
      "--priv", priv,
      "--publisher", "publisher:arc-core",
      "--name", "arc-plugin-fake",
      "--version", "0.1.0",
      "--kind", "process",
      "--capabilities", "read,update,delete",
      "--out", manifestPath,
    ]);
    expect(signed.code).toBe(0);
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.claims.publisher).toBe("publisher:arc-core");
    expect(manifest.claims.capabilities).toEqual(["read", "update", "delete"]);

    const verified = await run([
      "verify",
      "--artifact", artifact,
      "--manifest", manifestPath,
      "--pub", pub,
    ]);
    expect(verified.code).toBe(0);
    expect(verified.out.join("\n")).toMatch(/ok: manifest verified for arc-plugin-fake@0.1.0/);
  });

  it("sign refuses an unknown capability with a useful error message", async () => {
    const priv = join(tmp, "publisher.key");
    await run(["keygen", "--out-priv", priv]);
    const artifact = join(tmp, "p");
    writeFileSync(artifact, "x");

    const r = await run([
      "sign",
      "--artifact", artifact,
      "--priv", priv,
      "--publisher", "publisher:p",
      "--name", "p",
      "--version", "0.0.1",
      "--kind", "process",
      "--capabilities", "read,write",
    ]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/unknown capability "write"/);
  });

  it("sign --priv env:VAR reads the key from an env var (CI-secret path)", async () => {
    const seed = await run(["keygen", "--out-priv", join(tmp, "k.key")]);
    const pub = seed.out[0]!;
    const privFromDisk = readFileSync(join(tmp, "k.key"), "utf8").trim();

    const artifact = join(tmp, "a");
    writeFileSync(artifact, "z");

    const signed = await run(
      [
        "sign",
        "--artifact", artifact,
        "--priv", "env:ARC_PUB_KEY",
        "--publisher", "publisher:p",
        "--name", "p",
        "--version", "0.0.1",
        "--kind", "process",
        "--out", join(tmp, "m.json"),
      ],
      { ARC_PUB_KEY: privFromDisk },
    );
    expect(signed.code).toBe(0);

    const verified = await run([
      "verify",
      "--artifact", artifact,
      "--manifest", join(tmp, "m.json"),
      "--pub", pub,
    ]);
    expect(verified.code).toBe(0);
  });

  it("sign --priv env:VAR fails clearly when the env var is unset", async () => {
    const artifact = join(tmp, "a");
    writeFileSync(artifact, "z");
    const r = await run([
      "sign",
      "--artifact", artifact,
      "--priv", "env:DOES_NOT_EXIST",
      "--publisher", "publisher:p",
      "--name", "p",
      "--version", "0.0.1",
      "--kind", "process",
    ]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/env var DOES_NOT_EXIST is unset/);
  });

  it("verify exits 2 (refused) when the artifact bytes don't match the manifest", async () => {
    const priv = join(tmp, "k.key");
    const pub = (await run(["keygen", "--out-priv", priv])).out[0]!;
    const artifact = join(tmp, "a");
    writeFileSync(artifact, "v1");
    const manifestPath = join(tmp, "m.json");
    await run([
      "sign",
      "--artifact", artifact,
      "--priv", priv,
      "--publisher", "publisher:p",
      "--name", "p",
      "--version", "0.0.1",
      "--kind", "process",
      "--out", manifestPath,
    ]);
    writeFileSync(artifact, "v2"); // tamper

    const r = await run([
      "verify",
      "--artifact", artifact,
      "--manifest", manifestPath,
      "--pub", pub,
    ]);
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toMatch(/refused: artifact_hash_mismatch/);
  });

  it("usage error when --kind is not one of wasm|process", async () => {
    const priv = join(tmp, "k.key");
    await run(["keygen", "--out-priv", priv]);
    const artifact = join(tmp, "a");
    writeFileSync(artifact, "z");
    const r = await run([
      "sign",
      "--artifact", artifact,
      "--priv", priv,
      "--publisher", "publisher:p",
      "--name", "p",
      "--version", "0.0.1",
      "--kind", "container",
    ]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/--kind must be "wasm" or "process"/);
  });

  it("pubkey re-derives the matching pub from a priv file (round-trip with keygen)", async () => {
    const priv = join(tmp, "k.key");
    const pub = (await run(["keygen", "--out-priv", priv])).out[0]!;
    const derived = await run(["pubkey", "--priv", priv]);
    expect(derived.code).toBe(0);
    expect(derived.out).toEqual([pub]);
  });

  it("pubkey accepts an env:VAR priv source (matches sign's CI-secret path)", async () => {
    const seed = await run(["keygen", "--out-priv", join(tmp, "k.key")]);
    const expectedPub = seed.out[0]!;
    const privFromDisk = readFileSync(join(tmp, "k.key"), "utf8").trim();
    const r = await run(["pubkey", "--priv", "env:THE_PRIV"], { THE_PRIV: privFromDisk });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([expectedPub]);
  });

  it("unknown subcommand returns 1 with usage on stderr", async () => {
    const r = await run(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/unknown command: frobnicate/);
  });

  it("--help returns 0 with usage on stdout", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toMatch(/arc-plugin-sign <command>/);
  });
});
