import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type AddressInfo } from "node:net";
import { VaultClient } from "@arc/sdk";
import { generateHybridIdentityKeyPair, generateIdentityKeyPair, toB64u } from "@arc/crypto";
import { AppModule } from "../src/app.module";

/**
 * Seed a service-account user's hybrid identity public keys directly into the server.
 * In production this is the output of a service-account onboarding API; the e2e doesn't
 * exercise that path, so we reach into the data source instead.
 */
async function ownerSeedIdentity(
  app: INestApplication,
  userId: number,
  pubs: { identityPublicKey: string; identityPublicKeyMlkem: string },
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DataSource } = require("typeorm");
  const ds = app.get(DataSource);
  await ds.query(
    `INSERT INTO vault_user_keys (
       "userId", "saltMk", "saltAuth", "argonParams", "authHashStored", "serverSalt",
       "identityPublicKey", "identityPublicKeyMlkem", "signingPublicKey",
       "identitySelfAttestation", "encIdentityPriv", "encIdentityPrivMlkem",
       "encSigningPriv", "encIdentityPrivRecovery", "encIdentityPrivMlkemRecovery",
       "keyVersion", "createdAt"
     ) VALUES (?, '', '', '{}', '', '', ?, ?, '', '{}', '{}', '{}', '{}', '{}', '{}', 1, datetime('now'))`,
    [userId, pubs.identityPublicKey, pubs.identityPublicKeyMlkem],
  );
}

