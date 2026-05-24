import {
  ARGON_PROFILES,
  type ArgonProfile,
  type ArgonProfileName,
  deriveAuthHash,
  deriveMasterKey,
  derivePasskeyWrapKey,
  deriveRecoveryWrapKey,
  splitMasterKey,
} from "./kdf";
import {
  decodeRecoveryKey,
  generateIdentityKeyPair,
  generateRecoveryKey,
  generateSigningKeyPair,
} from "./keys";
import { aeadOpen, aeadSeal, type Envelope } from "./envelope";
import { seal, sealOpen } from "./seal";
import { buildAad } from "./aad";
import { signObject } from "./sign";
import {
  edPubFromPriv,
  randomBytes,
  SALT_BYTES,
  x25519PubFromPriv,
} from "./primitives";
import { fromB64u, toB64u, utf8, fromUtf8, wipe } from "./bytes";
import { jcs } from "./jcs";
import { VaultCryptoError, type JsonValue } from "./types";

/** Server-stored, non-secret keyset (all enc* are envelopes / ciphertext). */
export interface Keyset {
  saltMk: string;
  saltAuth: string;
  argonParams: ArgonProfile;
  authHash: string;
  identityPublicKey: string;
  signingPublicKey: string;
  identitySelfAttestation: string;
  encIdentityPriv: Envelope;
  encSigningPriv: Envelope;
  encIdentityPrivRecovery: Envelope;
  keyVersion: number;
}

/** In-memory unlocked state. Never persisted (docs/12). */
export interface Session {
  wk: Uint8Array;
  identityPriv: Uint8Array;
  identityPub: Uint8Array;
  signingPriv: Uint8Array;
  signingPub: Uint8Array;
}

export interface VaultKeyMaterial {
  vk: Uint8Array;
  keyVersion: number;
}

export interface EnrollResult {
  keyset: Keyset;
  /** Shown to the user exactly once (docs/05 §5.7). */
  recoveryKey: string;
  session: Session;
  /** VK for the user's personal vault (a one-member vault — docs/07 §7.1). */
  personalVaultKey: VaultKeyMaterial;
}

const privAad = (keyName: string, keyVersion: number, wrap?: string) =>
  buildAad(
    wrap
      ? [["keyName", keyName], ["wrap", wrap], ["keyVersion", String(keyVersion)]]
      : [["keyName", keyName], ["keyVersion", String(keyVersion)]],
  );

/** Full client-side enrollment (docs/06 §6.2). Returns ciphertext keyset + in-memory session. */
export function enroll(
  masterPassword: string,
  opts: { profile?: ArgonProfileName } = {},
): EnrollResult {
  const params = ARGON_PROFILES[opts.profile ?? "desktop"];
  const saltMk = randomBytes(SALT_BYTES);
  const saltAuth = randomBytes(SALT_BYTES);

  const mk = deriveMasterKey(masterPassword, saltMk, params);
  const { authSeed, wk } = splitMasterKey(mk);
  const authHash = deriveAuthHash(authSeed, saltAuth, params);

  const identity = generateIdentityKeyPair();
  const signing = generateSigningKeyPair();
  const keyVersion = 1;

  const encIdentityPriv = aeadSeal(wk, identity.priv, privAad("identity-priv", keyVersion));
  const encSigningPriv = aeadSeal(wk, signing.priv, privAad("signing-priv", keyVersion));

  const recovery = generateRecoveryKey();
  const recoveryWrap = deriveRecoveryWrapKey(recovery.raw);
  const encIdentityPrivRecovery = aeadSeal(
    recoveryWrap,
    identity.priv,
    privAad("identity-priv", keyVersion, "recovery"),
  );

  const ts = new Date().toISOString();
  const attestation = signObject(signing.priv, {
    identityPub: toB64u(identity.pub),
    signingPub: toB64u(signing.pub),
    ts,
  });

  wipe(mk, authSeed);

  return {
    keyset: {
      saltMk: toB64u(saltMk),
      saltAuth: toB64u(saltAuth),
      argonParams: params,
      authHash: toB64u(authHash),
      identityPublicKey: toB64u(identity.pub),
      signingPublicKey: toB64u(signing.pub),
      identitySelfAttestation: JSON.stringify(attestation),
      encIdentityPriv,
      encSigningPriv,
      encIdentityPrivRecovery,
      keyVersion,
    },
    recoveryKey: recovery.encoded,
    session: {
      wk,
      identityPriv: identity.priv,
      identityPub: identity.pub,
      signingPriv: signing.priv,
      signingPub: signing.pub,
    },
    personalVaultKey: { vk: randomBytes(32), keyVersion: 1 },
  };
}

/** Derive the auth proof to send to the server (rate-limit gate only). */
export function computeAuthHash(masterPassword: string, keyset: Keyset): string {
  const mk = deriveMasterKey(masterPassword, fromB64u(keyset.saltMk), keyset.argonParams);
  const { authSeed } = splitMasterKey(mk);
  const authHash = deriveAuthHash(authSeed, fromB64u(keyset.saltAuth), keyset.argonParams);
  wipe(mk, authSeed);
  return toB64u(authHash);
}

