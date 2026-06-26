import { describe, expect, it } from "vitest";
import {
  computeAuthHash,
  createVaultKey,
  decryptItem,
  encryptItem,
  encryptShareWriteBack,
  openShareWriteBack,
  enroll,
  type ItemRef,
  openVaultKeyGrant,
  privAad,
  randomBytes,
  recover,
  recoverIdentityPriv,
  rewrapItemKey,
  toHex,
  unlock,
  unwrapIdentityFromPasskey,
  wrapIdentityForPasskey,
  wrapIdentityMlkemForPasskey,
  unwrapIdentityMlkemFromPasskey,
  wrapSigningForPasskey,
  unwrapSigningFromPasskey,
  wrapVaultKeyFor,
} from "../src";

const PW = "correct horse battery staple";
const profile = "test" as const; // fast Argon2id params for tests only

describe("enroll + unlock", () => {
  it("unlocks with the correct password and recovers the same keys", async () => {
    const e = await enroll(PW, { profile });
    const s = await unlock(PW, e.keyset);
    expect(toHex(s.identityPriv)).toBe(toHex(e.session.identityPriv));
    expect(toHex(s.signingPriv)).toBe(toHex(e.session.signingPriv));
  });

  it("fails to unlock with a wrong password", async () => {
    const e = await enroll(PW, { profile });
    await expect(unlock("wrong password", e.keyset)).rejects.toThrow();
  });

  it("computes an authHash matching the enrolled one", async () => {
    const e = await enroll(PW, { profile });
    expect(await computeAuthHash(PW, e.keyset)).toBe(e.keyset.authHash);
  });
});

describe("master-password recovery (ADR-006)", () => {
  it("re-enrolls under a new password with every public key + key version unchanged", async () => {
    const e = await enroll("old-master-password", { profile: "test" });
    const r = await recover(e.recoveryKey, e.keyset, "brand-new-master-password", { profile: "test" });

    // Pubs + key version are byte-identical — recovery never rotates the identity.
    expect(r.keyset.identityPublicKey).toBe(e.keyset.identityPublicKey);
    expect(r.keyset.identityPublicKeyMlkem).toBe(e.keyset.identityPublicKeyMlkem);
    expect(r.keyset.signingPublicKey).toBe(e.keyset.signingPublicKey);
    expect(r.keyset.keyVersion).toBe(e.keyset.keyVersion);

    // The wrapping layer is new (fresh salts) and the recovery key rotated.
    expect(r.keyset.saltMk).not.toBe(e.keyset.saltMk);
    expect(r.recoveryKey).not.toBe(e.recoveryKey);
    expect(r.keyset.encSigningPrivRecovery).toBeDefined();

    // The returned session holds the SAME private keys as the original enrollment.
    expect(toHex(r.session.identityPriv)).toBe(toHex(e.session.identityPriv));
    expect(toHex(r.session.signingPriv)).toBe(toHex(e.session.signingPriv));
  });

  it("the new keyset unlocks with the new password, not the old one", async () => {
    const e = await enroll("old-pw", { profile: "test" });
    const r = await recover(e.recoveryKey, e.keyset, "new-pw", { profile: "test" });

    const s = await unlock("new-pw", r.keyset);
    expect(toHex(s.identityPriv)).toBe(toHex(e.session.identityPriv));
    await expect(unlock("old-pw", r.keyset)).rejects.toThrow();
  });

  it("the rotated recovery key recovers again; the old one no longer matches", async () => {
    const e = await enroll("pw1", { profile: "test" });
    const r1 = await recover(e.recoveryKey, e.keyset, "pw2", { profile: "test" });
    // The new recovery key works against the new keyset…
    const r2 = await recover(r1.recoveryKey, r1.keyset, "pw3", { profile: "test" });
    expect(toHex(r2.session.identityPriv)).toBe(toHex(e.session.identityPriv));
    // …and the old recovery key no longer opens the re-wrapped envelopes.
    await expect(recover(e.recoveryKey, r1.keyset, "pw4", { profile: "test" })).rejects.toThrow();
  });

  it("refuses a keyset with no recovery-wrapped signing key", async () => {
    const e = await enroll("pw", { profile: "test" });
    const legacy = { ...e.keyset, encSigningPrivRecovery: undefined };
    await expect(recover(e.recoveryKey, legacy, "new", { profile: "test" })).rejects.toThrow(/ADR-006/);
  });

  it("recovers both the X25519 and ML-KEM-768 identity privs from the recovery key", async () => {
    const e = await enroll(PW, { profile });
    const recovered = recoverIdentityPriv(e.recoveryKey, e.keyset);
    expect(toHex(recovered.x25519)).toBe(toHex(e.session.identityPriv));
    expect(toHex(recovered.mlkem)).toBe(toHex(e.session.identityPrivMlkem));
  });
});

