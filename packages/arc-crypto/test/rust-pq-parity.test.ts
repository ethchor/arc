/**
 * MED-H (supply-chain audit). The existing parity vector goes TS → Rust open: the TS
 * stack seals a known plaintext to a known hybrid identity, the Rust verifier proves it
 * opens to the same bytes. The reverse direction was uncovered — a regression in the Rust
 * `pq_seal_to_envelope` impl that produced subtly-different bytes (e.g. swapped the salt
 * order, or used a different HKDF info string) would still pass the existing test because
 * "open" only exercises decap + HKDF, not encaps.
 *
 * This test closes that gap. It spawns the Rust `gen_pq_vector` example (which freshly
 * generates a hybrid keypair, calls `pq_seal_to_envelope`, and dumps the envelope + the
 * matching private keys as JSON), then asks the TS `pqSealOpen` to open it. A byte-level
 * disagreement in the Rust seal path is now caught at the contract layer — both
 * directions of the X-Wing combiner are pinned end-to-end.
 *
 * The test skips when:
 *   - `cargo` isn't on PATH (default CI without Rust toolchain), or
 *   - `ARC_SKIP_RUST_PARITY=1` (explicit opt-out for local dev iteration speed).
 *
 * CI's `rust` job has cargo and runs both halves so this regression is exercised every
 * push.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fromHex, pqSealOpen } from "../src";

function cargoAvailable(): boolean {
  if (process.env.ARC_SKIP_RUST_PARITY === "1") return false;
  const r = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

describe.skipIf(!cargoAvailable())("Rust→TS pqSeal parity (MED-H)", () => {
  it("TS opens a Rust-generated pq-seal envelope", () => {
    const cargoToml = resolve(__dirname, "../../../crates/vault-crypto-rs/Cargo.toml");
    // --release for ~10x faster ML-KEM ops vs debug; the vector itself is non-deterministic
    // so we can't snapshot — we just need a fresh sealed envelope per run.
    const out = execFileSync(
      "cargo",
      ["run", "--release", "--quiet", "--manifest-path", cargoToml, "--example", "gen_pq_vector"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );

    // The cargo prelude (`Finished`, `Running`) goes to stderr, so stdout is exactly one
    // JSON line. Be permissive though — strip blank lines defensively.
    const line = out
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.startsWith("{") && s.endsWith("}"));
    expect(line, `expected one JSON line on stdout, got: ${out.slice(0, 200)}…`).toBeTruthy();

    const v = JSON.parse(line!) as {
      x25519Priv: string;
      x25519Pub: string;
      mlkemPriv: string;
      mlkemPub: string;
      aad: string;
      plaintextHex: string;
      envelope: Record<string, unknown>;
    };

    // Open with the TS stack — this exercises decap + HKDF + AEAD against bytes the Rust
    // stack produced. A mismatch means seal/open are NOT inverses across stacks.
    const opened = pqSealOpen(
      v.envelope as unknown as Parameters<typeof pqSealOpen>[0],
      {
        x25519Priv: fromHex(v.x25519Priv),
        mlkemPriv: fromHex(v.mlkemPriv),
      },
      v.aad,
    );

    // toHex round-trip lets us compare bytes without the Uint8Array vs Buffer trap.
    const openedHex = Buffer.from(opened).toString("hex");
    expect(openedHex).toBe(v.plaintextHex);

    // Wrong AAD must fail closed — same property as the TS→Rust direction.
    expect(() =>
      pqSealOpen(
        v.envelope as unknown as Parameters<typeof pqSealOpen>[0],
        { x25519Priv: fromHex(v.x25519Priv), mlkemPriv: fromHex(v.mlkemPriv) },
        "different-aad",
      ),
    ).toThrow();
  }, 60_000);
});
