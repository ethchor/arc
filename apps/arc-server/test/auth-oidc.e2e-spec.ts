/**
 * End-to-end coverage of production account login (issue #144 / BL-C4) through the real app:
 * `POST /auth/oidc/login` → an arc JWT that actually authorizes `/vault/*`.
 *
 * The ID-token verifier is replaced with a fake so the suite is hermetic (no live IdP); the
 * real JWKS/signature path is `@arc/plugin-oidc`'s own unit tests. What is exercised here is
 * everything arc owns: issuer allowlisting, the `email_verified` requirement, account
 * binding on `(issuer, subject)`, and that the minted token is a working session.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { ID_TOKEN_VERIFIER, type IdTokenVerifier } from "../src/auth/auth.service";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "arc-web";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A syntactically valid unsigned JWS — the fake verifier supplies the trusted claims. */
const idToken = (payload: Record<string, unknown>) =>
  `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;

const claimsFor = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  sub: "idp-user-1",
  aud: AUDIENCE,
  email: "alice@example.com",
  email_verified: true,
  ...over,
});

/** Echoes back whatever claims the presented token carries, after an `aud` check. */
const fakeVerifier: IdTokenVerifier = {
  async verify(tok, expected) {
    const payload = JSON.parse(Buffer.from(tok.split(".")[1] as string, "base64url").toString("utf8"));
    if (payload.aud !== undefined && !expected.audiences.includes(payload.aud)) {
      throw new Error("audience not in boundAudiences");
    }
    if (payload.expired === true) throw new Error("token expired");
    return payload;
  },
};

describe("auth e2e — OIDC account login (#144)", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const k of ["ARC_OIDC_ISSUERS", "ARC_OIDC_AUDIENCES"]) saved[k] = process.env[k];
    process.env.ARC_OIDC_ISSUERS = ISSUER;
    process.env.ARC_OIDC_AUDIENCES = AUDIENCE;

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ID_TOKEN_VERIFIER)
      .useValue(fakeVerifier)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("exchanges a verified ID token for a usable arc session", async () => {
    const res = await request(server)
      .post("/auth/oidc/login")
      .send({ idToken: idToken(claimsFor()) })
      .expect(200);
    const body = res.body as { accessToken: string; userId: number; email: string };
    expect(body.email).toBe("alice@example.com");
    expect(typeof body.accessToken).toBe("string");

    // The minted token is a real session: an authenticated route no longer 401s.
    const me = await request(server).get("/vault/keyset").set({ Authorization: `Bearer ${body.accessToken}` });
    expect(me.status).not.toBe(401);
  });

  it("is idempotent — the same identity returns the same account", async () => {
    const a = await request(server).post("/auth/oidc/login").send({ idToken: idToken(claimsFor()) }).expect(200);
    const b = await request(server).post("/auth/oidc/login").send({ idToken: idToken(claimsFor()) }).expect(200);
    expect(b.body.userId).toBe(a.body.userId);
  });

  it("keeps the account when the IdP reports a new email for the same subject", async () => {
    const first = await request(server)
      .post("/auth/oidc/login")
      .send({ idToken: idToken(claimsFor({ sub: "idp-user-moved", email: "before@example.com" })) })
      .expect(200);
    const second = await request(server)
      .post("/auth/oidc/login")
      .send({ idToken: idToken(claimsFor({ sub: "idp-user-moved", email: "after@example.com" })) })
      .expect(200);
    expect(second.body.userId).toBe(first.body.userId);
    expect(second.body.email).toBe("after@example.com");
  });

  it("rejects an unverified email (401)", async () => {
    await request(server)
      .post("/auth/oidc/login")
      .send({ idToken: idToken(claimsFor({ sub: "unverified-1", email_verified: false })) })
      .expect(401);
  });

  it("rejects an issuer outside the allowlist (401)", async () => {
    await request(server)
      .post("/auth/oidc/login")
      .send({ idToken: idToken(claimsFor({ iss: "https://evil.example" })) })
      .expect(401);
  });

  it("rejects a token minted for another client at the same issuer (401)", async () => {
    await request(server)
      .post("/auth/oidc/login")
      .send({ idToken: idToken(claimsFor({ aud: "some-other-app" })) })
      .expect(401);
  });

  it("rejects an expired token (401)", async () => {
    await request(server)
      .post("/auth/oidc/login")
      .send({ idToken: idToken(claimsFor({ expired: true })) })
      .expect(401);
  });

  it("rejects a malformed body (400)", async () => {
    await request(server).post("/auth/oidc/login").send({ idToken: "nope" }).expect(400);
    await request(server).post("/auth/oidc/login").send({}).expect(400);
  });

  it("refuses to hand a dev-login account to an OIDC identity (409)", async () => {
    // dev-login creates an *unbound* row; adopting it automatically is the takeover #144 closes.
    await request(server).post("/auth/dev-login").send({ email: "legacy@example.com" }).expect(201);
    await request(server)
      .post("/auth/oidc/login")
      .send({ idToken: idToken(claimsFor({ sub: "claimer-1", email: "legacy@example.com" })) })
      .expect(409);
  });
});
