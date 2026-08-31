/**
 * End-to-end coverage of the auth-method plugins (OIDC + Kubernetes + SPIFFE) through the
 * real app:
 * `PluginsService.mountAuthPlugin` + `POST /v1/auth/<mount>/login`. Boots with
 * `ARC_DEFAULT_POLICY=deny` so we can prove the login actually binds the role's policies —
 * a freshly-minted token reaches exactly the paths its policy covers, and 403s elsewhere.
 *
 * The plugins are mounted with fake verifier / reviewer so the suite is hermetic (no live
 * IdP / cluster); each plugin's real JWKS / TokenReview logic is unit-tested in its own
 * package.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { scope } from "@arc/grants";
import { OidcAuthPlugin, type JwtVerifier } from "@arc/plugin-oidc";
import { KubernetesAuthPlugin, type TokenReviewer } from "@arc/plugin-kubernetes";
import { SpiffeAuthPlugin, type JwtSvidVerifier } from "@arc/plugin-spiffe";
import { AppModule } from "../src/app.module";
import { AuthMethodsService } from "../src/auth-methods/auth-methods.service";
import { GrantsService } from "../src/grants/grants.service";

const oidcVerifier: JwtVerifier = {
  async verify(token, expected) {
    if (token === "bad") throw new Error("oidc: JWT signature verification failed");
    return { sub: "ci-bot", aud: "arc", iss: expected.issuer };
  },
};

const k8sReviewer: TokenReviewer = {
  async review(token) {
    if (token === "bad") return { authenticated: false, error: "token expired" };
    return { authenticated: true, username: "system:serviceaccount:apps:deployer", uid: "uid-1" };
  },
};

const SPIFFE_TRUST_DOMAIN = "prod.example.com";
const SPIFFE_ID = `spiffe://${SPIFFE_TRUST_DOMAIN}/ns/prod/sa/api`;

/**
 * Fake JWT-SVID verifier: `good` verifies to a workload in the trust domain, `foreign`
 * verifies but belongs to another trust domain (proving the plugin's own trust-domain check
 * runs even when the signature is accepted).
 */
const svidVerifier: JwtSvidVerifier = {
  async verify(svid) {
    if (svid === "bad") throw new Error("spiffe: JWT-SVID signature verification failed");
    const sub = svid === "foreign" ? "spiffe://evil.example.com/ns/prod/sa/api" : SPIFFE_ID;
    return { sub, aud: ["arc"], exp: Math.floor(Date.now() / 1000) + 300 };
  },
};

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("auth-plugins e2e — OIDC + Kubernetes + SPIFFE login bind policies to the minted token", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let grants: GrantsService;

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
      const methods = app.get(AuthMethodsService);

      // A named policy the auth roles reference; covers read on the `secret/` mount only.
      await grants.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });

      await methods.mount(new OidcAuthPlugin(oidcVerifier), "oidc", {
        issuer: "https://idp.example.com",
        roles: { ci: { boundAudiences: ["arc"], policies: ["reader"] } },
      });
      await methods.mount(new KubernetesAuthPlugin(k8sReviewer), "kubernetes", {
        roles: { deploy: { boundServiceAccountNames: ["deployer"], boundNamespaces: ["apps"], policies: ["reader"] } },
      });
      await methods.mount(new SpiffeAuthPlugin(svidVerifier), "spiffe", {
        trustDomain: SPIFFE_TRUST_DOMAIN,
        trustBundle: { keys: [{ kid: "k1", kty: "EC" }] },
        roles: {
          api: {
            boundSpiffeIdPrefixes: ["/ns/prod/sa/"],
            boundAudiences: ["arc"],
            policies: ["reader"],
          },
        },
      });
    } finally {
      if (saved === undefined) delete process.env.ARC_DEFAULT_POLICY;
      else process.env.ARC_DEFAULT_POLICY = saved;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it("OIDC login returns an identity + policies + a usable token", async () => {
    const res = await request(server).post("/v1/auth/oidc/login").send({ role: "ci", jwt: "good" }).expect(200);
    const data = res.body.data as { token: string; identityId: string; policies: string[] };
    expect(data.identityId).toBe("ci-bot");
    expect(data.policies).toEqual(["reader"]);
    expect(typeof data.token).toBe("string");
  });

  it("the OIDC-minted token reaches the covered path and is forbidden elsewhere", async () => {
    const res = await request(server).post("/v1/auth/oidc/login").send({ role: "ci", jwt: "good" }).expect(200);
    const token = (res.body.data as { token: string }).token;

    // Covered by the `reader` policy (read on secret/): authorized → NOT 403 (Engine-A is
    // disabled in tests, so the request gets through the guard and 503s at the backend).
    const covered = await request(server).get("/v1/secret/data/app").set(auth(token));
    expect(covered.status).not.toBe(401);
    expect(covered.status).not.toBe(403);

    // Not covered: read on transit/ is outside the policy → 403 from the CapabilityGuard.
    const forbidden = await request(server).get("/v1/transit/keys/foo").set(auth(token));
    expect(forbidden.status).toBe(403);
  });

  it("Kubernetes login authenticates a matching ServiceAccount and binds its policies", async () => {
    const res = await request(server)
      .post("/v1/auth/kubernetes/login")
      .send({ role: "deploy", jwt: "sa-token" })
      .expect(200);
    const data = res.body.data as { token: string; identityId: string; policies: string[] };
    expect(data.identityId).toBe("system:serviceaccount:apps:deployer");
    expect(data.policies).toEqual(["reader"]);

    const covered = await request(server).get("/v1/secret/data/app").set(auth(data.token));
    expect(covered.status).not.toBe(403);
  });

  it("SPIFFE login exchanges a JWT-SVID for a policy-bound arc token", async () => {
    const res = await request(server)
      .post("/v1/auth/spiffe/login")
      .send({ role: "api", svid: "good" })
      .expect(200);
    const data = res.body.data as {
      token: string;
      identityId: string;
      policies: string[];
      metadata: Record<string, string>;
    };
    // The arc identity *is* the SPIFFE ID — no separately managed credential.
    expect(data.identityId).toBe(SPIFFE_ID);
    expect(data.policies).toEqual(["reader"]);
    expect(data.metadata).toMatchObject({ trustDomain: SPIFFE_TRUST_DOMAIN, spiffePath: "/ns/prod/sa/api" });

    const covered = await request(server).get("/v1/secret/data/app").set(auth(data.token));
    expect(covered.status).not.toBe(403);
    const forbidden = await request(server).get("/v1/transit/keys/foo").set(auth(data.token));
    expect(forbidden.status).toBe(403);
  });

  it("SPIFFE login rejects a verified SVID from a foreign trust domain (401)", async () => {
    await request(server).post("/v1/auth/spiffe/login").send({ role: "api", svid: "foreign" }).expect(401);
  });

  it("rejects a token the plugin can't verify (401)", async () => {
    await request(server).post("/v1/auth/oidc/login").send({ role: "ci", jwt: "bad" }).expect(401);
    await request(server).post("/v1/auth/kubernetes/login").send({ role: "deploy", jwt: "bad" }).expect(401);
    await request(server).post("/v1/auth/spiffe/login").send({ role: "api", svid: "bad" }).expect(401);
  });

  it("rejects an unknown role (401) and an unmounted auth method (404)", async () => {
    await request(server).post("/v1/auth/oidc/login").send({ role: "ghost", jwt: "good" }).expect(401);
    await request(server).post("/v1/auth/saml/login").send({ role: "x", jwt: "y" }).expect(404);
  });
});
