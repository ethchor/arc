import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type AddressInfo } from "node:net";
import { VaultClient } from "@arc-vault/sdk";
import { generateIdentityKeyPair, toB64u } from "@arc-vault/crypto";
import { AppModule } from "../src/app.module";

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

    // Provision a service account: its identity keypair is generated out-of-band.
    const sa = generateIdentityKeyPair();
    const saBootstrap = new VaultClient({ baseUrl });
    const saIds = await saBootstrap.devLogin("ci-bot@example.com");

    await owner.listVaults();
    await owner.addMember(vault.id, saIds.userId, "viewer", toB64u(sa.pub));

    // The machine client holds ONLY the SA identity key + a token — no password, no Argon2id.
    const machine = new VaultClient({ baseUrl });
    machine.setToken(saIds.token);
    machine.setIdentity(toB64u(sa.priv));
    await machine.listVaults();
    const secrets = await machine.pull(vault.id, 0);
    expect(secrets.items[0]!.data).toMatchObject({ key: "API_KEY", value: "sk-live-xyz" });
  });
});
