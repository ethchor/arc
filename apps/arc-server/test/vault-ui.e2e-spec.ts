import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { enroll, wrapVaultKeyFor } from "@arc/crypto";
import { VAULT_COLORS, VAULT_ICONS } from "@arc/types";
import { AppModule } from "../src/app.module";

const PW = "correct horse battery staple";
const profile = "test" as const;

const hybridPubFrom = (s: Awaited<ReturnType<typeof enroll>>["session"]) => ({
  x25519Pub: s.identityPub,
  mlkemPub: s.identityPubMlkem,
});

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
    ownerGrant: wrapVaultKeyFor(e.personalVaultKey.vk, hybridPubFrom(e.session)),
  };
}

describe("vault UI affordances (icon + color)", () => {
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

  it("persists icon + color on create and round-trips through listVaults", async () => {
    const A = await enroll(PW, { profile });
    const a = await login("alice-ui@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(A)).expect(201);

    // Owner creates a vault picking an icon + colour from the closed allowlists.
    const create = await request(server)
      .post("/vaults")
      .set(auth(a.token))
      .send({
        type: "team",
        ownerGrant: wrapVaultKeyFor(A.personalVaultKey.vk, hybridPubFrom(A.session)),
        icon: VAULT_ICONS[2], // "lock"
        color: VAULT_COLORS[4], // "#F97316" orange
      })
      .expect(201);

    expect(create.body.icon).toBe(VAULT_ICONS[2]);
    expect(create.body.color).toBe(VAULT_COLORS[4]);

    const list = await request(server).get("/vaults").set(auth(a.token)).expect(200);
    const v = list.body.find((x: { id: string }) => x.id === create.body.id);
    expect(v.icon).toBe(VAULT_ICONS[2]);
    expect(v.color).toBe(VAULT_COLORS[4]);
  });

  it("rejects icons + colors that aren't on the allowlist with 400", async () => {
    const B = await enroll(PW, { profile });
    const b = await login("bob-ui@example.com");
    await request(server).post("/vault/enroll").set(auth(b.token)).send(enrollDtoFrom(B)).expect(201);

    const bad = await request(server)
      .post("/vaults")
      .set(auth(b.token))
      .send({
        type: "team",
        ownerGrant: wrapVaultKeyFor(B.personalVaultKey.vk, hybridPubFrom(B.session)),
        icon: "<script>alert(1)</script>",
      })
      .expect(400);
    expect(bad.body.error).toBe("invalid_icon");

    const badColor = await request(server)
      .post("/vaults")
      .set(auth(b.token))
      .send({
        type: "team",
        ownerGrant: wrapVaultKeyFor(B.personalVaultKey.vk, hybridPubFrom(B.session)),
        color: "javascript:void(0)",
      })
      .expect(400);
    expect(badColor.body.error).toBe("invalid_color");
  });

  it("PATCH /vaults/:id/ui updates icon + color; null clears; admin role required", async () => {
    const C = await enroll(PW, { profile });
    const c = await login("carol-ui@example.com");
    await request(server).post("/vault/enroll").set(auth(c.token)).send(enrollDtoFrom(C)).expect(201);

    const create = await request(server)
      .post("/vaults")
      .set(auth(c.token))
      .send({
        type: "team",
        ownerGrant: wrapVaultKeyFor(C.personalVaultKey.vk, hybridPubFrom(C.session)),
      })
      .expect(201);
    const vaultId = create.body.id;

    // Owner (which is admin-or-higher) sets both, then clears the icon while keeping the
    // colour — the "undefined leaves it, null clears it" semantics.
    const set = await request(server)
      .patch(`/vaults/${vaultId}/ui`)
      .set(auth(c.token))
      .send({ icon: "key", color: VAULT_COLORS[0] })
      .expect(200);
    expect(set.body).toMatchObject({ id: vaultId, icon: "key", color: VAULT_COLORS[0] });

    const partial = await request(server)
      .patch(`/vaults/${vaultId}/ui`)
      .set(auth(c.token))
      .send({ icon: null })
      .expect(200);
    expect(partial.body.icon).toBeNull();
    expect(partial.body.color).toBe(VAULT_COLORS[0]);

    // Allowlist still enforced on PATCH.
    await request(server)
      .patch(`/vaults/${vaultId}/ui`)
      .set(auth(c.token))
      .send({ color: "#deadbeef" })
      .expect(400);
  });
});