/**
 * Unlock with the master password (docs/06 §6.3). Correctness is gated by the AEAD
 * unwrap of the private keys — not by authHash, which is a server-side rate-limit signal.
 */
export function unlock(masterPassword: string, keyset: Keyset): Session {
  const mk = deriveMasterKey(masterPassword, fromB64u(keyset.saltMk), keyset.argonParams);
  const { wk } = splitMasterKey(mk);
  wipe(mk);
  const identityPriv = aeadOpen(
    wk,
    keyset.encIdentityPriv,
    privAad("identity-priv", keyset.keyVersion),
  );
  const signingPriv = aeadOpen(
    wk,
    keyset.encSigningPriv,
    privAad("signing-priv", keyset.keyVersion),
  );
  return {
    wk,
    identityPriv,
    identityPub: x25519PubFromPriv(identityPriv),
    signingPriv,
    signingPub: edPubFromPriv(signingPriv),
  };
}

/** Recover the identity private key from the recovery key (docs/05 §5.7). */
export function recoverIdentityPriv(recoveryKeyEncoded: string, keyset: Keyset): Uint8Array {
  const recoveryWrap = deriveRecoveryWrapKey(decodeRecoveryKey(recoveryKeyEncoded));
  return aeadOpen(
    recoveryWrap,
    keyset.encIdentityPrivRecovery,
    privAad("identity-priv", keyset.keyVersion, "recovery"),
  );
}

/**
 * Passkey unlock (docs/13): wrap the identity private key under a key derived from a
 * WebAuthn PRF output. Additive — it never replaces the master-password or recovery wraps.
 * One wrap is stored per registered passkey credential (PRF output is per-credential).
 */
export function wrapIdentityForPasskey(
  identityPriv: Uint8Array,
  prfOutput: Uint8Array,
  keyVersion = 1,
): Envelope {
  return aeadSeal(
    derivePasskeyWrapKey(prfOutput),
    identityPriv,
    privAad("identity-priv", keyVersion, "passkey"),
  );
}

export function unwrapIdentityFromPasskey(
  encIdentityPrivPasskey: Envelope,
  prfOutput: Uint8Array,
  keyVersion = 1,
): Uint8Array {
  return aeadOpen(
    derivePasskeyWrapKey(prfOutput),
    encIdentityPrivPasskey,
    privAad("identity-priv", keyVersion, "passkey"),
  );
}

// --- Vault keys, grants, items ---

export function createVaultKey(keyVersion = 1): VaultKeyMaterial {
  return { vk: randomBytes(32), keyVersion };
}

/** Wrap a VK to a recipient's identity public key (docs/07 §7.4). Confidentiality only. */
export function wrapVaultKeyFor(vk: Uint8Array, recipientIdentityPub: Uint8Array): Envelope {
  return seal(recipientIdentityPub, vk);
}

export function openVaultKeyGrant(grant: Envelope, identityPriv: Uint8Array): Uint8Array {
  return sealOpen(identityPriv, grant);
}

/** Detached Ed25519 signature over a grant tuple (docs/03 §3.5 (c)) for the grant chain. */
export function signGrant(
  signingPriv: Uint8Array,
  tuple: { vaultId: string; keyVersion: number; granteeIdentityPub: string; ts: string },
  kid?: string,
) {
  return signObject(signingPriv, tuple as unknown as JsonValue, kid);
}

export interface ItemRef {
  vaultId: string;
  itemId: string;
  version: number;
  keyVersion: number;
}

export interface EncryptedItem {
  ciphertext: Envelope;
  wrappedItemKey: Envelope;
}

const itemAad = (r: ItemRef) =>
  buildAad([
    ["vaultId", r.vaultId],
    ["itemId", r.itemId],
    ["version", String(r.version)],
    ["keyVersion", String(r.keyVersion)],
  ]);

const ikAad = (r: ItemRef) =>
  buildAad([
    ["vaultId", r.vaultId],
    ["itemId", r.itemId],
    ["scope", "ik"],
    ["keyVersion", String(r.keyVersion)],
  ]);

/** Encrypt an item: random IK encrypts the payload, VK wraps the IK (docs/03 §3.6). */
export function encryptItem(vk: Uint8Array, ref: ItemRef, item: JsonValue): EncryptedItem {
  const ik = randomBytes(32);
  const ciphertext = aeadSeal(ik, utf8(jcs(item)), itemAad(ref), { kv: ref.keyVersion, pad: true });
  const wrappedItemKey = aeadSeal(vk, ik, ikAad(ref), { kv: ref.keyVersion });
  wipe(ik);
  return { ciphertext, wrappedItemKey };
}

export function decryptItem(vk: Uint8Array, ref: ItemRef, enc: EncryptedItem): JsonValue {
  const ik = aeadOpen(vk, enc.wrappedItemKey, ikAad(ref));
  const pt = aeadOpen(ik, enc.ciphertext, itemAad(ref));
  wipe(ik);
  try {
    return JSON.parse(fromUtf8(pt)) as JsonValue;
  } catch {
    throw new VaultCryptoError("item payload is not valid JSON after decrypt");
  }
}

export function lockSession(session: Session): void {
  wipe(session.wk, session.identityPriv, session.signingPriv);
}
