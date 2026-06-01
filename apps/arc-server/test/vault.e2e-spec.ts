import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  chainNext,
  computeAuthHash,
  decryptItem,
  encryptItem,
  enroll,
  fromB64u,
  type Keyset,
  mutationDigest,
  openVaultKeyGrant,
  signHead,
  verifyHead,
  wrapVaultKeyFor,
  ZERO_CHAIN,
} from "@arc/crypto";

const hybridPubFrom = (s: ReturnType<typeof enroll>["session"]) => ({
  x25519Pub: s.identityPub,
  mlkemPub: s.identityPubMlkem,
});
const hybridPrivFrom = (s: ReturnType<typeof enroll>["session"]) => ({
  x25519Priv: s.identityPriv,
  mlkemPriv: s.identityPrivMlkem,
});
import { AppModule } from "../src/app.module";

const PW = "correct horse battery staple";
const profile = "test" as const;

function enrollDtoFrom(e: ReturnType<typeof enroll>) {
  return {
    saltMk: e.keyset.saltMk,
    saltAuth: e.keyset.saltAuth,
    argonParams: e.keyset.argonParams,
    authHash: e.keyset.authHash,
    identityPublicKey: e.keyset.identityPublicKey,
    identityPublicKeyMlkem: e.keyset.identityPublicKeyMlkem,
    signingPublicKey: e.keyset.signingPublicKey,
    identitySelfAttestation: e.keyset.identitySelfAttestation,
    encIdentityPriv: e.keyset.encIdentityPriv,
    encIdentityPrivMlkem: e.keyset.encIdentityPrivMlkem,
    encSigningPriv: e.keyset.encSigningPriv,
    encIdentityPrivRecovery: e.keyset.encIdentityPrivRecovery,
    encIdentityPrivMlkemRecovery: e.keyset.encIdentityPrivMlkemRecovery,
    ownerGrant: wrapVaultKeyFor(e.personalVaultKey.vk, hybridPubFrom(e.session)),
  };
}

