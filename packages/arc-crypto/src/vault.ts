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
import {
  generateHybridIdentityKeyPair,
  type HybridPriv,
  type HybridPub,
  pqSeal,
  pqSealOpen,
} from "./pq-hybrid";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
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

/**
 * Server-stored, non-secret keyset (all enc* are envelopes / ciphertext).
 *
 * Hybrid identity (ADR-002): a recipient publishes *both* an X25519 public key and an
 * ML-KEM-768 public key. Grants to this recipient are wrapped under the post-quantum
 * hybrid sealed box (`pq-seal-x25519-mlkem768-hkdf-xc20p`), so an attacker who records
 * the wrapped grants today and breaks ECC in 203X must *also* break ML-KEM-768 to
 * recover any VK. The ML-KEM private key is wrapped under the same WK (master-password
 * derived) and recovery wraps as the X25519 identity private — no new password-derived
 * key, no extra recovery material.
 */
export interface Keyset {
  saltMk: string;
  saltAuth: string;
  argonParams: ArgonProfile;
  authHash: string;
  identityPublicKey: string;
  identityPublicKeyMlkem: string;
  signingPublicKey: string;
  identitySelfAttestation: string;
  encIdentityPriv: Envelope;
  encIdentityPrivMlkem: Envelope;
  encSigningPriv: Envelope;
  encIdentityPrivRecovery: Envelope;
  encIdentityPrivMlkemRecovery: Envelope;
  /**
   * Signing private key wrapped under the recovery key (ADR-006). Additive + optional for
   * back-compat: keysets enrolled before ADR-006 omit it, and can't do a *clean* recovery
   * (no public-key change) of the signing key. New enrollments always include it so recovery
   * is a pure re-wrap.
   */
  encSigningPrivRecovery?: Envelope;
  keyVersion: number;
}

/** In-memory unlocked state. Never persisted (docs/12). */
export interface Session {
  wk: Uint8Array;
  identityPriv: Uint8Array;
  identityPub: Uint8Array;
  identityPrivMlkem: Uint8Array;
  identityPubMlkem: Uint8Array;
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
  const hybrid = generateHybridIdentityKeyPair();
  const signing = generateSigningKeyPair();
  const keyVersion = 1;

  const encIdentityPriv = aeadSeal(wk, identity.priv, privAad("identity-priv", keyVersion));
  const encIdentityPrivMlkem = aeadSeal(
    wk,
    hybrid.mlkem.secretKey,
    privAad("identity-priv-mlkem", keyVersion),
  );
  const encSigningPriv = aeadSeal(wk, signing.priv, privAad("signing-priv", keyVersion));

  const recovery = generateRecoveryKey();
  const recoveryWrap = deriveRecoveryWrapKey(recovery.raw);
  const encIdentityPrivRecovery = aeadSeal(
    recoveryWrap,
    identity.priv,
    privAad("identity-priv", keyVersion, "recovery"),
  );
  const encIdentityPrivMlkemRecovery = aeadSeal(
    recoveryWrap,
    hybrid.mlkem.secretKey,
    privAad("identity-priv-mlkem", keyVersion, "recovery"),
  );
  // ADR-006: also recovery-wrap the signing key so recovery is a pure re-wrap with no
  // public-key change (the Ed25519 pub stays the same, so every existing signature verifier
  // and grant keeps working).
  const encSigningPrivRecovery = aeadSeal(
    recoveryWrap,
    signing.priv,
    privAad("signing-priv", keyVersion, "recovery"),
  );

