// Generates known-answer test vectors from the TS crypto core (docs/04 §4.6, docs/15 §15.1).
// The Rust core's parity tests load the same file and must reproduce these bytes exactly.
//
//   pnpm --filter @arc-vault/crypto build && node packages/vault-crypto/scripts/gen-vectors.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  argon2id,
  splitMasterKey,
  buildAad,
  jcs,
  aeadEncrypt,
  edSign,
  edPubFromPriv,
  toHex,
  toB64u,
  fromHex,
  utf8,
} from "../dist/index.js";

const pwHex = "70617373776f7264"; // "password"
const saltHex = "000102030405060708090a0b0c0d0e0f";
const argonParams = { m: 256, t: 1, p: 1, dkLen: 32 };
const mk = argon2id(fromHex(pwHex), fromHex(saltHex), argonParams);
const split = splitMasterKey(mk);

const aadFields = [
  ["vaultId", "v1"],
  ["itemId", "i1"],
  ["version", "1"],
  ["keyVersion", "1"],
];

const aeadKeyHex = "0101010101010101010101010101010101010101010101010101010101010101";
const aeadNonceHex = "020202020202020202020202020202020202020202020202";
const aeadAad = buildAad(aadFields);
const aeadPlainHex = "68656c6c6f2d776f726c64"; // "hello-world"
const aeadCt = aeadEncrypt(fromHex(aeadKeyHex), fromHex(aeadNonceHex), fromHex(aeadPlainHex), utf8(aeadAad));

const edPrivHex = "0303030303030303030303030303030303030303030303030303030303030303";
const edMsgHex = "6d657373616765"; // "message"
const edSig = edSign(fromHex(edPrivHex), fromHex(edMsgHex));
const edPub = edPubFromPriv(fromHex(edPrivHex));

const jcsCases = [
  { value: { b: 1, a: 2 }, out: jcs({ b: 1, a: 2 }) },
  { value: { z: [3, 2, 1], a: { d: "x", c: null } }, out: jcs({ z: [3, 2, 1], a: { d: "x", c: null } }) },
  { value: { t: true, f: false, n: null, s: "a\"b" }, out: jcs({ t: true, f: false, n: null, s: 'a"b' }) },
];

const vectors = {
  argon2id: { passwordHex: pwHex, saltHex, ...argonParams, outHex: toHex(mk) },
  hkdfSplit: { ikmHex: toHex(mk), authSeedHex: toHex(split.authSeed), wkHex: toHex(split.wk) },
  aad: { fields: aadFields, out: aeadAad },
  jcs: jcsCases,
  aead: {
    keyHex: aeadKeyHex,
    nonceHex: aeadNonceHex,
    aad: aeadAad,
    plaintextHex: aeadPlainHex,
    ciphertextHex: toHex(aeadCt),
  },
  aeadEnvelope: {
    keyHex: aeadKeyHex,
    aad: aeadAad,
    plaintextHex: aeadPlainHex,
    envelope: {
      v: 1,
      alg: "XC20P",
      kdf: null,
      kv: null,
      aad: aeadAad,
      n: toB64u(fromHex(aeadNonceHex)),
      ct: toB64u(aeadCt),
      pad: 0,
    },
  },
  ed25519: {
    privHex: edPrivHex,
    pubHex: toHex(edPub),
    messageHex: edMsgHex,
    sigHex: toHex(edSig),
  },
};

const outPath = fileURLToPath(new URL("../../../vectors/kat.json", import.meta.url));
mkdirSync(fileURLToPath(new URL("../../../vectors/", import.meta.url)), { recursive: true });
writeFileSync(outPath, JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${outPath}`);
