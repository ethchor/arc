// PoC: does hash-wasm's Argon2id produce byte-identical output to @noble/hashes for the
// same params? If yes, the worker can swap to WASM (10–50× faster) without lockout risk.
// Temporary — delete after the decision.
import { describe, it, expect } from "vitest";
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2";
import { argon2id as wasmArgon2id } from "hash-wasm";

const pw = new TextEncoder().encode("correct horse battery staple");
const salt = new Uint8Array(16).fill(7);
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

async function both(p: { m: number; t: number; p: number }) {
  const noble = nobleArgon2id(pw, salt, { m: p.m, t: p.t, p: p.p, dkLen: 32 });
  const wasm = await wasmArgon2id({
    password: pw,
    salt,
    parallelism: p.p,
    iterations: p.t,
    memorySize: p.m, // KiB, same unit as noble's `m`
    hashLength: 32,
    outputType: "binary",
  });
  return { noble: hex(noble), wasm: hex(wasm as Uint8Array) };
}

describe("Argon2id parity: @noble/hashes vs hash-wasm", () => {
  it("test profile (m=256,t=1,p=1) is byte-identical", async () => {
    const r = await both({ m: 256, t: 1, p: 1 });
    console.log("test   noble:", r.noble);
    console.log("test    wasm:", r.wasm);
    expect(r.wasm).toBe(r.noble);
  });

  it("mobile profile (m=65536,t=4,p=1) is byte-identical", async () => {
    const r = await both({ m: 65536, t: 4, p: 1 });
    console.log("mobile noble:", r.noble);
    console.log("mobile  wasm:", r.wasm);
    expect(r.wasm).toBe(r.noble);
  });
});