describe("items", () => {
  it("encrypts and decrypts an item under a VK", async () => {
    const e = await enroll(PW, { profile });
    const { vk, keyVersion } = e.personalVaultKey;
    const ref: ItemRef = { vaultId: "v1", itemId: "i1", version: 1, keyVersion };
    const item = {
      type: "login",
      title: "GitHub",
      fields: { username: "me", password: "p@ss", url: "https://github.com" },
    };
    expect(decryptItem(vk, ref, encryptItem(vk, ref, item))).toEqual(item);
  });

  it("rejects decryption with a mismatched item ref (AAD binding)", async () => {
    const e = await enroll(PW, { profile });
    const { vk } = e.personalVaultKey;
    const ref: ItemRef = { vaultId: "v1", itemId: "i1", version: 1, keyVersion: 1 };
    const enc = encryptItem(vk, ref, { a: "b" });
    expect(() => decryptItem(vk, { ...ref, itemId: "i2" }, enc)).toThrow();
    expect(() => decryptItem(vk, { ...ref, version: 2 }, enc)).toThrow();
  });
});

describe("passkey unlock (PRF-wrapped identity key)", () => {
  it("unwraps the identity key with the same PRF output and rejects a different one", async () => {
    const e = await enroll(PW, { profile });
    const prf = randomBytes(32); // simulated WebAuthn PRF output
    const wrapped = wrapIdentityForPasskey(e.session.identityPriv, prf);
    expect(toHex(unwrapIdentityFromPasskey(wrapped, prf))).toBe(toHex(e.session.identityPriv));
    expect(() => unwrapIdentityFromPasskey(wrapped, randomBytes(32))).toThrow();
  });

  it("wraps + unwraps the ML-KEM identity priv with its own AAD label", async () => {
    const e = await enroll(PW, { profile });
    const prf = randomBytes(32);
    const wrapped = wrapIdentityMlkemForPasskey(e.session.identityPrivMlkem, prf);
    expect(toHex(unwrapIdentityMlkemFromPasskey(wrapped, prf))).toBe(
      toHex(e.session.identityPrivMlkem),
    );
    // Cross-AAD: ML-KEM ciphertext must not open under the X25519 AAD even with the
    // right PRF. The label inside privAad differs ("identity-priv-mlkem" vs
    // "identity-priv"), which is the whole point of the labelled scheme.
    expect(() => unwrapIdentityFromPasskey(wrapped, prf)).toThrow();
  });

  it("wraps + unwraps the signing priv with its own AAD label", async () => {
    const e = await enroll(PW, { profile });
    const prf = randomBytes(32);
    const wrapped = wrapSigningForPasskey(e.session.signingPriv, prf);
    expect(toHex(unwrapSigningFromPasskey(wrapped, prf))).toBe(toHex(e.session.signingPriv));
    expect(() => unwrapIdentityFromPasskey(wrapped, prf)).toThrow();
  });

  it("rejects a wrong PRF on all three wrappers (corrupted authenticator)", async () => {
    const e = await enroll(PW, { profile });
    const good = randomBytes(32);
    const bad = randomBytes(32);
    const w1 = wrapIdentityForPasskey(e.session.identityPriv, good);
    const w2 = wrapIdentityMlkemForPasskey(e.session.identityPrivMlkem, good);
    const w3 = wrapSigningForPasskey(e.session.signingPriv, good);
    expect(() => unwrapIdentityFromPasskey(w1, bad)).toThrow();
    expect(() => unwrapIdentityMlkemFromPasskey(w2, bad)).toThrow();
    expect(() => unwrapSigningFromPasskey(w3, bad)).toThrow();
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

describe("item-share write-back (ADR-007 edit-back extension)", () => {
  it("grantee proposes a new version; granter opens it with their identity priv", async () => {
    const granter = await enroll(PW, { profile });
    const grantee = await enroll("grantee pw", { profile });
    void grantee; // grantee's own keys aren't needed for the proposal — only the granter's pub
    const ref: ItemRef = { vaultId: "v1", itemId: "i1", version: 4, keyVersion: 2 };
    const proposal = { type: "login", title: "GitHub", fields: { password: "rotated!" } };

    const pending = encryptShareWriteBack(
      { x25519Pub: granter.session.identityPub, mlkemPub: granter.session.identityPubMlkem },
      ref,
      proposal,
    );
    const opened = openShareWriteBack(
      { x25519Priv: granter.session.identityPriv, mlkemPriv: granter.session.identityPrivMlkem },
      ref,
      pending,
    );
    expect(opened).toEqual(proposal);
  });

  it("a third party cannot open the proposal; AAD binds it to the item coordinates", async () => {
    const granter = await enroll(PW, { profile });
    const stranger = await enroll("stranger pw", { profile });
    const ref: ItemRef = { vaultId: "v1", itemId: "i1", version: 4, keyVersion: 2 };
    const pending = encryptShareWriteBack(
      { x25519Pub: granter.session.identityPub, mlkemPub: granter.session.identityPubMlkem },
      ref,
      { a: "b" },
    );
    // Wrong identity priv → pqSealOpen fails.
    expect(() =>
      openShareWriteBack(
        { x25519Priv: stranger.session.identityPriv, mlkemPriv: stranger.session.identityPrivMlkem },
        ref,
        pending,
      ),
    ).toThrow();
    // Right identity, transplanted coordinates → AAD failure.
    expect(() =>
      openShareWriteBack(
        { x25519Priv: granter.session.identityPriv, mlkemPriv: granter.session.identityPrivMlkem },
        { ...ref, itemId: "i2" },
        pending,
      ),
    ).toThrow();
  });
});

describe("vault key grants (post-quantum hybrid)", () => {
  it("wraps a VK to a member's hybrid identity; member opens, non-member cannot", async () => {
    const admin = await enroll(PW, { profile });
    const member = await enroll("a different password", { profile });
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

/**
 * MED-G regression (supply-chain audit). docs/03 §3.4 used to say
 * `AAD = userId | keyName | keyVersion` for wrapped private keys, but the actual code
 * binds only `keyName | keyVersion` (+ optional `wrap` discriminator) — `userId` isn't
 * available client-side at enroll time, so binding it is a non-goal in v1 (the docs are
 * now corrected to match). This block pins the wire shape so a future "improvement" that
 * silently re-introduces or removes a field gets caught at test time, not by a Rust
 * verifier discovering it can't reproduce the AAD bytes.
 */
describe("privAad — docs/03 §3.4 wire shape pinned (MED-G)", () => {
  it("identity-priv AAD format (no wrap discriminator)", () => {
    // arc-aad/1 + 3 fields: ("keyName","identity-priv"), ("keyVersion","1")
    expect(privAad("identity-priv", 1)).toBe(
      "arc-aad/1\nkeyName:13:identity-priv\nkeyVersion:1:1",
    );
  });

  it("identity-priv AAD with recovery wrap discriminator", () => {
    expect(privAad("identity-priv", 1, "recovery")).toBe(
      'arc-aad/1\nkeyName:13:identity-priv\nwrap:8:recovery\nkeyVersion:1:1',
    );
  });

  it("does NOT include userId — server assigns it post-enroll (see vault.ts comment)", () => {
    const out = privAad("identity-priv", 1);
    expect(out).not.toContain("userId");
    // Belt + suspenders: the canonical AAD has exactly two fields and no `userId:` row.
    expect(out.split("\n")).toHaveLength(3); // header + 2 fields
  });

  it("changes when keyVersion bumps (so rotated keys can't open old slots)", () => {
    expect(privAad("identity-priv", 1)).not.toBe(privAad("identity-priv", 2));
  });

  it("differs across keyNames so cross-slot opens fail closed", () => {
    expect(privAad("identity-priv", 1)).not.toBe(privAad("identity-priv-mlkem", 1));
    expect(privAad("identity-priv", 1)).not.toBe(privAad("signing-priv", 1));
  });
});
