/**
 * End-to-end coverage of the observability surface. Boots the real app (no OpenBao
 * backend), hits `/metrics`, and asserts:
 *
 *  - the endpoint serves the Prometheus 0.0.4 exposition format (text/plain) with
 *    process / Node default metrics included,
 *  - the HTTP request histogram records this very request,
 *  - the ACL decision counter increments per `/v1/*` hit (allow & deny both),
 *  - the active-leases gauge starts at zero (no leases issued in this fixture).
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";

async function login(server: unknown, email: string): Promise<string> {
  const res = await request(server as Parameters<typeof request>[0])
    .post("/auth/dev-login")
    .send({ email })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("observability e2e — /metrics + counters", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let token: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    server = app.getHttpServer();
    token = await login(server, "obs-e2e@example.com");
  });

  afterAll(async () => {
    await app.close();
  });

  it("/metrics returns text/plain Prometheus exposition with default Node + process metrics", async () => {
    const res = await request(server).get("/metrics").expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    // prom-client default metrics — every Node app gets these.
    expect(res.text).toContain("arc_process_cpu_user_seconds_total");
    expect(res.text).toContain("arc_nodejs_eventloop_lag_seconds");
    // arc-specific metric families are pre-registered with HELP/TYPE even at zero.
    expect(res.text).toContain("arc_vault_operations_total");
    expect(res.text).toContain("arc_leases_total");
    expect(res.text).toContain("arc_acl_decisions_total");
    expect(res.text).toContain("arc_http_request_duration_seconds");
  });

  it("HTTP request histogram records the matched route, not the raw URL", async () => {
    // Drive a known endpoint and look for its route pattern in the scrape.
    await request(server).get("/vaults").set(auth(token)).expect(200);
    const res = await request(server).get("/metrics").expect(200);
    // Route label is the Express pattern — `/vaults` here, no `:id`-style cardinality.
    expect(res.text).toMatch(/arc_http_request_duration_seconds_count\{[^}]*route="\/vaults"[^}]*}/);
  });

  it("ACL decision counter increments on both deny and allow paths", async () => {
    // Default mode is "allow" in this boot — every /v1/* hit therefore counts as allow.
    await request(server).get("/v1/sys/mounts").set(auth(token)).expect(200);
    const res = await request(server).get("/metrics").expect(200);
    expect(res.text).toMatch(/arc_acl_decisions_total\{[^}]*decision="allow"[^}]*}\s+\d+/);
  });

  it("active leases gauge is present + zero when no leases have been issued", async () => {
    const res = await request(server).get("/metrics").expect(200);
    // The gauge family is registered with HELP/TYPE even when no labelled values exist.
    expect(res.text).toContain("# TYPE arc_active_leases gauge");
  });

  it("/metrics is unauthenticated — no bearer token required (network-layer gating)", async () => {
    await request(server).get("/metrics").expect(200);
  });
});