  const ts = new Date().toISOString();
  const attestation = signObject(signing.priv, {
    identityPub: toB64u(identity.pub),
    identityPubMlkem: toB64u(hybrid.mlkem.publicKey),
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
      identityPublicKeyMlkem: toB64u(hybrid.mlkem.publicKey),
      signingPublicKey: toB64u(signing.pub),
      identitySelfAttestation: JSON.stringify(attestation),
      encIdentityPriv,
      encIdentityPrivMlkem,
      encSigningPriv,
      encIdentityPrivRecovery,
      encIdentityPrivMlkemRecovery,
      encSigningPrivRecovery,
      keyVersion,
    },
    recoveryKey: recovery.encoded,
    session: {
      wk,
      identityPriv: identity.priv,
      identityPub: identity.pub,
      identityPrivMlkem: hybrid.mlkem.secretKey,
      identityPubMlkem: hybrid.mlkem.publicKey,
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
  const identityPrivMlkem = aeadOpen(
    wk,
    keyset.encIdentityPrivMlkem,
    privAad("identity-priv-mlkem", keyset.keyVersion),
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
    identityPrivMlkem,
    identityPubMlkem: ml_kem768.getPublicKey(identityPrivMlkem),
    signingPriv,
    signingPub: edPubFromPriv(signingPriv),
  };
}

/**
 * Recover the hybrid identity private keys from the recovery key (docs/05 §5.7, ADR-002).
 * Returns both the X25519 priv and the ML-KEM-768 priv — they're a hybrid pair, you always
 * need both to open hybrid-wrapped grants.
 */
export function recoverIdentityPriv(
  recoveryKeyEncoded: string,
  keyset: Keyset,
): { x25519: Uint8Array; mlkem: Uint8Array } {
  const recoveryWrap = deriveRecoveryWrapKey(decodeRecoveryKey(recoveryKeyEncoded));
  const x25519 = aeadOpen(
    recoveryWrap,
    keyset.encIdentityPrivRecovery,
    privAad("identity-priv", keyset.keyVersion, "recovery"),
  );
  const mlkem = aeadOpen(
    recoveryWrap,
    keyset.encIdentityPrivMlkemRecovery,
    privAad("identity-priv-mlkem", keyset.keyVersion, "recovery"),
  );
  return { x25519, mlkem };
}

/** What {@link recover} produces: the replacement keyset wrapping, an unlocked session, and a NEW recovery key. */
export interface RecoverResult {
  /**
   * The full keyset to upload. Every **public** key and the key version are byte-identical
   * to the original — only the master-password and recovery *wrapping* layers (and the salts
   * / authHash / self-attestation) are new. The server pins the pubs, so this is anti-takeover.
   */
  keyset: Keyset;
  /** Unlocked in-memory session for the new master password — ready to use immediately. */
  session: Session;
  /** The NEW recovery key (the old one no longer matches the re-wrapped envelopes). */
  recoveryKey: string;
}

/**
 * Master-password recovery (ADR-006). Using the recovery key, restore the identity + signing
 * private keys, then re-enroll them under a **new** master password and a **new** recovery
 * key — *without changing any public key or the key version*. Because the cryptographic
 * identity is unchanged, every existing VK grant, device grant, membership, and signature
 * stays valid; recovery restores access without rotating the account's identity.
 *
 * Requires a keyset with a recovery-wrapped signing key (`encSigningPrivRecovery`, ADR-006);
 * keysets enrolled before that can't be cleanly recovered (the signing key would have to be
 * rotated, which this function deliberately refuses rather than silently changing a pub).
 */
export function recover(
  recoveryKeyEncoded: string,
  keyset: Keyset,
  newMasterPassword: string,
  opts: { profile?: ArgonProfileName } = {},
): RecoverResult {
  if (!keyset.encSigningPrivRecovery) {
    throw new Error(
      "keyset has no recovery-wrapped signing key (enrolled before ADR-006); cannot cleanly recover",
    );
  }
  const keyVersion = keyset.keyVersion;

  // 1. Restore all three private keys from the recovery key.
  const oldRecoveryWrap = deriveRecoveryWrapKey(decodeRecoveryKey(recoveryKeyEncoded));
  const identityPriv = aeadOpen(
    oldRecoveryWrap,
    keyset.encIdentityPrivRecovery,
    privAad("identity-priv", keyVersion, "recovery"),
  );
  const identityPrivMlkem = aeadOpen(
    oldRecoveryWrap,
    keyset.encIdentityPrivMlkemRecovery,
    privAad("identity-priv-mlkem", keyVersion, "recovery"),
  );
  const signingPriv = aeadOpen(
    oldRecoveryWrap,
    keyset.encSigningPrivRecovery,
    privAad("signing-priv", keyVersion, "recovery"),
  );

  // 2. New master-password-derived wrapping layer (fresh salts).
  const params = ARGON_PROFILES[opts.profile ?? "desktop"];
  const saltMk = randomBytes(SALT_BYTES);
  const saltAuth = randomBytes(SALT_BYTES);
  const mk = deriveMasterKey(newMasterPassword, saltMk, params);
  const { authSeed, wk } = splitMasterKey(mk);
  const authHash = deriveAuthHash(authSeed, saltAuth, params);

  const encIdentityPriv = aeadSeal(wk, identityPriv, privAad("identity-priv", keyVersion));
  const encIdentityPrivMlkem = aeadSeal(wk, identityPrivMlkem, privAad("identity-priv-mlkem", keyVersion));
  const encSigningPriv = aeadSeal(wk, signingPriv, privAad("signing-priv", keyVersion));

  // 3. New recovery key + re-wrapped recovery envelopes (rotation — the old one is stale).
  const recovery = generateRecoveryKey();
  const newRecoveryWrap = deriveRecoveryWrapKey(recovery.raw);
  const encIdentityPrivRecovery = aeadSeal(newRecoveryWrap, identityPriv, privAad("identity-priv", keyVersion, "recovery"));
  const encIdentityPrivMlkemRecovery = aeadSeal(newRecoveryWrap, identityPrivMlkem, privAad("identity-priv-mlkem", keyVersion, "recovery"));
  const encSigningPrivRecovery = aeadSeal(newRecoveryWrap, signingPriv, privAad("signing-priv", keyVersion, "recovery"));

  // Pubs are derived from the recovered privs — identical to the originals by construction.
  const identityPub = x25519PubFromPriv(identityPriv);
  const identityPubMlkem = ml_kem768.getPublicKey(identityPrivMlkem);
  const signingPub = edPubFromPriv(signingPriv);

  const ts = new Date().toISOString();
  const attestation = signObject(signingPriv, {
    identityPub: toB64u(identityPub),
    identityPubMlkem: toB64u(identityPubMlkem),
    signingPub: toB64u(signingPub),
    ts,
  });

  wipe(mk, authSeed);

  return {
    keyset: {
      saltMk: toB64u(saltMk),
      saltAuth: toB64u(saltAuth),
      argonParams: params,
      authHash: toB64u(authHash),
      identityPublicKey: toB64u(identityPub),
      identityPublicKeyMlkem: toB64u(identityPubMlkem),
      signingPublicKey: toB64u(signingPub),
      identitySelfAttestation: JSON.stringify(attestation),
      encIdentityPriv,
      encIdentityPrivMlkem,
      encSigningPriv,
      encIdentityPrivRecovery,
      encIdentityPrivMlkemRecovery,
      encSigningPrivRecovery,
      keyVersion,
    },
    session: {
      wk,
      identityPriv,
      identityPub,
      identityPrivMlkem,
      identityPubMlkem,
      signingPriv,
      signingPub,
    },
    recoveryKey: recovery.encoded,
  };
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

/**
 * Companions to {@link wrapIdentityForPasskey} for the ML-KEM identity priv + the
 * signing priv. The PRF-derived KEK is the same; the AAD label is the per-target
 * `identity-priv-mlkem` / `signing-priv` plus the `"passkey"` suffix — matches the
 * recovery wrap layout exactly so the AAD encoder can never confuse targets.
 *
 * Wrapping all three at register time gives a full-capability session on passkey
 * unlock (decrypt VKs *and* sign vault heads). Without the signing wrap, passkey
 * unlock would be read-only.
 */
export function wrapIdentityMlkemForPasskey(
  identityPrivMlkem: Uint8Array,
  prfOutput: Uint8Array,
  keyVersion = 1,
): Envelope {
  return aeadSeal(
    derivePasskeyWrapKey(prfOutput),
    identityPrivMlkem,
    privAad("identity-priv-mlkem", keyVersion, "passkey"),
  );
}

export function unwrapIdentityMlkemFromPasskey(
  encIdentityPrivMlkemPasskey: Envelope,
  prfOutput: Uint8Array,
  keyVersion = 1,
): Uint8Array {
  return aeadOpen(
    derivePasskeyWrapKey(prfOutput),
    encIdentityPrivMlkemPasskey,
    privAad("identity-priv-mlkem", keyVersion, "passkey"),
  );
}

export function wrapSigningForPasskey(
  signingPriv: Uint8Array,
  prfOutput: Uint8Array,
  keyVersion = 1,
): Envelope {
  return aeadSeal(
    derivePasskeyWrapKey(prfOutput),
    signingPriv,
    privAad("signing-priv", keyVersion, "passkey"),
  );
}

export function unwrapSigningFromPasskey(
  encSigningPrivPasskey: Envelope,
  prfOutput: Uint8Array,
  keyVersion = 1,
): Uint8Array {
  return aeadOpen(
    derivePasskeyWrapKey(prfOutput),
    encSigningPrivPasskey,
    privAad("signing-priv", keyVersion, "passkey"),
  );
}

// --- Vault keys, grants, items ---

export function createVaultKey(keyVersion = 1): VaultKeyMaterial {
  return { vk: randomBytes(32), keyVersion };
}

/**
 * Wrap a VK to a recipient's hybrid identity (docs/07 §7.4, ADR-002). Confidentiality only,
 * post-quantum-resistant against harvest-now-decrypt-later. The signed grant tuple
 * (`signGrant`) carries the X25519 pub as the recipient identifier; the ML-KEM material is
 * bound into the envelope's HKDF transcript and need not appear in the signed tuple.
 */
export function wrapVaultKeyFor(vk: Uint8Array, recipient: HybridPub): Envelope {
  return pqSeal(recipient, vk);
}

export function openVaultKeyGrant(grant: Envelope, recipient: HybridPriv): Uint8Array {
  return pqSealOpen(grant, recipient);
}

/**
 * Recover the IK for an item the caller already holds the VK for (ADR-007 — used by the
 * granter side of an item-share). Mirrors what `decryptItem` does internally before opening
 * the ciphertext, but returns the IK itself so the granter can re-wrap it for a recipient.
 */
export function extractItemKey(vk: Uint8Array, ref: ItemRef, wrappedItemKey: Envelope): Uint8Array {
  return aeadOpen(vk, wrappedItemKey, ikAad(ref));
}

/**
 * Item-level share (ADR-007). Re-wraps the item's IK to the recipient's hybrid identity so
 * the recipient can decrypt **one** item without ever receiving the vault key. Same
 * primitive as `wrapVaultKeyFor` — `pqSeal` is opaque to what 32-byte key it's wrapping.
 */
export function wrapItemKeyForShare(ik: Uint8Array, recipient: HybridPub): Envelope {
  return pqSeal(recipient, ik);
}

/** Open a share envelope to recover the IK — the recipient's side of {@link wrapItemKeyForShare}. */
export function openItemKeyShare(env: Envelope, recipient: HybridPriv): Uint8Array {
  return pqSealOpen(env, recipient);
}

/**
 * Decrypt a shared item from the **IK** (not the VK). The recipient already holds the IK
 * (via {@link openItemKeyShare}); this just opens the ciphertext + JSON-parses, mirroring
 * the trailing half of {@link decryptItem}.
 */
export function decryptItemWithIK(ik: Uint8Array, ref: ItemRef, ciphertext: Envelope): JsonValue {
  const pt = aeadOpen(ik, ciphertext, itemAad(ref));
  try {
    return JSON.parse(fromUtf8(pt)) as JsonValue;
  } catch {
    throw new VaultCryptoError("shared-item payload is not valid JSON after decrypt");
  }
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

// Payload AAD binds the ITEM version (not the VK keyVersion) so a VK rotation that only
// re-wraps the IK does not invalidate the payload ciphertext — the cheap-rotation property
// of the IK layer (docs/03 §12).
const itemAad = (r: { vaultId: string; itemId: string; version: number }) =>
  buildAad([
    ["vaultId", r.vaultId],
    ["itemId", r.itemId],
    ["version", String(r.version)],
  ]);

// IK-wrap AAD binds the VK keyVersion (this is what changes on rotation).
const ikAad = (r: { vaultId: string; itemId: string; keyVersion: number }) =>
  buildAad([
    ["vaultId", r.vaultId],
    ["itemId", r.itemId],
    ["scope", "ik"],
    ["keyVersion", String(r.keyVersion)],
  ]);

/**
 * Re-wrap an item's IK from one VK version to the next, without touching the payload
 * (docs/07 §7.5). Used by VK rotation on member revocation.
 */
export function rewrapItemKey(
  oldVk: Uint8Array,
  newVk: Uint8Array,
  ref: { vaultId: string; itemId: string; oldKeyVersion: number; newKeyVersion: number },
  oldWrappedItemKey: Envelope,
): Envelope {
  const ik = aeadOpen(oldVk, oldWrappedItemKey, ikAad({ ...ref, keyVersion: ref.oldKeyVersion }));
  const out = aeadSeal(newVk, ik, ikAad({ ...ref, keyVersion: ref.newKeyVersion }), {
    kv: ref.newKeyVersion,
  });
  wipe(ik);
  return out;
}

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

// --- vault name (encrypted under VK; docs/07 §7.7) ---

const vaultNameAad = (keyVersion: number) =>
  buildAad([["scope", "vault-name"], ["keyVersion", String(keyVersion)]]);

export function encryptVaultName(vk: Uint8Array, name: string, keyVersion = 1): Envelope {
  return aeadSeal(vk, utf8(name), vaultNameAad(keyVersion), { kv: keyVersion });
}

export function decryptVaultName(vk: Uint8Array, env: Envelope, keyVersion = 1): string {
  return fromUtf8(aeadOpen(vk, env, vaultNameAad(keyVersion)));
}

// --- folder name (encrypted under VK; docs/07 §7.7) ---

const folderNameAad = (keyVersion: number) =>
  buildAad([["scope", "folder-name"], ["keyVersion", String(keyVersion)]]);

export function encryptFolderName(vk: Uint8Array, name: string, keyVersion = 1): Envelope {
  return aeadSeal(vk, utf8(name), folderNameAad(keyVersion), { kv: keyVersion });
}

export function decryptFolderName(vk: Uint8Array, env: Envelope, keyVersion = 1): string {
  return fromUtf8(aeadOpen(vk, env, folderNameAad(keyVersion)));
}

export function lockSession(session: Session): void {
  wipe(session.wk, session.identityPriv, session.identityPrivMlkem, session.signingPriv);
}
