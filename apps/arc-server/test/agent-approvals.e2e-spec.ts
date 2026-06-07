import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  enroll,
  generateHybridIdentityKeyPair,
  generateIdentityKeyPair,
  generateSigningKeyPair,
  intentArgsDigest,
  randomBytes,
  signDelegation,
  signIntent,
  toB64u,
  wrapVaultKeyFor,
} from "@arc/crypto";
import { scope } from "@arc/grants";
import { agentSubject, userSubject, type DelegationClaims, type IntentClaims } from "@arc/types";
import { AppModule } from "../src/app.module";
import { GrantsService } from "../src/grants/grants.service";
import { FakeAuthenticator, ORIGIN, RP_ID, stubEnvelope } from "./helpers/fake-authenticator";

const PW = "correct horse battery staple";
const profile = "test" as const;

const hybridPubFrom = (s: ReturnType<typeof enroll>["session"]) => ({ x25519Pub: s.identityPub, mlkemPub: s.identityPubMlkem });

function enrollDtoFrom(e: ReturnType<typeof enroll>) {
  return {
    saltMk: e.keyset.saltMk, saltAuth: e.keyset.saltAuth, argonParams: e.keyset.argonParams,
    authHash: e.keyset.authHash, identityPublicKey: e.keyset.identityPublicKey,
    identityPublicKeyMlkem: e.keyset.identityPublicKeyMlkem, signingPublicKey: e.keyset.signingPublicKey,
    identitySelfAttestation: e.keyset.identitySelfAttestation, encIdentityPriv: e.keyset.encIdentityPriv,
    encIdentityPrivMlkem: e.keyset.encIdentityPrivMlkem, encSigningPriv: e.keyset.encSigningPriv,
    encIdentityPrivRecovery: e.keyset.encIdentityPrivRecovery,
    encIdentityPrivMlkemRecovery: e.keyset.encIdentityPrivMlkemRecovery,
    ownerGrant: wrapVaultKeyFor(e.personalVaultKey.vk, hybridPubFrom(e.session)),
  };
}

