/**
 * Account-lifecycle gaps that were documented in doc 09 but had no route:
 * master-password change (§9.2), member role change and vault soft-delete (§9.3).
 *
 * The emphasis is on the authorization rules rather than the happy paths — each of these
 * endpoints can, if it gets them wrong, either lock a user out of their own vault or hand
 * someone else's vault away.
 */
import { randomUUID } from "node:crypto";
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { changeMasterPassword, createVaultKey, enroll, unlock, wrapVaultKeyFor } from "@arc/crypto";
import { AppModule } from "../src/app.module";

const PW = "correct horse battery staple";
const profile = "test" as const;

function enrollDtoFrom(e: Awaited<ReturnType<typeof enroll>>) {
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
    ownerGrant: wrapVaultKeyFor(e.personalVaultKey.vk, {
      x25519Pub: e.session.identityPub,
      mlkemPub: e.session.identityPubMlkem,
    }),
  };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("account lifecycle e2e — password change, role change, vault delete", () => {
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
    await app?.close();
  });

  let seq = 0;
  async function newUser() {
    const email = `lifecycle-${seq++}-${randomUUID()}@example.com`;
    const r = await request(server).post("/auth/dev-login").send({ email }).expect(201);
    return { token: r.body.accessToken as string, userId: r.body.userId as number, email };
  }

  /** `POST /vaults` requires an ownerGrant — a fresh VK wrapped to the creator's identity. */
  async function createVault(u: { token: string; E: Awaited<ReturnType<typeof enroll>> }) {
    const vk = createVaultKey();
    const res = await request(server)
      .post("/vaults")
      .set(auth(u.token))
      .send({
        type: "team",
        ownerGrant: wrapVaultKeyFor(vk.vk, {
          x25519Pub: u.E.session.identityPub,
          mlkemPub: u.E.session.identityPubMlkem,
        }),
      })
      .expect(201);
    return res.body.id as string;
  }

  async function enrolledUser() {
    const u = await newUser();
    const E = await enroll(PW, { profile });
    await request(server).post("/vault/enroll").set(auth(u.token)).send(enrollDtoFrom(E)).expect(201);
    return { ...u, E };
  }

  // --- master-password change (doc 05 §5.3) ---

  describe("PUT /vault/keyset", () => {
    it("changes the password and leaves the keyset unlockable with the new one", async () => {
      const u = await enrolledUser();
      const keyset = (await request(server).get("/vault/keyset").set(auth(u.token)).expect(200)).body;

      const change = await changeMasterPassword(PW, "a-brand-new-password", keyset, { profile });
      await request(server)
        .put("/vault/keyset")
        .set(auth(u.token))
        .send({
          currentAuthHash: change.currentAuthHash,
          saltMk: change.saltMk,
          saltAuth: change.saltAuth,
          argonParams: change.argonParams,
          authHash: change.authHash,
          identityPublicKey: keyset.identityPublicKey,
          identityPublicKeyMlkem: keyset.identityPublicKeyMlkem,
          signingPublicKey: keyset.signingPublicKey,
          encIdentityPriv: change.encIdentityPriv,
          encIdentityPrivMlkem: change.encIdentityPrivMlkem,
          encSigningPriv: change.encSigningPriv,
        })
        .expect(200);

      // The stored keyset now opens with the NEW password and yields the SAME identity.
      const after = (await request(server).get("/vault/keyset").set(auth(u.token)).expect(200)).body;
      const session = await unlock("a-brand-new-password", after);
      expect(Buffer.from(session.signingPub).toString("base64url")).toBe(keyset.signingPublicKey);
    });

    it("refuses without proof of the CURRENT password — a valid JWT is not enough", async () => {
      const u = await enrolledUser();
      const keyset = (await request(server).get("/vault/keyset").set(auth(u.token))).body;
      const change = await changeMasterPassword(PW, "irrelevant", keyset, { profile });

      // doc 06 §6.7: changing the master password requires unlocking the existing keyset.
      await request(server)
        .put("/vault/keyset")
        .set(auth(u.token))
        .send({
          currentAuthHash: "not-the-right-hash",
          saltMk: change.saltMk,
          saltAuth: change.saltAuth,
          argonParams: change.argonParams,
          authHash: change.authHash,
          identityPublicKey: keyset.identityPublicKey,
          identityPublicKeyMlkem: keyset.identityPublicKeyMlkem,
          signingPublicKey: keyset.signingPublicKey,
          encIdentityPriv: change.encIdentityPriv,
          encIdentityPrivMlkem: change.encIdentityPrivMlkem,
          encSigningPriv: change.encSigningPriv,
        })
        .expect(401);

      // And the original password still works — a failed attempt changed nothing.
      const after = (await request(server).get("/vault/keyset").set(auth(u.token))).body;
      await expect(unlock(PW, after)).resolves.toBeDefined();
    });

    it("refuses to swap the identity while re-wrapping", async () => {
      const u = await enrolledUser();
      const keyset = (await request(server).get("/vault/keyset").set(auth(u.token))).body;
      const change = await changeMasterPassword(PW, "another-password", keyset, { profile });
      const attacker = await enroll("attacker-pw", { profile });

      await request(server)
        .put("/vault/keyset")
        .set(auth(u.token))
        .send({
          currentAuthHash: change.currentAuthHash,
          saltMk: change.saltMk,
          saltAuth: change.saltAuth,
          argonParams: change.argonParams,
          authHash: change.authHash,
          // Pinned fields must match the stored keyset; this is the anti-takeover check.
          identityPublicKey: enrollDtoFrom(attacker).identityPublicKey,
          identityPublicKeyMlkem: keyset.identityPublicKeyMlkem,
          signingPublicKey: keyset.signingPublicKey,
          encIdentityPriv: change.encIdentityPriv,
          encIdentityPrivMlkem: change.encIdentityPrivMlkem,
          encSigningPriv: change.encSigningPriv,
        })
        .expect(400);
    });
  });

  // --- member role change (doc 09 §9.3) ---

  describe("PATCH /vaults/:id/members/:userId", () => {
    async function vaultWithMember() {
      const owner = await enrolledUser();
      const member = await enrolledUser();
      const vaultId = await createVault(owner);
      await request(server)
        .post(`/vaults/${vaultId}/members`)
        .set(auth(owner.token))
        .send({ userId: member.userId, role: "viewer", keyVersion: 1, wrappedVaultKey: { v: 1 } })
        .expect(201);
      return { owner, member, vaultId };
    }

    it("promotes and demotes an existing member without re-adding them", async () => {
      const { owner, member, vaultId } = await vaultWithMember();
      const res = await request(server)
        .patch(`/vaults/${vaultId}/members/${member.userId}`)
        .set(auth(owner.token))
        .send({ role: "editor" })
        .expect(200);
      expect(res.body).toMatchObject({ ok: true, role: "editor" });

      const members = await request(server).get(`/vaults/${vaultId}/members`).set(auth(owner.token));
      expect(members.body.find((m: { userId: number }) => m.userId === member.userId).role).toBe("editor");
    });

    it("refuses an unknown role", async () => {
      const { owner, member, vaultId } = await vaultWithMember();
      await request(server)
        .patch(`/vaults/${vaultId}/members/${member.userId}`)
        .set(auth(owner.token))
        .send({ role: "superuser" })
        .expect(400);
    });

    it("refuses self-demotion — the one-call way to lock yourself out", async () => {
      const { owner, vaultId } = await vaultWithMember();
      await request(server)
        .patch(`/vaults/${vaultId}/members/${owner.userId}`)
        .set(auth(owner.token))
        .send({ role: "viewer" })
        .expect(400);
    });

    it("refuses a non-admin caller", async () => {
      const { member, vaultId } = await vaultWithMember();
      await request(server)
        .patch(`/vaults/${vaultId}/members/${member.userId}`)
        .set(auth(member.token))
        .send({ role: "admin" })
        .expect(403);
    });
  });

  // --- vault soft-delete (doc 09 §9.3) ---

  describe("DELETE /vaults/:id", () => {
    it("soft-deletes the vault so it disappears from the owner's list", async () => {
      const owner = await enrolledUser();
      const vaultId = await createVault(owner);

      await request(server).delete(`/vaults/${vaultId}`).set(auth(owner.token)).expect(200);

      const list = await request(server).get("/vaults").set(auth(owner.token)).expect(200);
      expect(list.body.map((x: { id: string }) => x.id)).not.toContain(vaultId);
    });

    it("refuses a non-owner", async () => {
      const owner = await enrolledUser();
      const other = await enrolledUser();
      const vaultId = await createVault(owner);
      await request(server)
        .post(`/vaults/${vaultId}/members`)
        .set(auth(owner.token))
        .send({ userId: other.userId, role: "admin", keyVersion: 1, wrappedVaultKey: { v: 1 } })
        .expect(201);

      // Even an admin cannot delete the vault — owner only.
      await request(server).delete(`/vaults/${vaultId}`).set(auth(other.token)).expect(403);
    });
  });
});
