/**
 * End-to-end coverage of the groups admin API + the union-resolution path. Boots the
 * real app under `ARC_DEFAULT_POLICY=deny` with `ARC_ROOT_USERS=1` so root bootstrap is
 * the same as `grants-admin.e2e-spec.ts`. Two users:
 *
 *   - root (user id 1): seeded sudo `root` policy, manages everything via `/v1/sys/*`.
 *   - app (user id 2): no direct policies. Gets access via group membership; loses access
 *     when removed from the group or when the group loses the policy attachment.
 *
 * Exercises through the TypeORM-backed store on sql.js — every assertion crosses a
 * database round-trip.
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

describe("grants groups e2e — group attachments drive effective policies", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let rootToken: string;
  let appToken: string;
  let appUserId: number;

  beforeAll(async () => {
    const savedPolicy = process.env.ARC_DEFAULT_POLICY;
    const savedRoots = process.env.ARC_ROOT_USERS;
    const savedCache = process.env.ARC_POLICY_CACHE_TTL_MS;
    process.env.ARC_DEFAULT_POLICY = "deny";
    process.env.ARC_ROOT_USERS = "1";
    // Disable the policy cache so test assertions don't have to wait for TTL invalidation.
    process.env.ARC_POLICY_CACHE_TTL_MS = "0";
    try {
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      server = app.getHttpServer();
      const root = await login(server, "groups-root@example.com");
      rootToken = root.token;
      expect(root.userId).toBe(1);
      const appUser = await login(server, "groups-app@example.com");
      appToken = appUser.token;
      appUserId = appUser.userId;
    } finally {
      if (savedPolicy === undefined) delete process.env.ARC_DEFAULT_POLICY;
      else process.env.ARC_DEFAULT_POLICY = savedPolicy;
      if (savedRoots === undefined) delete process.env.ARC_ROOT_USERS;
      else process.env.ARC_ROOT_USERS = savedRoots;
      if (savedCache === undefined) delete process.env.ARC_POLICY_CACHE_TTL_MS;
      else process.env.ARC_POLICY_CACHE_TTL_MS = savedCache;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("group with no members exists implicitly — describe is OK and returns empty arrays", async () => {
    const res = await request(server)
      .get("/v1/sys/groups/engineering")
      .set(auth(rootToken))
      .expect(200);
    expect(res.body.data).toEqual({ group: "engineering", members: [], policies: [] });
  });

  it("subject access transits through group membership end-to-end", async () => {
    // 1. Root creates a "reader" policy + attaches it to "engineering".
    await request(server)
      .post("/v1/sys/policy")
      .set(auth(rootToken))
      .send({ name: "reader", scopes: [{ pathPrefix: "secret/", capabilities: ["read"] }] })
      .expect(201);
    await request(server)
      .post("/v1/sys/groups/engineering/policies")
      .set(auth(rootToken))
      .send({ policyName: "reader" })
      .expect(201);

    // 2. Before adding app to the group: app is still denied.
    await request(server).get("/v1/secret/data/x").set(auth(appToken)).expect(403);

    // 3. Add app to engineering — access unlocks immediately (cache disabled).
    await request(server)
      .post("/v1/sys/groups/engineering/members")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(201);
    const after = await request(server).get("/v1/secret/data/x").set(auth(appToken));
    expect(after.status).not.toBe(403);

    // The membership shows up in describe.
    const describe = await request(server)
      .get("/v1/sys/groups/engineering")
      .set(auth(rootToken))
      .expect(200);
    expect(describe.body.data.members).toContain(String(appUserId));
    expect(describe.body.data.policies).toEqual(["reader"]);
  });

  it("removing the subject from the group revokes group-derived access", async () => {
    await request(server)
      .post("/v1/sys/groups/engineering/members/remove")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(204);
    await request(server).get("/v1/secret/data/x").set(auth(appToken)).expect(403);
  });

  it("detaching the policy from the group revokes access for every remaining member", async () => {
    // Re-add app to the group, then detach the policy from the group — access drops.
    await request(server)
      .post("/v1/sys/groups/engineering/members")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(201);
    const before = await request(server).get("/v1/secret/data/x").set(auth(appToken));
    expect(before.status).not.toBe(403);

    await request(server)
      .delete("/v1/sys/groups/engineering/policies/reader")
      .set(auth(rootToken))
      .expect(204);
    await request(server).get("/v1/secret/data/x").set(auth(appToken)).expect(403);
  });

  it("attaching an unknown policy to a group returns 404 (admin typo catch)", async () => {
    await request(server)
      .post("/v1/sys/groups/engineering/policies")
      .set(auth(rootToken))
      .send({ policyName: "does-not-exist" })
      .expect(404);
  });

  it("non-root user cannot manage groups (ACL surface protects itself)", async () => {
    await request(server)
      .post("/v1/sys/groups/engineering/members")
      .set(auth(appToken))
      .send({ subject: "99" })
      .expect(403);
    await request(server)
      .post("/v1/sys/groups/engineering/policies")
      .set(auth(appToken))
      .send({ policyName: "reader" })
      .expect(403);
  });

  it("direct + group policies are unioned (subject keeps direct grant after group is removed)", async () => {
    // Re-attach reader to engineering + add app to the group + give app a direct grant.
    await request(server)
      .post("/v1/sys/groups/engineering/policies")
      .set(auth(rootToken))
      .send({ policyName: "reader" })
      .expect(201);
    await request(server)
      .post("/v1/sys/groups/engineering/members")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(201);
    await request(server)
      .post("/v1/sys/policy/reader/attach")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(201);

    // Remove app from the group: the direct grant still keeps them allowed.
    await request(server)
      .post("/v1/sys/groups/engineering/members/remove")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(204);
    const still = await request(server).get("/v1/secret/data/x").set(auth(appToken));
    expect(still.status).not.toBe(403);

    // Detach the direct grant too: now they're truly denied.
    await request(server)
      .post("/v1/sys/policy/reader/detach")
      .set(auth(rootToken))
      .send({ subject: String(appUserId) })
      .expect(204);
    await request(server).get("/v1/secret/data/x").set(auth(appToken)).expect(403);
  });
});