describe("Engine-C push-consent for elevated ops (ADR-005 Phase 4)", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let grants: GrantsService;
  const savedEnv = { rp: process.env.ARC_PASSKEY_RP_ID, origin: process.env.ARC_PASSKEY_ORIGIN };

  beforeAll(async () => {
    process.env.ARC_PASSKEY_RP_ID = RP_ID;
    process.env.ARC_PASSKEY_ORIGIN = ORIGIN;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    server = app.getHttpServer();
    grants = app.get(GrantsService);
  });

  afterAll(async () => {
    await app.close();
    if (savedEnv.rp === undefined) delete process.env.ARC_PASSKEY_RP_ID; else process.env.ARC_PASSKEY_RP_ID = savedEnv.rp;
    if (savedEnv.origin === undefined) delete process.env.ARC_PASSKEY_ORIGIN; else process.env.ARC_PASSKEY_ORIGIN = savedEnv.origin;
  });

  async function login(email: string): Promise<{ token: string; userId: number }> {
    const res = await request(server).post("/auth/dev-login").send({ email }).expect(201);
    return { token: res.body.accessToken, userId: res.body.userId };
  }
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** Register a real WebAuthn passkey for the logged-in owner; returns the authenticator. */
  async function registerPasskey(token: string): Promise<FakeAuthenticator> {
    const authn = new FakeAuthenticator();
    const opts = await request(server).post("/vault/passkey/register-challenge").set(auth(token)).expect(201);
    const att = authn.registration(opts.body.challenge as string);
    await request(server)
      .post("/vault/passkey/register")
      .set(auth(token))
      .send({
        registration: { id: att.id, rawId: att.id, type: "public-key", response: { attestationObject: att.attestationObject, clientDataJSON: att.clientDataJSON }, clientExtensionResults: {} },
        encIdentityPrivPasskey: stubEnvelope(), encIdentityPrivMlkemPasskey: stubEnvelope(), encSigningPrivPasskey: stubEnvelope(),
        label: "owner-phone",
      })
      .expect(201);
    return authn;
  }

  /** Full elevated fixture: owner enrolled + passkey, agent, ceilings, elevated delegation, open task. */
  async function setup(email: string, label: string) {
    const E = enroll(PW, { profile });
    const a = await login(email);
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(E)).expect(201);
    const authn = await registerPasskey(a.token);

    const signing = generateSigningKeyPair();
    const reg = await request(server)
      .post("/vault/agents")
      .set(auth(a.token))
      .send({
        displayName: label,
        signingPublicKey: toB64u(signing.pub),
        identityPublicKey: toB64u(generateIdentityKeyPair().pub),
        identityPublicKeyMlkem: toB64u(generateHybridIdentityKeyPair().mlkem.publicKey),
      })
      .expect(201);
    const agentId: string = reg.body.id;
    await grants.upsertPolicy({ name: `${label}-d`, scopes: [scope("secret/data/app", ["read"])] });
    await grants.attach(userSubject(a.userId), `${label}-d`);
    await grants.upsertPolicy({ name: `${label}-a`, scopes: [scope("secret/data/app", ["read"])] });
    await grants.attach(agentSubject(agentId), `${label}-a`);

    // An ELEVATED delegation — each use needs push-consent.
    const claims: DelegationClaims = {
      v: 1, delegator: userSubject(a.userId), agent: agentSubject(agentId),
      scopes: [{ pathPrefix: "secret/data/app", capabilities: ["read"] }],
      taskId: randomUUID(), notBefore: new Date(Date.now() - 1000).toISOString(),
      notAfter: new Date(Date.now() + 3_600_000).toISOString(), maxCalls: null,
      elevated: true, nonce: toB64u(randomBytes(16)),
    };
    const del = await request(server)
      .post(`/vault/agents/${agentId}/delegations`)
      .set(auth(a.token))
      .send({ claims, signature: signDelegation(E.session.signingPriv, claims) })
      .expect(201);
    const task = await request(server).post(`/vault/agents/${agentId}/tasks`).set(auth(a.token)).send({ delegationId: del.body.id }).expect(201);

    // One reusable signed intent (identical on resubmit so its digest matches the approval).
    const iclaims: IntentClaims = {
      v: 1, agent: agentSubject(agentId), delegation: del.body.id, taskId: task.body.taskId,
      op: "kv.read", path: "secret/data/app/db", argsDigest: intentArgsDigest({ k: "DB" } as never),
      ts: new Date().toISOString(), nonce: toB64u(randomBytes(16)),
    };
    const intent = { claims: iclaims, signature: signIntent(signing.priv, iclaims), args: { k: "DB" } };
    return { token: a.token, agentId, taskId: task.body.taskId as string, authn, intent };
  }

  it("elevated intent is blocked pending approval, then a passkey grant lets the resubmit through", async () => {
    const { token, agentId, taskId, authn, intent } = await setup("appr-grant@example.com", "g");

    // 1) First submit → blocked, pending approval created, action NOT recorded.
    let r = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(intent).expect(201);
    expect(r.body).toMatchObject({ decision: "deny", reason: "approval-required", elevated: true });
    expect(r.body.approvalId).toBeTruthy();
    let v = await request(server).get(`/vault/agents/${agentId}/tasks/${taskId}?verify=true`).set(auth(token)).expect(200);
    expect(v.body.callsUsed).toBe(0);

    // 2) Owner sees it pending.
    const pend = await request(server).get(`/vault/approvals`).set(auth(token)).expect(200);
    expect(pend.body).toHaveLength(1);
    expect(pend.body[0]).toMatchObject({ id: r.body.approvalId, op: "kv.read", path: "secret/data/app/db" });

    // 3) Owner proves control with a WebAuthn assertion → approval granted.
    const ch = await request(server).post(`/vault/approvals/${r.body.approvalId}/challenge`).set(auth(token)).expect(201);
    const ast = authn.assertion(ch.body.challenge as string);
    await request(server)
      .post(`/vault/approvals/${r.body.approvalId}/approve`)
      .set(auth(token))
      .send({ assertion: { id: ast.id, rawId: ast.id, type: "public-key", response: { authenticatorData: ast.authenticatorData, clientDataJSON: ast.clientDataJSON, signature: ast.signature }, clientExtensionResults: {} } })
      .expect(201);

    // 4) Resubmit the identical intent → now allowed + recorded (single-use approval consumed).
    r = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(intent).expect(201);
    expect(r.body).toMatchObject({ decision: "allow", seq: 0 });
    v = await request(server).get(`/vault/agents/${agentId}/tasks/${taskId}?verify=true`).set(auth(token)).expect(200);
    expect(v.body).toMatchObject({ callsUsed: 1, chainOk: true });

    // 5) Approval is single-use: a further identical submit is blocked again.
    r = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(intent).expect(201);
    expect(r.body.reason).toBe("approval-required");
  });

  it("a denied approval leaves the elevated action blocked", async () => {
    const { token, agentId, intent } = await setup("appr-deny@example.com", "d");
    const r = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(intent).expect(201);
    expect(r.body.reason).toBe("approval-required");

    await request(server).post(`/vault/approvals/${r.body.approvalId}/deny`).set(auth(token)).expect(201);

    // Re-submit still blocked (a fresh pending is created; nothing was granted).
    const r2 = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(intent).expect(201);
    expect(r2.body.reason).toBe("approval-required");
  });

  it("approve without a WebAuthn assertion is rejected (no tappable yes)", async () => {
    const { token, agentId, intent } = await setup("appr-noassert@example.com", "n");
    const r = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(intent).expect(201);
    // Begin the challenge, then send a garbage assertion → verification fails (401).
    await request(server).post(`/vault/approvals/${r.body.approvalId}/challenge`).set(auth(token)).expect(201);
    await request(server)
      .post(`/vault/approvals/${r.body.approvalId}/approve`)
      .set(auth(token))
      .send({ assertion: { id: "bogus", rawId: "bogus", type: "public-key", response: { authenticatorData: "AA", clientDataJSON: "AA", signature: "AA" }, clientExtensionResults: {} } })
      .expect(401);
  });
});
