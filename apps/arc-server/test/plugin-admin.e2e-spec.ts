/**
 * End-to-end coverage of the runtime plugin mount/unmount admin API (ADR-009).
 * Boots the real app with `ARC_DEFAULT_POLICY=deny`, then verifies the full operator
 * flow: admin mounts via POST → dispatch routes through to the plugin → admin unmounts
 * via DELETE → dispatch 404s. Plus the negative paths the ADR commits to:
 *  - non-admin POST/DELETE → 403 (the existing CapabilityGuard, no new auth code).
 *  - manifest-gate refusals (untrusted publisher, tampered artifact) bubble up with the
 *    same structured `reason` the boot path surfaces.
 *  - DELETE on a non-existent mount → 404.
 *  - Conflict (same mount path or plugin name twice) → 409.
 *
 * The fixture spawns a real OOP plugin child process via the runtime CJS — same shape
 * the auto-mount spec uses — so the e2e exercises the whole manifest gate + spawn-and-mount
 * path, not just controller wiring.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { generatePublisherKey, signArtifact } from "@arc/plugin-sign";
import { scope } from "@arc/grants";
import { AppModule } from "../src/app.module";
import { GrantsService } from "../src/grants/grants.service";

const RUNTIME_CJS = join(__dirname, "../../../packages/arc-plugin-sdk/dist/runtime.cjs");

function writeArtifact(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/usr/bin/env node
const { runSecretsPlugin } = require("${RUNTIME_CJS}");
let counter = 0;
runSecretsPlugin({
  meta: { name: "${name}", version: "1.0.0", kind: "secrets", description: "admin-api e2e fixture" },
  async configure() {},
  async issue(req) {
    counter++;
    return {
      data: { token: req.role + "-" + counter },
      leaseId: req.role + "/" + counter,
      ttlSeconds: 60, renewable: true,
    };
  },
  async renew(id) { return { leaseId: id, ttlSeconds: 60, renewable: true }; },
  async revoke() {},
});
`,
    "utf8",
  );
  chmodSync(file, 0o755);
  return file;
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

describe("plugin admin e2e — runtime mount/unmount via /v1/sys/plugins/mounts", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let grants: GrantsService;
  let dir: string;
  let key: { privB64u: string; pubB64u: string };
  let goodArtifact: string;
  let goodManifestPath: string;
  let strangerManifestPath: string;
  let tamperedArtifact: string;
  let tamperedManifestPath: string;
  let adminToken: string;
  let userToken: string;

  const env = {
    pol: process.env.ARC_DEFAULT_POLICY,
    anchors: process.env.ARC_PLUGIN_TRUST_ANCHORS,
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "arc-admin-api-"));
    key = generatePublisherKey();

    goodArtifact = writeArtifact(dir, "good-plugin");
    const goodManifest = await signArtifact({
      artifactPath: goodArtifact,
      publisherPrivB64u: key.privB64u,
      publisher: "publisher:e2e",
      name: "good-plugin",
      version: "1.0.0",
      kind: "process",
      capabilities: ["read", "delete"],
    });
    goodManifestPath = join(dir, "good-manifest.json");
    writeFileSync(goodManifestPath, JSON.stringify(goodManifest));

    // Manifest signed by a DIFFERENT publisher — for the "untrusted publisher" refusal.
    const stranger = generatePublisherKey();
    const strangerManifest = await signArtifact({
      artifactPath: goodArtifact,
      publisherPrivB64u: stranger.privB64u,
      publisher: "publisher:stranger",
      name: "good-plugin",
      version: "1.0.0",
      kind: "process",
      capabilities: ["read"],
    });
    strangerManifestPath = join(dir, "stranger-manifest.json");
    writeFileSync(strangerManifestPath, JSON.stringify(strangerManifest));

    // Manifest pinned to ORIGINAL bytes; artifact then mutated → hash mismatch refusal.
    tamperedArtifact = writeArtifact(dir, "tampered-plugin");
    const tamperedManifest = await signArtifact({
      artifactPath: tamperedArtifact,
      publisherPrivB64u: key.privB64u,
      publisher: "publisher:e2e",
      name: "tampered-plugin",
      version: "1.0.0",
      kind: "process",
      capabilities: ["read"],
    });
    tamperedManifestPath = join(dir, "tampered-manifest.json");
    writeFileSync(tamperedManifestPath, JSON.stringify(tamperedManifest));
    writeFileSync(tamperedArtifact, "#!/usr/bin/env node\nconsole.log('post-sign tamper');\n");
    chmodSync(tamperedArtifact, 0o755);

    process.env.ARC_DEFAULT_POLICY = "deny";
    process.env.ARC_PLUGIN_TRUST_ANCHORS = `publisher:e2e=${key.pubB64u}`;

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    server = app.getHttpServer();
    grants = app.get(GrantsService);

    // Two subjects: one admin (sudo on sys/plugins/), one ordinary user (no policy).
    const admin = await login(server, "plugin-admin@example.com");
    await grants.upsertPolicy({
      name: "plugin-admin",
      scopes: [scope("sys/plugins/", ["sudo"]), scope("good/", ["read", "delete"])],
    });
    await grants.attach(String(admin.userId), "plugin-admin");
    adminToken = admin.token;

    userToken = (await login(server, "plugin-user@example.com")).token;
  });

  afterAll(async () => {
    await app.close();
    if (env.pol === undefined) delete process.env.ARC_DEFAULT_POLICY; else process.env.ARC_DEFAULT_POLICY = env.pol;
    if (env.anchors === undefined) delete process.env.ARC_PLUGIN_TRUST_ANCHORS; else process.env.ARC_PLUGIN_TRUST_ANCHORS = env.anchors;
  });

  it("non-admin POST is refused by the existing CapabilityGuard (403)", async () => {
    await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(userToken))
      .send({ mountPath: "good/", binPath: goodArtifact, manifestPath: goodManifestPath })
      .expect(403);
  });

  it("admin mount round-trip: POST returns metadata + envSnippet, plugin dispatches, DELETE 204s, dispatch 404s", async () => {
    const r = await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(adminToken))
      .send({ mountPath: "good/", binPath: goodArtifact, manifestPath: goodManifestPath })
      .expect(201);

    expect(r.body.data).toMatchObject({
      name: "good-plugin",
      version: "1.0.0",
      mountPath: "good/",
      declaredCapabilities: ["delete", "read"],
    });
    expect(r.body.data.envSnippet).toBe(`good/=${goodArtifact}?manifest=${goodManifestPath}`);

    // Plugin is live — issue creds through it.
    const issued = await request(server).get("/v1/good/creds/api").set(auth(adminToken)).expect(200);
    expect((issued.body.data as { token: string }).token).toBe("api-1");

    // Unmount + confirm dispatch is gone. URL-encode the mount path's trailing slash.
    await request(server)
      .delete("/v1/sys/plugins/mounts/good%2F")
      .set(auth(adminToken))
      .expect(204);

    await request(server).get("/v1/good/creds/api").set(auth(adminToken)).expect(404);
  }, 20_000);

  it("DELETE on an unknown mount returns 404 (not 204)", async () => {
    await request(server)
      .delete("/v1/sys/plugins/mounts/nope%2F")
      .set(auth(adminToken))
      .expect(404)
      .expect((res) => expect(res.body.reason).toBe("mount_not_found"));
  });

  /**
   * LOW-E regression (audit, ADR-009 §2). Before this commit `@UseGuards(CapabilityGuard)`
   * derived the policy capability from HTTP verb (POST → "create", DELETE → "delete"), so a
   * subject granted `create`/`delete` on `sys/plugins/` accidentally satisfied "I have
   * plugin admin rights" even though the ADR called out `sudo`. The new
   * `@RequireCapability("sudo")` on the controller forces the gate to ask for `sudo`,
   * regardless of method. This test seeds a subject with create+delete (but NOT sudo)
   * and asserts both endpoints refuse the request as `no-matching-scope`.
   */
  it("LOW-E — sudo is required on sys/plugins/; create+delete-only policy is refused", async () => {
    const a = await login(server, "low-e-non-sudo@example.com");
    await grants.upsertPolicy({
      name: "p-create-not-sudo",
      scopes: [scope("sys/plugins/", ["create", "delete"])],
    });
    await grants.attach(String(a.userId), "p-create-not-sudo");

    const post = await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(a.token))
      .send({ mountPath: "test-low-e/", binPath: "/usr/bin/true" })
      .expect(403);
    expect(post.body.reason).toBe("no-matching-scope");

    const del = await request(server)
      .delete("/v1/sys/plugins/mounts/test-low-e%2F")
      .set(auth(a.token))
      .expect(403);
    expect(del.body.reason).toBe("no-matching-scope");
  });

  it("manifest refusal — wrong publisher pinned in ARC_PLUGIN_TRUST_ANCHORS → 400 with reason=untrusted_publisher", async () => {
    const r = await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(adminToken))
      .send({ mountPath: "stranger/", binPath: goodArtifact, manifestPath: strangerManifestPath })
      .expect(400);
    expect(r.body.reason).toBe("untrusted_publisher");
  });

  it("manifest refusal — artifact tampered after signing → 400 with reason=artifact_hash_mismatch", async () => {
    const r = await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(adminToken))
      .send({ mountPath: "tampered/", binPath: tamperedArtifact, manifestPath: tamperedManifestPath })
      .expect(400);
    expect(r.body.reason).toBe("artifact_hash_mismatch");
  });

  it("duplicate name conflict — mount twice → 409 the second time", async () => {
    await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(adminToken))
      .send({ mountPath: "dup/", binPath: goodArtifact, manifestPath: goodManifestPath })
      .expect(201);

    await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(adminToken))
      .send({ mountPath: "dup2/", binPath: goodArtifact, manifestPath: goodManifestPath })
      .expect(409);

    await request(server).delete("/v1/sys/plugins/mounts/dup%2F").set(auth(adminToken)).expect(204);
  }, 20_000);

  it("DTO validation — missing binPath → 400, no service call made", async () => {
    await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(adminToken))
      .send({ mountPath: "missing-bin/" })
      .expect(400);
  });

  // Nest's ValidationPipe surfaces class-validator messages on `body.message` as an array
  // when multiple constraints fail (one entry per `IsString` / `Matches` etc.). Stringify
  // to one blob for matching.
  const errorBlob = (body: Record<string, unknown>): string => {
    const m = body.message;
    if (Array.isArray(m)) return m.join("\n");
    if (typeof m === "string") return m;
    const e = body.errors;
    return Array.isArray(e) ? e.join("\n") : "";
  };

  it("DTO validation — relative binPath → 400 with class-validator message", async () => {
    const r = await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(adminToken))
      .send({ mountPath: "rel/", binPath: "relative/path" })
      .expect(400);
    expect(errorBlob(r.body)).toMatch(/binPath must be absolute/);
  });

  it("DTO validation — mountPath missing trailing slash → 400", async () => {
    const r = await request(server)
      .post("/v1/sys/plugins/mounts")
      .set(auth(adminToken))
      .send({ mountPath: "no-slash", binPath: goodArtifact })
      .expect(400);
    expect(errorBlob(r.body)).toMatch(/mountPath.*end with/);
  });
});