describe("vault SDK e2e (consumer + service account)", () => {
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

  it("consumer: enroll, store a secret, and re-read it from a fresh unlocked client", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("alice@example.com");
    const { recoveryKey } = await A.enroll("master-password-A");
    expect(recoveryKey).toMatch(/[A-Z2-7]{4}-/);

    const vault = await A.createVault("team");
    await A.putItem(
      vault.id,
      { type: "secret", key: "DATABASE_URL", value: "postgres://secret" },
      { type: "secret" },
    );

    const pulled = await A.pull(vault.id, 0);
    expect(pulled.items).toHaveLength(1);
    expect(pulled.items[0]!.data).toMatchObject({ key: "DATABASE_URL", value: "postgres://secret" });

    const A2 = new VaultClient({ baseUrl, profile: "test" });
    await A2.devLogin("alice@example.com");
    await A2.unlock("master-password-A");
    await A2.listVaults();
    const reread = await A2.pull(vault.id, 0);
    expect(reread.items[0]!.data).toMatchObject({ value: "postgres://secret" });

    // Audit log records the activity from the original session. Server returns
    // newest-first; we should see at least the item_created and vault_created actions
    // for this vault, and they should be metadata-only (no plaintext leak).
    const audit = await A2.listAudit(vault.id, { limit: 20 });
    expect(audit.length).toBeGreaterThanOrEqual(2);
    const actions = audit.map((e) => e.action);
    expect(actions).toContain("vault_created");
    expect(actions).toContain("item_created");
    // No event body should carry the ciphertext or the plaintext.
    const blob = JSON.stringify(audit);
    expect(blob).not.toContain("postgres://secret");
    expect(blob).not.toContain("ciphertext");
  });

  it("vault name survives a key rotation (regression: encName was sealed under the old VK)", async () => {
    const C = new VaultClient({ baseUrl, profile: "test" });
    await C.devLogin("naming@example.com");
    await C.enroll("master-password-N");

    const v = await C.createVault("team", "Engineering");
    expect((await C.listVaults()).find((x) => x.id === v.id)?.name).toBe("Engineering");

    // Rotating re-keys the vault. Before the fix the name was left sealed under the old VK,
    // so it stopped decrypting and the UI fell back to the vault type ("team"). It must
    // round-trip the rotation unchanged.
    await C.rotateForAllMembers(v.id);
    expect((await C.listVaults()).find((x) => x.id === v.id)?.name).toBe("Engineering");
  });

  it("revoke member: removeMember drops the membership and re-keys the vault", async () => {
    const owner = new VaultClient({ baseUrl, profile: "test" });
    await owner.devLogin("revoker@example.com");
    await owner.enroll("master-owner");

    const member = new VaultClient({ baseUrl, profile: "test" });
    await member.devLogin("revokee@example.com");
    await member.enroll("master-member");

    const v = await owner.createVault("team", "Shared");
    const mk = await owner.getUserIdentityKeyByEmail("revokee@example.com");
    await owner.addMember(v.id, mk.userId, "editor", {
      identityPubB64: mk.identityPublicKey,
      identityPubMlkemB64: mk.identityPublicKeyMlkem,
    });
    expect((await owner.listMembers(v.id)).map((m) => m.userId)).toContain(mk.userId);

    // Revoke re-keys the vault (keyVersion bumps) and drops the member from the access list.
    const { keyVersion } = await owner.removeMember(v.id, mk.userId);
    expect(keyVersion).toBe(2);
    expect((await owner.listMembers(v.id)).map((m) => m.userId)).not.toContain(mk.userId);

    // Can't revoke yourself (would orphan the vault / break the follow-on re-key).
    await expect(owner.removeMember(v.id, owner.currentUserId!)).rejects.toThrow();
  });

  it("service account: a machine identity reads a granted vault with no master password", async () => {
    const owner = new VaultClient({ baseUrl, profile: "test" });
    await owner.devLogin("owner@example.com");
    await owner.enroll("master-password-owner");
    const vault = await owner.createVault("team");
    await owner.putItem(
      vault.id,
      { type: "secret", key: "API_KEY", value: "sk-live-xyz" },
      { type: "secret" },
    );

    // Provision a service account: its hybrid identity keypair is generated out-of-band.
    // SAs use the same X25519 + ML-KEM-768 identity as consumer users so they receive
    // post-quantum-resistant VK grants (ADR-002).
    const saEc = generateIdentityKeyPair();
    const saHybrid = generateHybridIdentityKeyPair();
    const saBootstrap = new VaultClient({ baseUrl });
    const saIds = await saBootstrap.devLogin("ci-bot@example.com");
    // The service-account record on the server must publish both pubs so the owner can
    // wrap to the hybrid identity. In a real provisioning flow this happens via a separate
    // service-account onboarding API; here we reach into the test app to seed it.
    await ownerSeedIdentity(app, saIds.userId, {
      identityPublicKey: toB64u(saEc.pub),
      identityPublicKeyMlkem: toB64u(saHybrid.mlkem.publicKey),
    });

    await owner.listVaults();
    const saKey = await owner.getUserIdentityKey(saIds.userId);
    await owner.addMember(vault.id, saIds.userId, "viewer", {
      identityPubB64: saKey.identityPublicKey,
      identityPubMlkemB64: saKey.identityPublicKeyMlkem,
    });

    // The machine client holds the SA hybrid identity + a token — no password, no Argon2id.
    const machine = new VaultClient({ baseUrl });
    machine.setToken(saIds.token);
    machine.setIdentity({
      identityPrivB64: toB64u(saEc.priv),
      identityPrivMlkemB64: toB64u(saHybrid.mlkem.secretKey),
    });
    await machine.listVaults();
    const secrets = await machine.pull(vault.id, 0);
    expect(secrets.items[0]!.data).toMatchObject({ key: "API_KEY", value: "sk-live-xyz" });
  });

  it("VK rotation revokes a removed member's access to the new key version", async () => {
    const owner = new VaultClient({ baseUrl, profile: "test" });
    const o = await owner.devLogin("rot-owner@example.com");
    await owner.enroll("owner-pw");
    const vault = await owner.createVault("team");
    await owner.putItem(vault.id, { type: "secret", key: "K", value: "v1-secret" }, { type: "secret" });

    // add member B at key version 1
    const B = new VaultClient({ baseUrl, profile: "test" });
    const b = await B.devLogin("rot-b@example.com");
    await B.enroll("b-pw");
    await owner.listVaults();
    const bKey = await owner.getUserIdentityKey(b.userId);
    await owner.addMember(vault.id, b.userId, "viewer", {
      identityPubB64: bKey.identityPublicKey,
      identityPubMlkemB64: bKey.identityPublicKeyMlkem,
    });

    // B reads at v1
    await B.listVaults();
    expect((await B.pull(vault.id, 0)).items[0]!.data).toMatchObject({ value: "v1-secret" });

    // owner rotates the VK, granting only itself (B excluded)
    await owner.listVaults();
    await owner.rotateKey(vault.id, [
      {
        userId: o.userId,
        identityPubB64: owner.identityPublicKeyB64!,
        identityPubMlkemB64: owner.identityPublicKeyMlkemB64!,
      },
    ]);

    // owner still reads the same payload (IK re-wrapped, not re-encrypted)
    await owner.listVaults();
    expect((await owner.pull(vault.id, 0)).items[0]!.data).toMatchObject({ value: "v1-secret" });

    // B (fresh client) is still a member but has no current-version grant -> cannot derive VK
    const B2 = new VaultClient({ baseUrl, profile: "test" });
    await B2.devLogin("rot-b@example.com");
    await B2.unlock("b-pw");
    const seen = await B2.listVaults();
    expect(seen.find((v) => v.id === vault.id)).toBeTruthy();
    await expect(B2.pull(vault.id, 0)).rejects.toThrow();
  });
});
