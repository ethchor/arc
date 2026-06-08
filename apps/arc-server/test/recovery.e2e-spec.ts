import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type AddressInfo } from "node:net";
import { VaultClient } from "@arc/sdk";
import { AppModule } from "../src/app.module";

/**
 * Master-password recovery (ADR-006) end-to-end through the real server + SDK. Proves:
 *  - a user who forgot their master password recovers with the recovery key and a new
 *    password, and regains access to data stored before recovery (identity is unchanged);
 *  - the new password unlocks, the old one doesn't;
 *  - the recovery key rotates (the old one is stale after recovery);
 *  - the server pins the identity public keys — a recover that changes one is rejected 400.
 */
describe("master-password recovery (ADR-006)", () => {
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

  it("recovers access with the recovery key + a new password; old data still decrypts", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("recover-me@example.com");
    const { recoveryKey } = await A.enroll("original-master-pw");

    const vault = await A.createVault("team");
    await A.putItem(vault.id, { type: "secret", key: "API_KEY", value: "sk-live-123" }, { type: "secret" });

    // Forgot the password. New session: log into the account, recover with the key.
    const B = new VaultClient({ baseUrl, profile: "test" });
    await B.devLogin("recover-me@example.com");
    const { recoveryKey: rotated } = await B.recoverWithKey(recoveryKey, "a-brand-new-master-pw");
    expect(rotated).toMatch(/[A-Z2-7]{4}-/);
    expect(rotated).not.toBe(recoveryKey);

    // Recovery left B unlocked with the SAME identity → the pre-recovery secret decrypts.
    await B.listVaults();
    const pulled = await B.pull(vault.id, 0);
    expect(pulled.items[0]!.data).toMatchObject({ key: "API_KEY", value: "sk-live-123" });

    // A fresh client unlocks with the NEW password, not the old one.
    const C = new VaultClient({ baseUrl, profile: "test" });
    await C.devLogin("recover-me@example.com");
    await C.unlock("a-brand-new-master-pw");
    await C.listVaults();
    expect((await C.pull(vault.id, 0)).items[0]!.data).toMatchObject({ value: "sk-live-123" });

    const D = new VaultClient({ baseUrl, profile: "test" });
    await D.devLogin("recover-me@example.com");
    await expect(D.unlock("original-master-pw")).rejects.toThrow();
  });

  it("rotates the recovery key: the old one is stale, the new one works", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("rotate-recovery@example.com");
    const { recoveryKey: rk1 } = await A.enroll("pw1");

    const B = new VaultClient({ baseUrl, profile: "test" });
    await B.devLogin("rotate-recovery@example.com");
    const { recoveryKey: rk2 } = await B.recoverWithKey(rk1, "pw2");

    // The OLD recovery key no longer matches the re-wrapped envelopes.
    const C = new VaultClient({ baseUrl, profile: "test" });
    await C.devLogin("rotate-recovery@example.com");
    await expect(C.recoverWithKey(rk1, "pw3")).rejects.toThrow();

    // The NEW recovery key recovers again.
    const D = new VaultClient({ baseUrl, profile: "test" });
    await D.devLogin("rotate-recovery@example.com");
    const { recoveryKey: rk3 } = await D.recoverWithKey(rk2, "pw3");
    expect(rk3).not.toBe(rk2);
  });

  it("pins the identity public keys — a recover that changes one is rejected (anti-takeover)", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    const { userId } = await A.devLogin("pin-test@example.com");
    void userId;
    await A.enroll("pw");

    const token = (await A.devLogin("pin-test@example.com")).token;
    const env = { v: 1, alg: "x", n: "00", ct: "00", aad: "00" };
    // A structurally-valid recover body but with a swapped identity public key → 400 before
    // any crypto runs (the server pins the pubs).
    const res = await fetch(`${baseUrl}/vault/keyset/recover`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        saltMk: "AA", saltAuth: "BB", argonParams: { m: 1, t: 1, p: 1 }, authHash: "00",
        identityPublicKey: "ATTACKER-SWAPPED-PUBKEY",
        identityPublicKeyMlkem: "x", signingPublicKey: "y", identitySelfAttestation: "{}",
        encIdentityPriv: env, encIdentityPrivMlkem: env, encSigningPriv: env,
        encIdentityPrivRecovery: env, encIdentityPrivMlkemRecovery: env, encSigningPrivRecovery: env,
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("identity_pubkey_mismatch");
  });
});
