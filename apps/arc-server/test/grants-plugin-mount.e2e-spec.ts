/**
 * End-to-end coverage of arc-grants policy enforcement on **plugin mount paths** — the
 * operator-facing flow that combines the manifest gate (ADR-005 Phase 5b runtime gate)
 * with `CapabilityGuard`'s per-mount ACL.
 *
 * The interesting property this proves: a verified plugin's declared capabilities surface
 * on `/v1/sys/mounts` + `/v1/sys/policy-templates`, an admin POSTs the suggested policy
 * to `/v1/sys/policy` + attaches it to a subject, and that subject can hit exactly the
 * verbs the plugin uses — no more, no less. A subject with no policy gets 403 even though
 * the plugin would happily handle the request; a subject with the wrong policy hits the
 * gate at a finer grain than HTTP-method-alone would catch.
 *
 * Two layers must both pass:
 *  1. `CapabilityGuard` — does this *subject* have a policy granting this verb on this prefix?
 *  2. The manifest gate (in `EnginesService`) — did this *plugin*'s manifest declare this verb?
 * Either one refusing is a 4xx; both must succeed for dispatch to reach the plugin.
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
    description: "fixture for grants+manifest e2e",
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
  const body = res.body as { accessToken: string };
  const payload = JSON.parse(
    Buffer.from(body.accessToken.split(".")[1]!, "base64").toString("utf8"),
  ) as { sub: number };
  return { token: body.accessToken, userId: payload.sub };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("grants e2e — policy on a plugin mount path", () => {
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

      // Mount the fake plugin with a declared cap set of [read, delete]. The plugin's
      // manifest is `undefined` here — we exercise the runtime gate by passing the cap
      // list to `mountSecretsPlugin` directly, which is what the verified-manifest path
      // ends up doing. This isolates the grants check from the manifest verification step
      // (which is covered by `plugins.service.signed-release.spec.ts`).
      await plugins.mountSecretsPlugin(new FakeFooPlugin(), "foo/", {}, ["read", "delete"]);

      const session = await login(server, "grants-plugin-e2e@example.com");
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

  it("a subject with no policy is denied a plugin-mount path under default-deny", async () => {
    expect(grants.defaultMode).toBe("deny");
    await request(server).get("/v1/foo/creds/web").set(auth(token)).expect(403);
  });

  it("/v1/sys/mounts surfaces the plugin's declared capabilities so admins know what to grant", async () => {
    // The /v1/sys/mounts endpoint itself is policy-gated, so attach a tiny sys/ read
    // policy first. This is the same bootstrap the admin would do for themselves.
    await grants.upsertPolicy({
      name: "sys-reader",
      scopes: [scope("sys/", ["read"])],
    });
    await grants.attach(String(userId), "sys-reader");

    const r = await request(server).get("/v1/sys/mounts").set(auth(token)).expect(200);
    const fooMount = (r.body.data as Array<{ path: string; declaredCapabilities?: string[] }>).find(
      (m) => m.path === "foo/",
    );
    expect(fooMount).toBeDefined();
    expect(fooMount?.declaredCapabilities).toEqual(["delete", "read"]);
  });

  it("/v1/sys/policy-templates returns a starter policy matching what the plugin uses", async () => {
    const r = await request(server).get("/v1/sys/policy-templates").set(auth(token)).expect(200);
    const templates = r.body.data as Array<{
      name: string;
      scopes: Array<{ pathPrefix: string; capabilities: string[] }>;
    }>;
    const t = templates.find((t) => t.scopes[0]?.pathPrefix === "foo/");
    expect(t).toBeDefined();
    expect(t?.name).toBe("plugin:foo");
    expect(t?.scopes[0]?.capabilities).toEqual(["delete", "read"]);
  });

  it("attaching the template policy unlocks the plugin's read path (issue creds)", async () => {
    await grants.upsertPolicy({
      name: "plugin:foo",
      scopes: [scope("foo/", ["read", "delete"])],
    });
    await grants.attach(String(userId), "plugin:foo");

    const r = await request(server).get("/v1/foo/creds/web").set(auth(token)).expect(200);
    expect(r.body.data).toMatchObject({ token: "tok-web-1" });
  });

  it("a policy granting only `read` refuses lease revoke (DELETE) on the plugin's leases", async () => {
    // Issue a lease that we'll try to revoke without the `delete` capability.
    const issued = await request(server).get("/v1/foo/creds/web").set(auth(token)).expect(200);
    const leaseId = issued.body.lease_id as string;

    // Create a second user with only `read` on foo/ — they can issue but should not be able
    // to revoke. This isolates the capability check from the user's other policies.
    const reader = await login(server, "foo-read-only@example.com");
    await grants.upsertPolicy({
      name: "foo-read-only",
      scopes: [scope("foo/", ["read"])],
    });
    await grants.attach(String(reader.userId), "foo-read-only");

    // Reader can read.
    await request(server).get("/v1/foo/creds/web").set(auth(reader.token)).expect(200);
    // But revoke (DELETE) requires the `delete` capability — refused by the grants layer
    // *before* the manifest gate even runs.
    await request(server)
      .put(`/v1/sys/leases/revoke/${leaseId}`)
      .set(auth(reader.token))
      .expect(403);
  });

  it("a subject with a policy on a different mount can't reach the plugin's path", async () => {
    // Make a third user with only `secret/` access — should still be 403 on foo/.
    const stranger = await login(server, "wrong-mount@example.com");
    await grants.upsertPolicy({
      name: "secret-reader",
      scopes: [scope("secret/", ["read"])],
    });
    await grants.attach(String(stranger.userId), "secret-reader");
    await request(server).get("/v1/foo/creds/web").set(auth(stranger.token)).expect(403);
  });
});
