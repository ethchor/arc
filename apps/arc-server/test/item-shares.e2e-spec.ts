import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type AddressInfo } from "node:net";
import { VaultClient } from "@arc/sdk";
import { AppModule } from "../src/app.module";

/**
 * Item-level shares (ADR-007) end-to-end through the real server + SDK. Verifies:
 *  - sharing one item to a non-member: the recipient decrypts that item byte-for-byte and
 *    has no access to anything else in the vault;
 *  - snapshot semantics: an edit by the granter doesn't break the existing share (the
 *    recipient still sees the shared *version*);
 *  - re-share upserts to the new version (no duplicate row);
 *  - revoke (either side) removes the share;
 *  - non-member can't share — the route returns 404 (member-existence is hidden);
 *  - a recipient can't re-share an item they were shared (they aren't a member of the
 *    source vault).
 */
describe("item-level shares (ADR-007)", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it("shares one item to one user; recipient decrypts only that item", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("alice-share@example.com");
    await A.enroll("alice-master-pw");

    const B = new VaultClient({ baseUrl, profile: "test" });
    const { userId: bobId } = await B.devLogin("bob-share@example.com");
    await B.enroll("bob-master-pw");

    // Alice owns a team vault with TWO items. Only one will be shared.
    const vault = await A.createVault("team");
    const shared = await A.putItem(
      vault.id,
      { type: "secret", key: "API_KEY", value: "sk-shared-value" },
      { type: "secret" },
    );
    await A.putItem(
      vault.id,
      { type: "secret", key: "OTHER", value: "do-not-share" },
      { type: "secret" },
    );

    // Share the first item with Bob.
    const share = await A.shareItem(vault.id, shared.id, bobId);
    expect(share.itemId).toBe(shared.id);
    expect(share.granterUserId).not.toBe(bobId);
    expect(share.granteeUserId).toBe(bobId);
    expect(share.permission).toBe("view");
    expect(share.itemVersion).toBe(shared.version);

    // Bob sees exactly one incoming share, decrypts it, and never had vault membership.
    const incoming = await B.listIncomingShares();
    expect(incoming).toHaveLength(1);
    const pt = B.decryptIncomingShare(incoming[0]!);
    expect(pt).toMatchObject({ key: "API_KEY", value: "sk-shared-value" });

    // Bob has no access to the vault itself — he isn't a member.
    expect(await B.listVaults()).toHaveLength(1); // his own personal vault, not Alice's team vault
    expect((await B.listVaults()).find((v) => v.id === vault.id)).toBeUndefined();
  });

  it("snapshot semantics: an edit doesn't break the existing share; re-share refreshes it", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("snap-grant@example.com");
    await A.enroll("pw");
    const B = new VaultClient({ baseUrl, profile: "test" });
    const { userId: bobId } = await B.devLogin("snap-grantee@example.com");
    await B.enroll("pw");

    const vault = await A.createVault("team");
    const item = await A.putItem(vault.id, { type: "secret", key: "K", value: "v1" }, { type: "secret" });
    await A.shareItem(vault.id, item.id, bobId);

    // Alice edits — IK rotates server-side (every encryption uses fresh randomBytes).
    await A.putItem(vault.id, { type: "secret", key: "K", value: "v2" }, { id: item.id, baseVersion: item.version, type: "secret" });

    // Bob's existing share still decrypts the SNAPSHOT (v1) — unchanged.
    let incoming = await B.listIncomingShares();
    expect(incoming).toHaveLength(1);
    expect(B.decryptIncomingShare(incoming[0]!)).toMatchObject({ value: "v1" });

    // Alice re-shares; the row upserts to the new version. Still one row, now v2.
    await A.shareItem(vault.id, item.id, bobId);
    incoming = await B.listIncomingShares();
    expect(incoming).toHaveLength(1);
    expect(B.decryptIncomingShare(incoming[0]!)).toMatchObject({ value: "v2" });
  });

  it("revoke removes the share from the recipient's listing", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("rev-grant@example.com");
    await A.enroll("pw");
    const B = new VaultClient({ baseUrl, profile: "test" });
    const { userId: bobId } = await B.devLogin("rev-grantee@example.com");
    await B.enroll("pw");

    const vault = await A.createVault("team");
    const item = await A.putItem(vault.id, { type: "secret", key: "K", value: "v" }, { type: "secret" });
    const share = await A.shareItem(vault.id, item.id, bobId);
    expect((await B.listIncomingShares())).toHaveLength(1);

    // Granter revokes.
    await A.revokeShare(share.id);
    expect((await B.listIncomingShares())).toHaveLength(0);

    // Grantee revoke also works (re-share, then grantee revokes).
    const share2 = await A.shareItem(vault.id, item.id, bobId);
    expect((await B.listIncomingShares())).toHaveLength(1);
    await B.revokeShare(share2.id);
    expect((await B.listIncomingShares())).toHaveLength(0);
  });

  it("a non-member of the source vault cannot share its items (404, hides existence)", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("owner-only@example.com");
    await A.enroll("pw");
    const vault = await A.createVault("team");
    const item = await A.putItem(vault.id, { type: "secret", key: "K", value: "v" }, { type: "secret" });

    // Eve has a session but isn't a member of Alice's vault. Try to share Alice's item.
    const Eve = new VaultClient({ baseUrl, profile: "test" });
    const { userId: eveId } = await Eve.devLogin("eve@example.com");
    void eveId;
    await Eve.enroll("pw");
    const Target = new VaultClient({ baseUrl, profile: "test" });
    const { userId: targetId } = await Target.devLogin("target@example.com");
    void targetId;
    await Target.enroll("pw");

    await expect(Eve.shareItem(vault.id, item.id, targetId)).rejects.toThrow();
  });

  it("a recipient cannot re-share an item they received (not a member of the source vault)", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("a-orig@example.com");
    await A.enroll("pw");
    const B = new VaultClient({ baseUrl, profile: "test" });
    const { userId: bobId } = await B.devLogin("b-recv@example.com");
    await B.enroll("pw");
    const C = new VaultClient({ baseUrl, profile: "test" });
    const { userId: charlieId } = await C.devLogin("c-third@example.com");
    void charlieId;
    await C.enroll("pw");

    const vault = await A.createVault("team");
    const item = await A.putItem(vault.id, { type: "secret", key: "K", value: "v" }, { type: "secret" });
    await A.shareItem(vault.id, item.id, bobId);
    expect((await B.listIncomingShares())).toHaveLength(1);

    // Bob holds the IK + ciphertext for the item, but he isn't a member of A's vault — so
    // /vaults/<A's vault id>/items/<itemId>/share returns 404 to him.
    await expect(B.shareItem(vault.id, item.id, charlieId)).rejects.toThrow();
  });
});