describe("vault e2e (zero-knowledge round trip)", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  async function login(email: string): Promise<{ token: string; userId: number }> {
    const res = await request(server).post("/auth/dev-login").send({ email }).expect(201);
    return { token: res.body.accessToken, userId: res.body.userId };
  }
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("runs the full enroll -> unlock -> sync -> conflict -> share flow", async () => {
    // --- user A enrolls; re-enroll is refused (anti-takeover) ---
    const A = enroll(PW, { profile });
    const a = await login("a@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(A)).expect(201);
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(A)).expect(409);

    // --- fetch keyset, derive authHash, unlock (wrong password rejected) ---
    const ks = (await request(server).get("/vault/keyset").set(auth(a.token)).expect(200)).body;
    const authHash = computeAuthHash(PW, ks as Keyset);
    await request(server).post("/vault/unlock").set(auth(a.token)).send({ authHash }).expect(201);
    const wrong = computeAuthHash("not the password", ks as Keyset);
    await request(server).post("/vault/unlock").set(auth(a.token)).send({ authHash: wrong }).expect(401);

    // --- list vaults; open the personal VK from the stored grant ---
    const vaults = (await request(server).get("/vaults").set(auth(a.token)).expect(200)).body;
    expect(vaults).toHaveLength(1);
    const vaultId: string = vaults[0].id;
    const vk = openVaultKeyGrant(vaults[0].grant, hybridPrivFrom(A.session));

    // --- create an encrypted item (client-chosen UUID, version 1) ---
    const itemId = randomUUID();
    const item = { type: "login", title: "GitHub", fields: { username: "me", password: "p@ss" } };
    const enc1 = encryptItem(vk, { vaultId, itemId, version: 1, keyVersion: 1 }, item);
    const created = (
      await request(server)
        .post(`/vaults/${vaultId}/items`)
        .set(auth(a.token))
        .send({ id: itemId, ...enc1, vaultKeyVersion: 1, type: "login" })
        .expect(201)
    ).body;
    expect(created.version).toBe(1);

    // --- delta pull + decrypt, server never saw plaintext ---
    const pull = (
      await request(server).get(`/vaults/${vaultId}/items?since=0`).set(auth(a.token)).expect(200)
    ).body;
    expect(pull.items).toHaveLength(1);
    const row = pull.items[0];
    expect(JSON.stringify(row.ciphertext)).not.toContain("p@ss");
    expect(
      decryptItem(
        vk,
        { vaultId, itemId: row.id, version: row.version, keyVersion: row.vaultKeyVersion },
        { ciphertext: row.ciphertext, wrappedItemKey: row.wrappedItemKey },
      ),
    ).toEqual(item);

    // --- update to version 2 ---
    const item2 = { type: "login", title: "GitHub", fields: { username: "me", password: "rotated!" } };
    const enc2 = encryptItem(vk, { vaultId, itemId, version: 2, keyVersion: 1 }, item2);
    const updated = (
      await request(server)
        .post(`/vaults/${vaultId}/items`)
        .set(auth(a.token))
        .send({ id: itemId, ...enc2, vaultKeyVersion: 1, baseVersion: 1, type: "login" })
        .expect(201)
    ).body;
    expect(updated.version).toBe(2);

    // --- stale write -> 409 with current ciphertext ---
    const conflict = await request(server)
      .post(`/vaults/${vaultId}/items`)
      .set(auth(a.token))
      .send({ id: itemId, ...enc2, vaultKeyVersion: 1, baseVersion: 1, type: "login" })
      .expect(409);
    expect(conflict.body.current.version).toBe(2);

    // --- signed vault-head ---
    const chainHash = chainNext(ZERO_CHAIN, mutationDigest(enc2.ciphertext, enc2.wrappedItemKey));
    const ts = new Date().toISOString();
    const headSig = signHead(A.session.signingPriv, { vaultId, seq: updated.seq, chainHash, ts });
    await request(server)
      .put(`/vaults/${vaultId}/head`)
      .set(auth(a.token))
      .send({ seq: updated.seq, chainHash, ts, signature: headSig })
      .expect(200);
    const gotHead = (
      await request(server).get(`/vaults/${vaultId}/head`).set(auth(a.token)).expect(200)
    ).body;
    expect(
      verifyHead(
        A.session.signingPub,
        { vaultId, seq: gotHead.seq, chainHash: gotHead.chainHash, ts: gotHead.ts },
        gotHead.signature,
      ),
    ).toBe(true);

    // --- share to user B as viewer; B decrypts the same item ---
    const B = enroll("a different password", { profile });
    const b = await login("b@example.com");
    await request(server).post("/vault/enroll").set(auth(b.token)).send(enrollDtoFrom(B)).expect(201);

    const bKey = (
      await request(server).get(`/vault/users/${b.userId}/identity-key`).set(auth(a.token)).expect(200)
    ).body;
    const wrappedForB = wrapVaultKeyFor(vk, {
      x25519Pub: fromB64u(bKey.identityPublicKey),
      mlkemPub: fromB64u(bKey.identityPublicKeyMlkem),
    });
    await request(server)
      .post(`/vaults/${vaultId}/members`)
      .set(auth(a.token))
      .send({ userId: b.userId, role: "viewer", keyVersion: 1, wrappedVaultKey: wrappedForB })
      .expect(201);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bVaults = (await request(server).get("/vaults").set(auth(b.token)).expect(200)).body as any[];
    const bVault = bVaults.find((v) => v.id === vaultId);
    expect(bVault).toBeTruthy();
    const bVk = openVaultKeyGrant(bVault.grant, hybridPrivFrom(B.session));
    const bPull = (
      await request(server).get(`/vaults/${vaultId}/items?since=0`).set(auth(b.token)).expect(200)
    ).body;
    const bRow = bPull.items[0];
    expect(
      decryptItem(
        bVk,
        { vaultId, itemId: bRow.id, version: bRow.version, keyVersion: bRow.vaultKeyVersion },
        { ciphertext: bRow.ciphertext, wrappedItemKey: bRow.wrappedItemKey },
      ),
    ).toEqual(item2);

    // --- viewer B cannot write (server RBAC) ---
    const bItemId = randomUUID();
    const bEnc = encryptItem(bVk, { vaultId, itemId: bItemId, version: 1, keyVersion: 1 }, { type: "note", title: "x" });
    await request(server)
      .post(`/vaults/${vaultId}/items`)
      .set(auth(b.token))
      .send({ id: bItemId, ...bEnc, vaultKeyVersion: 1 })
      .expect(403);
  });
});
