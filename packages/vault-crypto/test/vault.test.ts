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
  it("recovers the identity key from the recovery key", () => {
    const e = enroll(PW, { profile });
    expect(toHex(recoverIdentityPriv(e.recoveryKey, e.keyset))).toBe(
      toHex(e.session.identityPriv),
    );
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

describe("vault key grants", () => {
  it("wraps a VK to a member who opens it; others cannot", () => {
    const admin = enroll(PW, { profile });
    const member = enroll("a different password", { profile });
    const vk = createVaultKey(1);
    const grant = wrapVaultKeyFor(vk.vk, member.session.identityPub);
    expect(toHex(openVaultKeyGrant(grant, member.session.identityPriv))).toBe(toHex(vk.vk));
    expect(() => openVaultKeyGrant(grant, admin.session.identityPriv)).toThrow();
  });
});
