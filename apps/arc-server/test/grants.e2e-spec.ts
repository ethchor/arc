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
import type {
  IssueRequest,
  IssuedSecret,
  LeaseInfo,
  SecretsPlugin,
} from "@arc/plugin-sdk";
import { AppModule } from "../src/app.module";
import { GrantsService } from "../src/grants/grants.service";
import { PluginsService } from "../src/plugins/plugins.service";

class FakeFooPlugin implements SecretsPlugin {
  readonly meta = {
    name: "fake-foo",
    version: "0.0.1",
    kind: "secrets" as const,
    description: "fixture for the plugin-mount section of the grants e2e",
  };
  private counter = 0;
  async configure(): Promise<void> {}
  async issue(req: IssueRequest): Promise<IssuedSecret> {
    this.counter++;
    return {
      data: { token: `tok-${req.role}-${this.counter}` },
      leaseId: `fake-foo/${req.role}/${this.counter}`,
      ttlSeconds: 60,
      renewable: true,
    };
  }
  async renew(leaseId: string): Promise<LeaseInfo> {
    return { leaseId, ttlSeconds: 60, renewable: true };
  }
  async revoke(): Promise<void> {}
}

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
  let plugins: PluginsService;
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
      plugins = app.get(PluginsService);
      // Mount a fake plugin with a declared cap set of [read, delete]. The plugin-mount
      // section below exercises both the manifest gate (these declared caps surface on
      // /v1/sys/policy-templates) and the per-mount ACL (subjects without `plugin:foo`
      // policy can't reach `/v1/foo/*`).
      await plugins.mountSecretsPlugin(new FakeFooPlugin(), "foo/", {}, ["read", "delete"]);
      const session = await login(server, "grants-e2e@example.com");
      token = session.token;
      userId = session.userId;
    } finally {
      if (saved === undefined) delete process.env.ARC_DEFAULT_POLICY;
      else process.env.ARC_DEFAULT_POLICY = saved;
    }
  });

  afterAll(async () => {
    await plugins.unmount("fake-foo").catch(() => undefined);
    await app.close();
  });

  it("denies a user with no policies under default-deny mode (any /v1 path)", async () => {
    expect(grants.defaultMode).toBe("deny");
    await request(server).get("/v1/sys/mounts").set(auth(token)).expect(403);
    await request(server).get("/v1/secret/data/x").set(auth(token)).expect(403);
  });

  // HIGH-A regression (untrusted-code audit) — note on test coverage:
  //
  //   The audit identified a `..` traversal that escapes the ACL-matched mount. We
  //   empirically verified that Express's URL normalizer collapses LITERAL `..`, and
  //   path-to-regexp v8's segment decoder collapses ENCODED `%2e%2e`/`%2E%2E`/`.%2e`
  //   BEFORE the `*splat` handler runs (probe: `/v1/secret/data/%2e%2e/sys/seal-status`
  //   becomes `/v1/secret/sys/seal-status` by the time req.url is read). So no HTTP
  //   shape can reach the controller with a traversal segment intact — Express does
  //   our work for us at runtime today.
  //
  //   The canonicalizer / joinSplatStrict / OpenBao adapter rejection layers therefore
  //   guard non-HTTP entry points (the leasing-driven revoke, the CLI tools, any
  //   future SDK consumer) AND act as defense in depth against an Express
  //   normalization regression. Their behavior is pinned by:
  //     - src/engines/path-canon.spec.ts (17 cases incl. literal + encoded + empty)
  //     - src/grants/capability.guard.spec.ts (guard rejects traversal at the unit
  //       level, where Express isn't in the loop)
  //     - integrations/arc-openbao-adapter/tests/client.test.ts (adapter rejects
  //       BEFORE the fetch call — the real value-add for non-HTTP callers).
  //
  //   This e2e suite intentionally does NOT pin an HTTP-level rejection: it would be a
  //   test of Express's normalizer, not of our code, and Express's behavior here is
  //   the property *we depend on*, not the property *we provide*.

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

  // --- plugin-mount section: the same Nest app, the same gate, applied to a plugin
  //     mount with manifest-declared capabilities. Reuses this describe's app instance
  //     instead of spinning up a second one (the previous standalone spec OOM'd CI on
  //     the runner's memory budget once the suite count grew).

  it("plugin mount: a subject with no policy is denied /v1/foo/creds/web under default-deny", async () => {
    const session = await login(server, "grants-plugin-empty@example.com");
    await request(server).get("/v1/foo/creds/web").set(auth(session.token)).expect(403);
  });

  it("plugin mount: /v1/sys/mounts surfaces the plugin's declared capabilities to admins", async () => {
    // The grants subject (`userId`) attached the `reader` policy above which grants
    // `read` on `sys/`, so /v1/sys/mounts is reachable for the admin in this test.
    const r = await request(server).get("/v1/sys/mounts").set(auth(token)).expect(200);
    const fooMount = (r.body.data as Array<{ path: string; declaredCapabilities?: string[] }>).find(
      (m) => m.path === "foo/",
    );
    expect(fooMount).toBeDefined();
    expect(fooMount?.declaredCapabilities).toEqual(["delete", "read"]);
  });

  it("plugin mount: /v1/sys/policy-templates returns a starter policy matching the plugin's caps", async () => {
    const r = await request(server).get("/v1/sys/policy-templates").set(auth(token)).expect(200);
    const t = (r.body.data as Array<{
      name: string;
      scopes: Array<{ pathPrefix: string; capabilities: string[] }>;
    }>).find((t) => t.scopes[0]?.pathPrefix === "foo/");
    expect(t).toBeDefined();
    expect(t?.name).toBe("plugin:foo");
    expect(t?.scopes[0]?.capabilities).toEqual(["delete", "read"]);
  });

  it("plugin mount: attaching the template policy unlocks the plugin's read path", async () => {
    const session = await login(server, "grants-plugin-reader@example.com");
    await grants.upsertPolicy({
      name: "plugin:foo",
      scopes: [scope("foo/", ["read", "delete"])],
    });
    await grants.attach(String(session.userId), "plugin:foo");

    const r = await request(server).get("/v1/foo/creds/web").set(auth(session.token)).expect(200);
    expect(r.body.data).toMatchObject({ token: expect.stringMatching(/^tok-web-\d+$/) });
  });

  it("plugin mount: a `read`-only policy refuses lease revoke (DELETE through grants layer)", async () => {
    const session = await login(server, "grants-plugin-readonly@example.com");
    await grants.upsertPolicy({
      name: "foo-read-only",
      scopes: [scope("foo/", ["read"])],
    });
    await grants.attach(String(session.userId), "foo-read-only");

    // Issue a lease the user CAN issue (read cap).
    const issued = await request(server).get("/v1/foo/creds/web").set(auth(session.token)).expect(200);
    const leaseId = issued.body.lease_id as string;

    // Revoke (DELETE on the lease path) needs `delete` — refused by the grants layer
    // *before* the manifest gate even runs.
    await request(server)
      .put(`/v1/sys/leases/revoke/${leaseId}`)
      .set(auth(session.token))
      .expect(403);
  });

  it("plugin mount: a policy on a different mount can't reach the plugin's path", async () => {
    const session = await login(server, "grants-plugin-wrong-mount@example.com");
    await grants.upsertPolicy({
      name: "secret-reader",
      scopes: [scope("secret/", ["read"])],
    });
    await grants.attach(String(session.userId), "secret-reader");
    await request(server).get("/v1/foo/creds/web").set(auth(session.token)).expect(403);
  });

  it("SEC-H5 (#147): sys/leases access alone can't renew/revoke a lease of a mount the subject lacks policy on", async () => {
    // A properly-scoped operator issues a lease at the foo/ plugin mount.
    const operator = await login(server, "grants-lease-operator@example.com");
    await grants.upsertPolicy({ name: "foo-lease-op", scopes: [scope("foo/", ["read", "delete"])] });
    await grants.attach(String(operator.userId), "foo-lease-op");
    const leaseId = (
      await request(server).get("/v1/foo/creds/web").set(auth(operator.token)).expect(200)
    ).body.lease_id as string;

    // The attacker holds broad sys/leases caps — enough to PASS the CapabilityGuard on every
    // lease endpoint — but has NO foo/ policy. Pre-fix this let it renew/revoke foo/'s lease
    // (cross-mount DoS). The new per-mount check refuses all three forms at foo/ granularity;
    // asserting the 403 body mentions `foo/` proves the denial is the mount check, not the guard.
    const attacker = await login(server, "grants-lease-attacker@example.com");
    await grants.upsertPolicy({
      name: "sys-leases-only",
      scopes: [scope("sys/leases/", ["create", "read", "update", "delete", "list"])],
    });
    await grants.attach(String(attacker.userId), "sys-leases-only");

    const renew = await request(server)
      .post("/v1/sys/leases/renew")
      .set(auth(attacker.token))
      .send({ lease_id: leaseId })
      .expect(403);
    expect(JSON.stringify(renew.body)).toMatch(/foo\//);
    await request(server)
      .put(`/v1/sys/leases/revoke/${leaseId}`)
      .set(auth(attacker.token))
      .expect(403);
    await request(server)
      .post("/v1/sys/leases/revoke")
      .set(auth(attacker.token))
      .send({ lease_id: leaseId })
      .expect(403);
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
