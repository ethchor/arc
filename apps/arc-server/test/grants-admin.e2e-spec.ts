/**
 * End-to-end coverage of the grants admin API (`/v1/sys/policy`) + the `ARC_ROOT_USERS`
 * bootstrap, all under `ARC_DEFAULT_POLICY=deny` (the production posture).
 *
 * The flow proves the whole loop is usable in fail-closed mode:
 *
 *  1. `ARC_ROOT_USERS=1` seeds a sudo `root` policy on boot. The first dev-login user
 *     (id 1, since each test app gets a fresh in-memory DB) is root and can reach
 *     `/v1/sys/policy` even though default-deny would otherwise block it.
 *  2. A second user has no policies → 403 everywhere on `/v1`.
 *  3. Root creates a `reader` policy, attaches it to the second user, and the second user
 *     immediately gets access to exactly the scoped path — proving the persistent store +
 *     live ACL read path are wired.
 *  4. Detach revokes that access; delete removes the policy; attach-to-unknown is a 404.
 *  5. A non-root user cannot manage policies (the ACL surface protects itself).
 *
 * Persistence is exercised through the real TypeORM store (sql.js in test): every
 * create/attach/detach/delete is a DB round-trip, not the in-memory map the service shipped
 * with.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";

async function login(server: unknown, email: string): Promise<{ token: string; userId: number }> {
  const res = await request(server as Parameters<typeof request>[0])
    .post("/auth/dev-login")
    .send({ email })
    .expect(201);
  const body = res.body as { accessToken: string };
  const payload = JSON.parse(
    Buffer.from(body.accessToken.split(".")[1]!, "base64").toString("utf8"),
  ) as { sub: number };
  return { token: body.accessToken, userId: payload.sub };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("grants admin API e2e — ARC_ROOT_USERS bootstrap under default-deny", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let rootToken: string;
  let appToken: string;
  let appUserId: number;

  beforeAll(async () => {
    const savedPolicy = process.env.ARC_DEFAULT_POLICY;
    const savedRoots = process.env.ARC_ROOT_USERS;
    process.env.ARC_DEFAULT_POLICY = "deny";
    process.env.ARC_ROOT_USERS = "1"; // first dev-login user in a fresh DB → id 1
    try {
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      server = app.getHttpServer();
      // Order matters: the root user must be created first to land on id 1.
      const root = await login(server, "root@example.com");
      rootToken = root.token;
      expect(root.userId).toBe(1);
      const appUser = await login(server, "app@example.com");
      appToken = appUser.token;
      appUserId = appUser.userId;
    } finally {
      if (savedPolicy === undefined) delete process.env.ARC_DEFAULT_POLICY;
      else process.env.ARC_DEFAULT_POLICY = savedPolicy;
      if (savedRoots === undefined) delete process.env.ARC_ROOT_USERS;
      else process.env.ARC_ROOT_USERS = savedRoots;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("root (seeded sudo) can reach the policy admin API even under default-deny", async () => {
    const res = await request(server).get("/v1/sys/policy").set(auth(rootToken)).expect(200);
    // The seeded root policy is present.
    const names = (res.body.data as Array<{ name: string }>).map((p) => p.name);
    expect(names).toContain("root");
  });

  it("a non-root user with no policies is denied everywhere on /v1", async () => {
    await request(server).get("/v1/sys/mounts").set(auth(appToken)).expect(403);
    await request(server).get("/v1/sys/policy").set(auth(appToken)).expect(403);
  });

  it("root creates a policy + attaches it, unlocking exactly that scope for the app user", async () => {
    await request(server)
      .post("/v1/sys/policy")
      .set(auth(rootToken))
      .send({ name: "reader", scopes: [{ pathPrefix: "secret/", capabilities: ["read"] }] })
      .expect(201);

    // Before attach: app user still denied.
    await request(server).get("/v1/secret/data/x").set(auth(appToken)).expect(403);

    await request(server)
      .post("/v1/sys/policy/reader/attach")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(201);

    // After attach: ACL passes (404 because no OpenBao backend in this test, but NOT 403).
    const res = await request(server).get("/v1/secret/data/x").set(auth(appToken));
    expect(res.status).not.toBe(403);

    // The scope is exact: a write (create) on the same path is still denied.
    await request(server)
      .post("/v1/secret/data/x")
      .set(auth(appToken))
      .send({ data: { a: 1 } })
      .expect(403);
  });

  it("detach revokes the access again", async () => {
    await request(server)
      .post("/v1/sys/policy/reader/detach")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(204);

    await request(server).get("/v1/secret/data/x").set(auth(appToken)).expect(403);
  });

  it("attaching an unknown policy is a 404", async () => {
    await request(server)
      .post("/v1/sys/policy/does-not-exist/attach")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(404);
  });

  it("rejects a malformed policy (unknown capability) with 400", async () => {
    await request(server)
      .post("/v1/sys/policy")
      .set(auth(rootToken))
      .send({ name: "bad", scopes: [{ pathPrefix: "secret/", capabilities: ["frobnicate"] }] })
      .expect(400);
  });

  it("a non-root user cannot create policies (the ACL surface protects itself)", async () => {
    await request(server)
      .post("/v1/sys/policy")
      .set(auth(appToken))
      .send({ name: "sneaky", scopes: [{ pathPrefix: "secret/", capabilities: ["read"] }] })
      .expect(403);
  });

  it("root can delete a policy", async () => {
    await request(server).delete("/v1/sys/policy/reader").set(auth(rootToken)).expect(204);
    const res = await request(server).get("/v1/sys/policy").set(auth(rootToken)).expect(200);
    const names = (res.body.data as Array<{ name: string }>).map((p) => p.name);
    expect(names).not.toContain("reader");
  });
});
