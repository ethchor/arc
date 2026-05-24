import { edSign, edVerify, sha256 } from "./primitives";
import { concat, fromB64u, fromHex, toB64u, toHex, utf8 } from "./bytes";
import { jcs } from "./jcs";
import { ALG, ENVELOPE_VERSION, type Envelope, type SignatureEnvelope } from "./envelope";
import type { JsonValue } from "./types";

/** Canonical mutation tuple signed by an item author (docs/10 §10.4). */
export interface MutationTuple {
  vaultId: string;
  itemId: string;
  version: number;
  keyVersion: number;
  digest: string;
  authorUserId: number;
  ts: string;
  [k: string]: JsonValue;
}

/** digest = SHA-256( JCS(ciphertext) || JCS(wrappedItemKey) ), hex. */
export function mutationDigest(ciphertext: Envelope, wrappedItemKey: Envelope): string {
  const bytes = concat(
    utf8(jcs(ciphertext as unknown as JsonValue)),
    utf8(jcs(wrappedItemKey as unknown as JsonValue)),
  );
  return toHex(sha256(bytes));
}

/** Sign any canonical object: signature = Ed25519( SHA-256( JCS(object) ) ). */
export function signObject(
  signingPriv: Uint8Array,
  object: JsonValue,
  kid?: string,
): SignatureEnvelope {
  const sig = edSign(signingPriv, sha256(utf8(jcs(object))));
  return { v: ENVELOPE_VERSION, alg: "Ed25519", kid: kid ?? null, sig: toB64u(sig) };
}

export function verifyObject(
  signingPub: Uint8Array,
  object: JsonValue,
  sigEnv: SignatureEnvelope,
): boolean {
  if (sigEnv.alg !== ALG.SIG) return false;
  return edVerify(signingPub, sha256(utf8(jcs(object))), fromB64u(sigEnv.sig));
}

export const signMutation = (
  signingPriv: Uint8Array,
  tuple: MutationTuple,
  kid?: string,
): SignatureEnvelope => signObject(signingPriv, tuple, kid);

export const verifyMutation = (
  signingPub: Uint8Array,
  tuple: MutationTuple,
  sigEnv: SignatureEnvelope,
): boolean => verifyObject(signingPub, tuple, sigEnv);

// --- Signed vault-head / hash chain (docs/10 §10.5) ---

export const ZERO_CHAIN = "00".repeat(32);

/** chainHash_n = SHA-256( chainHash_{n-1} || mutationDigest_n ). */
export function chainNext(prevHashHex: string, mutationDigestHex: string): string {
  return toHex(sha256(concat(fromHex(prevHashHex), fromHex(mutationDigestHex))));
}

export interface VaultHead {
  vaultId: string;
  seq: number;
  chainHash: string;
  ts: string;
  [k: string]: JsonValue;
}

export const signHead = (
  signingPriv: Uint8Array,
  head: VaultHead,
  kid?: string,
): SignatureEnvelope => signObject(signingPriv, head, kid);

export const verifyHead = (
  signingPub: Uint8Array,
  head: VaultHead,
  sigEnv: SignatureEnvelope,
): boolean => verifyObject(signingPub, head, sigEnv);
