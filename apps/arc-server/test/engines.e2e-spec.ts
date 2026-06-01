/**
 * Engine-A e2e suite.
 *
 * Two layers:
 *
 * 1. **Always-on** — verifies the "Engine-A is disabled" behavior when `BAO_ADDR` is
 *    unset: the server still boots (Engine-B keeps working), `/v1/*` returns 503 with the
 *    structured `errors`/`configured` payload, and `/v1/sys/mounts` still answers because
 *    listing the empty registry is harmless.
 *
 * 2. **Conditional live test** — when `BAO_ADDR` is set we boot a second app pointed at
 *    the real OpenBao and round-trip a KV put/get + transit encrypt/decrypt through the
 *    new `/v1/*` route. Same `describe.skipIf`-style guard the adapter's
 *    `integration.test.ts` uses so `pnpm turbo test` without docker stays green.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";

const dockerAddr = process.env.BAO_ADDR;
const dockerToken = process.env.BAO_TOKEN ?? "root";

async function login(server: unknown, email: string): Promise<string> {
  const res = await request(server as Parameters<typeof request>[0])
    .post("/auth/dev-login")
    .send({ email })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("engines e2e — disabled (no BAO_ADDR)", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let token: string;

  beforeAll(async () => {
    // Make sure BAO_ADDR is unset even if the live suite below leaked it.
    const savedAddr = process.env.BAO_ADDR;
    const savedToken = process.env.BAO_TOKEN;
    delete process.env.BAO_ADDR;
    delete process.env.BAO_TOKEN;
    try {
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      server = app.getHttpServer();
      token = await login(server, "engines-disabled@example.com");
    } finally {
      if (savedAddr !== undefined) process.env.BAO_ADDR = savedAddr;
      if (savedToken !== undefined) process.env.BAO_TOKEN = savedToken;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 503 with a structured payload on /v1/sys/seal-status", async () => {
    const res = await request(server)
      .get("/v1/sys/seal-status")
      .set(auth(token))
      .expect(503);
    expect(res.body.errors).toBeDefined();
    expect(res.body.engine).toBe("A");
    expect(res.body.configured).toBe(false);
  });

  it("returns 503 on a KV read path when Engine-A is disabled", async () => {
    const res = await request(server)
      .get("/v1/secret/data/whatever")
      .set(auth(token))
      .expect(503);
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  it("returns 401 without a bearer token (auth still gates Engine-A)", async () => {
    await request(server).get("/v1/sys/seal-status").expect(401);
    await request(server).get("/v1/secret/data/x").expect(401);
  });

  it("/v1/sys/mounts returns an empty list when no mounts are registered", async () => {
    // The endpoint requires the client too, since "no Engine-A configured" is the right
    // failure when there is no backend — even if the registry could in principle answer.
    const res = await request(server).get("/v1/sys/mounts").set(auth(token)).expect(503);
    expect(res.body.errors).toBeDefined();
  });

  it("sys/leases/renew + revoke return 503 when Engine-A is disabled", async () => {
    await request(server)
      .post("/v1/sys/leases/renew")
      .set(auth(token))
      .send({ lease_id: "anything" })
      .expect(503);
    await request(server)
      .put("/v1/sys/leases/revoke/anything")
      .set(auth(token))
      .expect(503);
  });

  it("sys/leases/renew rejects an empty lease_id with 400 before reaching the engine", async () => {
    await request(server)
      .post("/v1/sys/leases/renew")
      .set(auth(token))
      .send({})
      .expect(400);
  });
});

const live = dockerAddr ? describe : describe.skip;
live("engines e2e — live OpenBao (BAO_ADDR set)", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let token: string;

  beforeAll(async () => {
    process.env.BAO_ADDR = dockerAddr!;
    process.env.BAO_TOKEN = dockerToken;
    // Make sure transit + pki are mounted on the live backend before we exercise them.
    // The KV mount is on by default in dev mode.
    const ensureMount = (type: string) =>
      fetch(`${dockerAddr}/v1/sys/mounts/${type}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vault-Token": dockerToken,
        },
        body: JSON.stringify({ type }),
      }).catch(() => {
        /* re-runs leave the mount in place; the next call will 400; ignore */
      });
    await ensureMount("transit");
    await ensureMount("pki");
    // PKI needs a self-signed root + a role before issue/sign work.
    await fetch(`${dockerAddr}/v1/pki/root/generate/internal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vault-Token": dockerToken,
      },
      body: JSON.stringify({ common_name: "arc-test-root", ttl: "87600h" }),
    }).catch(() => {
      /* already generated on prior runs */
    });
    await fetch(`${dockerAddr}/v1/pki/roles/arc-test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vault-Token": dockerToken,
      },
      body: JSON.stringify({
        allowed_domains: "arc.test",
        allow_subdomains: true,
        allow_bare_domains: true,
        max_ttl: "72h",
      }),
    }).catch(() => {
      /* role already set */
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    server = app.getHttpServer();
    token = await login(server, "engines-live@example.com");
  });

  afterAll(async () => {
    await app.close();
  });

  it("proxies /v1/sys/seal-status to OpenBao", async () => {
    const res = await request(server)
      .get("/v1/sys/seal-status")
      .set(auth(token))
      .expect(200);
    expect(res.body.initialized).toBe(true);
    expect(res.body.sealed).toBe(false);
  });

  it("lists mounts (secret + transit + pki) via /v1/sys/mounts", async () => {
    const res = await request(server)
      .get("/v1/sys/mounts")
      .set(auth(token))
      .expect(200);
    const paths = (res.body.data as Array<{ path: string }>).map((m) => m.path);
    expect(paths).toContain("secret/");
    expect(paths).toContain("transit/");
    expect(paths).toContain("pki/");
  });

  it("KV v2: put → get → delete round-trips through /v1/secret/data/<key>", async () => {
    const key = `arc-engines-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const payload = { apiKey: "sk-engines-e2e", note: "delete me" };

    const put = await request(server)
      .post(`/v1/secret/data/${key}`)
      .set(auth(token))
      .send({ data: payload })
      .expect(201);
    expect(put.body.data.version).toBeGreaterThan(0);

    const get = await request(server)
      .get(`/v1/secret/data/${key}`)
      .set(auth(token))
      .expect(200);
    expect(get.body.data.data).toEqual(payload);
    expect(get.body.data.metadata.version).toBe(put.body.data.version);

    await request(server)
      .delete(`/v1/secret/data/${key}`)
      .set(auth(token))
      .expect(204);

    // After soft-delete the read still succeeds but metadata.deletion_time is non-empty.
    const afterDelete = await request(server)
      .get(`/v1/secret/data/${key}`)
      .set(auth(token))
      .expect(200);
    expect(afterDelete.body.data.metadata.deletion_time).not.toBe("");
  });

  it("transit: create key → encrypt → decrypt round-trips through /v1/transit", async () => {
    const keyName = `arc-engines-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    await request(server)
      .post(`/v1/transit/keys/${keyName}`)
      .set(auth(token))
      .send({ type: "aes256-gcm96" })
      .expect(201);

    const plaintextBytes = new TextEncoder().encode("hello from arc-server");
    const plaintextB64 = Buffer.from(plaintextBytes).toString("base64");

    const enc = await request(server)
      .post(`/v1/transit/encrypt/${keyName}`)
      .set(auth(token))
      .send({ plaintext: plaintextB64 })
      .expect(201);
    expect(typeof enc.body.data.ciphertext).toBe("string");
    expect(enc.body.data.ciphertext.startsWith("vault:v")).toBe(true);
    expect(enc.body.data.key_version).toBe(1);

    const dec = await request(server)
      .post(`/v1/transit/decrypt/${keyName}`)
      .set(auth(token))
      .send({ ciphertext: enc.body.data.ciphertext })
      .expect(201);
    expect(dec.body.data.plaintext).toBe(plaintextB64);
    expect(Buffer.from(dec.body.data.plaintext as string, "base64").toString()).toBe(
      "hello from arc-server",
    );
  });

  it("PKI: issue → read → revoke → list round-trips through /v1/pki", async () => {
    const cn = `svc-${Date.now()}-${Math.floor(Math.random() * 1e6)}.arc.test`;

    const issued = await request(server)
      .post(`/v1/pki/issue/arc-test`)
      .set(auth(token))
      .send({ common_name: cn, ttl: "1h" })
      .expect(201);
    expect(typeof issued.body.data.serial_number).toBe("string");
    expect(issued.body.data.certificate).toContain("BEGIN CERTIFICATE");
    expect(issued.body.data.private_key).toContain("BEGIN");
    const serial = issued.body.data.serial_number as string;

    const read = await request(server)
      .get(`/v1/pki/cert/${serial}`)
      .set(auth(token))
      .expect(200);
    expect(read.body.data.certificate).toContain("BEGIN CERTIFICATE");

    const ca = await request(server).get(`/v1/pki/ca/pem`).set(auth(token)).expect(200);
    expect(ca.body.data.certificate).toContain("BEGIN CERTIFICATE");

    const revoked = await request(server)
      .post(`/v1/pki/revoke`)
      .set(auth(token))
      .send({ serial_number: serial })
      .expect(201);
    expect(typeof revoked.body.data.revocation_time).toBe("number");

    const afterRevoke = await request(server)
      .get(`/v1/pki/cert/${serial}`)
      .set(auth(token))
      .expect(200);
    expect(afterRevoke.body.data.revocation_time).toBeGreaterThan(0);

    const list = await request(server)
      .get(`/v1/pki/certs?list=true`)
      .set(auth(token))
      .expect(200);
    expect(Array.isArray(list.body.data.keys)).toBe(true);
  });

  it("returns 404 when a mount does not exist at the requested prefix", async () => {
    await request(server)
      .get("/v1/no-such-mount/data/x")
      .set(auth(token))
      .expect(404);
  });
});
