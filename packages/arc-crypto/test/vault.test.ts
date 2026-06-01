import { describe, expect, it } from "vitest";
import {
  computeAuthHash,
  createVaultKey,
  decryptItem,
  encryptItem,
  enroll,
  type ItemRef,
  openVaultKeyGrant,
  randomBytes,
  recoverIdentityPriv,
  rewrapItemKey,
  toHex,
  unlock,
  unwrapIdentityFromPasskey,
  wrapIdentityForPasskey,
  wrapVaultKeyFor,
} from "../src";

const PW = "correct horse battery staple";
const profile = "test" as const; // fast Argon2id params for tests only

describe("enroll + unlock", () => {
  it("unlocks with the correct password and recovers the same keys", () => {
    const e = enroll(PW, { profile });
    const s = unlock(PW, e.keyset);
    expect(toHex(s.identityPriv)).toBe(toHex(e.session.identityPriv));
    expect(toHex(s.signingPriv)).toBe(toHex(e.session.signingPriv));
  });

  it("fails to unlock with a wrong password", () => {
    const e = enroll(PW, { profile });
    expect(() => unlock("wrong password", e.keyset)).toThrow();
  });

  it("computes an authHash matching the enrolled one", () => {
    const e = enroll(PW, { profile });
    expect(computeAuthHash(PW, e.keyset)).toBe(e.keyset.authHash);
  });
});

describe("recovery", () => {
  it("recovers both the X25519 and ML-KEM-768 identity privs from the recovery key", () => {
    const e = enroll(PW, { profile });
    const recovered = recoverIdentityPriv(e.recoveryKey, e.keyset);
    expect(toHex(recovered.x25519)).toBe(toHex(e.session.identityPriv));
    expect(toHex(recovered.mlkem)).toBe(toHex(e.session.identityPrivMlkem));
  });
});

describe("items", () => {
  it("encrypts and decrypts an item under a VK", () => {
    const e = enroll(PW, { profile });
    const { vk, keyVersion } = e.personalVaultKey;
    const ref: ItemRef = { vaultId: "v1", itemId: "i1", version: 1, keyVersion };
    const item = {
      type: "login",
      title: "GitHub",
      fields: { username: "me", password: "p@ss", url: "https://github.com" },
    };
    expect(decryptItem(vk, ref, encryptItem(vk, ref, item))).toEqual(item);
  });

  it("rejects decryption with a mismatched item ref (AAD binding)", () => {
    const e = enroll(PW, { profile });
    const { vk } = e.personalVaultKey;
    const ref: ItemRef = { vaultId: "v1", itemId: "i1", version: 1, keyVersion: 1 };
    const enc = encryptItem(vk, ref, { a: "b" });
    expect(() => decryptItem(vk, { ...ref, itemId: "i2" }, enc)).toThrow();
    expect(() => decryptItem(vk, { ...ref, version: 2 }, enc)).toThrow();
  });
});

describe("passkey unlock (PRF-wrapped identity key)", () => {
  it("unwraps the identity key with the same PRF output and rejects a different one", () => {
    const e = enroll(PW, { profile });
    const prf = randomBytes(32); // simulated WebAuthn PRF output
    const wrapped = wrapIdentityForPasskey(e.session.identityPriv, prf);
    expect(toHex(unwrapIdentityFromPasskey(wrapped, prf))).toBe(toHex(e.session.identityPriv));
    expect(() => unwrapIdentityFromPasskey(wrapped, randomBytes(32))).toThrow();
  });
});

describe("VK rotation (IK re-wrap, payload untouched)", () => {
  it("re-wraps the IK to a new VK version and decrypts without re-encrypting the payload", () => {
    const oldVk = createVaultKey(1);
    const newVk = createVaultKey(2);
    const ref = { vaultId: "v1", itemId: "i1", version: 1, keyVersion: 1 };
    const item = { type: "secret", key: "API_KEY", value: "sk-live" };
    const enc = encryptItem(oldVk.vk, ref, item);

    const rewrapped = rewrapItemKey(
      oldVk.vk,
      newVk.vk,
      { vaultId: "v1", itemId: "i1", oldKeyVersion: 1, newKeyVersion: 2 },
      enc.wrappedItemKey,
    );

    // new VK + new keyVersion decrypts the SAME payload ciphertext
    expect(
      decryptItem(
        newVk.vk,
        { vaultId: "v1", itemId: "i1", version: 1, keyVersion: 2 },
        { ciphertext: enc.ciphertext, wrappedItemKey: rewrapped },
      ),
    ).toEqual(item);

    // the old VK can no longer open the re-wrapped IK
    expect(() =>
      decryptItem(
        oldVk.vk,
        { vaultId: "v1", itemId: "i1", version: 1, keyVersion: 2 },
        { ciphertext: enc.ciphertext, wrappedItemKey: rewrapped },
      ),
    ).toThrow();
  });
});

describe("vault key grants (post-quantum hybrid)", () => {
  it("wraps a VK to a member's hybrid identity; member opens, non-member cannot", () => {
    const admin = enroll(PW, { profile });
    const member = enroll("a different password", { profile });
    const vk = createVaultKey(1);
    const grant = wrapVaultKeyFor(vk.vk, {
      x25519Pub: member.session.identityPub,
      mlkemPub: member.session.identityPubMlkem,
    });
    expect(
      toHex(
        openVaultKeyGrant(grant, {
          x25519Priv: member.session.identityPriv,
          mlkemPriv: member.session.identityPrivMlkem,
        }),
      ),
    ).toBe(toHex(vk.vk));
    expect(() =>
      openVaultKeyGrant(grant, {
        x25519Priv: admin.session.identityPriv,
        mlkemPriv: admin.session.identityPrivMlkem,
      }),
    ).toThrow();
  });
});
