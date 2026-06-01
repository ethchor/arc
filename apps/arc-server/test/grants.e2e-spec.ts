/**
 * End-to-end coverage of the per-mount ACL on `/v1/*`. Boots the real app with
 * `ARC_DEFAULT_POLICY=deny` (the production posture), then verifies:
 *
 *  - A user with no attached policies gets 403 on any `/v1` path (sys + mount).
 *  - Attaching a scoped policy unlocks exactly the paths + capabilities it covers, and
 *    nothing more (uncovered capability + uncovered path both 403).
 *  - `?list=true` requires the `list` capability — `read` alone isn't enough.
 *  - Non-`/v1` routes (the existing Engine-B vault API) are unaffected by the guard.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { scope } from "@arc/grants";
import { AppModule } from "../src/app.module";
import { GrantsService } from "../src/grants/grants.service";

async function login(server: unknown, email: string): Promise<{ token: string; userId: number }> {
  const res = await request(server as Parameters<typeof request>[0])
    .post("/auth/dev-login")
    .send({ email })
    .expect(201);
  // dev-login returns the JWT but not the user id directly; the JWT payload carries
  // userId. Decode without verification (the test only needs the subject).
  const body = res.body as { accessToken: string };
  const payload = JSON.parse(
    Buffer.from(body.accessToken.split(".")[1]!, "base64").toString("utf8"),
  ) as { sub: number };
  return { token: body.accessToken, userId: payload.sub };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("grants e2e — ARC_DEFAULT_POLICY=deny enforces per-mount ACL", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let grants: GrantsService;
  let token: string;
  let userId: number;

  beforeAll(async () => {
    const saved = process.env.ARC_DEFAULT_POLICY;
    process.env.ARC_DEFAULT_POLICY = "deny";
    try {
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      server = app.getHttpServer();
      grants = app.get(GrantsService);
      const session = await login(server, "grants-e2e@example.com");
      token = session.token;
      userId = session.userId;
    } finally {
      if (saved === undefined) delete process.env.ARC_DEFAULT_POLICY;
      else process.env.ARC_DEFAULT_POLICY = saved;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("denies a user with no policies under default-deny mode (any /v1 path)", async () => {
    expect(grants.defaultMode).toBe("deny");
    await request(server).get("/v1/sys/mounts").set(auth(token)).expect(403);
    await request(server).get("/v1/secret/data/x").set(auth(token)).expect(403);
  });

  it("does NOT block non-/v1 routes — Engine-B's vault API still works", async () => {
    // The vault endpoints have their own membership ACL in VaultService.
    await request(server).get("/vaults").set(auth(token)).expect(200);
  });

  it("allows exactly the scoped paths once a policy is attached", async () => {
    await grants.upsertPolicy({
      name: "reader",
      scopes: [scope("sys/", ["read"])],
    });
    await grants.attach(String(userId), "reader");

    // Covered: GET /v1/sys/mounts — read on sys/
    await request(server).get("/v1/sys/mounts").set(auth(token)).expect(200);
    // Uncovered path: secret/ — still 403
    await request(server).get("/v1/secret/data/x").set(auth(token)).expect(403);
  });

  it("denies a capability the policy doesn't grant (delete on a read-only scope)", async () => {
    // Same user from the previous test still has the `reader` policy attached, which
    // grants only `read`. A DELETE on the same prefix should be denied.
    await request(server).delete("/v1/sys/mounts").set(auth(token)).expect(403);
  });

  it("requires `list` capability for `?list=true` (read alone is not enough)", async () => {
    await grants.upsertPolicy({
      name: "pki-reader",
      scopes: [scope("pki/", ["read"])],
    });
    await grants.attach(String(userId), "pki-reader");

    // Read-only on pki: a cert read would be allowed, but a list still 403s.
    await request(server).get("/v1/pki/certs?list=true").set(auth(token)).expect(403);

    await grants.upsertPolicy({
      name: "pki-lister",
      scopes: [scope("pki/", ["list"])],
    });
    await grants.attach(String(userId), "pki-lister");
    // With `list` added, the same request passes the ACL (will then fall through to a
    // 404/503 since pki isn't backed by anything in this test). Asserting "not 403" is
    // sufficient.
    const res = await request(server).get("/v1/pki/certs?list=true").set(auth(token));
    expect(res.status).not.toBe(403);
  });

  it("still 401s when the bearer token is missing (auth runs before ACL)", async () => {
    await request(server).get("/v1/sys/mounts").expect(401);
  });
});

describe("grants e2e — ARC_DEFAULT_POLICY=allow (dev default) keeps existing tests working", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let token: string;

  beforeAll(async () => {
    const saved = process.env.ARC_DEFAULT_POLICY;
    delete process.env.ARC_DEFAULT_POLICY; // default = "allow"
    try {
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      server = app.getHttpServer();
      const session = await login(server, "grants-e2e-allow@example.com");
      token = session.token;
    } finally {
      if (saved !== undefined) process.env.ARC_DEFAULT_POLICY = saved;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("permits a user with no policies to hit /v1/sys/mounts (default-allow)", async () => {
    await request(server).get("/v1/sys/mounts").set(auth(token)).expect(200);
  });
});
