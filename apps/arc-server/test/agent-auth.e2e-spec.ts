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
  signObject,
  toB64u,
  wrapVaultKeyFor,
} from "@arc/crypto";
import { scope } from "@arc/grants";
import { agentSubject, userSubject, type DelegationClaims, type IntentClaims } from "@arc/types";
import { AppModule } from "../src/app.module";
import { GrantsService } from "../src/grants/grants.service";

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

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

describe("Engine-C agent self-authentication (ADR-005)", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let grants: GrantsService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    server = app.getHttpServer();
    grants = app.get(GrantsService);
  });
  afterAll(async () => { await app.close(); });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  async function login(email: string) {
    const r = await request(server).post("/auth/dev-login").send({ email }).expect(201);
    return { token: r.body.accessToken as string, userId: r.body.userId as number };
  }

  async function registerAgent(ownerToken: string, name: string) {
    const signing = generateSigningKeyPair();
    const reg = await request(server)
      .post("/vault/agents")
      .set(auth(ownerToken))
      .send({
        displayName: name,
        signingPublicKey: toB64u(signing.pub),
        identityPublicKey: toB64u(generateIdentityKeyPair().pub),
        identityPublicKeyMlkem: toB64u(generateHybridIdentityKeyPair().mlkem.publicKey),
      })
      .expect(201);
    return { agentId: reg.body.id as string, signing };
  }

  /** Run the challenge-response and return the agent token. */
  async function agentToken(agentId: string, signingPriv: Uint8Array): Promise<string> {
    const ch = await request(server).post(`/vault/agents/${agentId}/auth/challenge`).expect(201);
    const signature = signObject(signingPriv, { v: 1, purpose: "agent-auth", agent: agentSubject(agentId), nonce: ch.body.nonce });
    const tok = await request(server).post(`/vault/agents/${agentId}/auth/token`).send({ signature }).expect(201);
    return tok.body.accessToken as string;
  }

  it("agent authenticates with its signing key and submits its own intents; token carries the act claim", async () => {
    const E = enroll(PW, { profile });
    const a = await login("agentauth-owner@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(E)).expect(201);
    const { agentId, signing } = await registerAgent(a.token, "self-auth-bot");

    await grants.upsertPolicy({ name: "aa-d", scopes: [scope("secret/data/app", ["read"])] });
    await grants.attach(userSubject(a.userId), "aa-d");
    await grants.upsertPolicy({ name: "aa-a", scopes: [scope("secret/data/app", ["read"])] });
    await grants.attach(agentSubject(agentId), "aa-a");

    const dclaims: DelegationClaims = {
      v: 1, delegator: userSubject(a.userId), agent: agentSubject(agentId),
      scopes: [{ pathPrefix: "secret/data/app", capabilities: ["read"] }], taskId: randomUUID(),
      notBefore: new Date(Date.now() - 1000).toISOString(), notAfter: new Date(Date.now() + 3_600_000).toISOString(),
      maxCalls: null, elevated: false, nonce: toB64u(randomBytes(16)),
    };
    const del = await request(server).post(`/vault/agents/${agentId}/delegations`).set(auth(a.token))
      .send({ claims: dclaims, signature: signDelegation(E.session.signingPriv, dclaims) }).expect(201);
    const task = await request(server).post(`/vault/agents/${agentId}/tasks`).set(auth(a.token)).send({ delegationId: del.body.id }).expect(201);

    // Agent obtains its own token; it carries owner sub + agentId + RFC 8693 act claim.
    const token = await agentToken(agentId, signing.priv);
    const payload = decodeJwt(token);
    expect(payload.sub).toBe(a.userId);
    expect(payload.agentId).toBe(agentId);
    expect(payload.act).toEqual({ sub: agentSubject(agentId) });

    // Submit an intent authenticated with the AGENT's own token (not the owner's).
    const iclaims: IntentClaims = {
      v: 1, agent: agentSubject(agentId), delegation: del.body.id, taskId: task.body.taskId,
      op: "kv.read", path: "secret/data/app/db", argsDigest: intentArgsDigest({ k: "x" } as never),
      ts: new Date().toISOString(), nonce: toB64u(randomBytes(16)),
    };
    const r = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token))
      .send({ claims: iclaims, signature: signIntent(signing.priv, iclaims), args: { k: "x" } }).expect(201);
    expect(r.body).toMatchObject({ decision: "allow", seq: 0 });
  });

  it("an agent token can only submit its own intents", async () => {
    const a = await login("agentauth-owner2@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(enroll(PW, { profile }))).expect(201);
    const one = await registerAgent(a.token, "agent-one");
    const two = await registerAgent(a.token, "agent-two");
    const tokenOne = await agentToken(one.agentId, one.signing.priv);

    // Use agent-one's token to target agent-two's intent endpoint → 403.
    const iclaims: IntentClaims = {
      v: 1, agent: agentSubject(two.agentId), delegation: null, taskId: randomUUID(),
      op: "kv.read", path: "secret/data/app/db", argsDigest: intentArgsDigest(null),
      ts: new Date().toISOString(), nonce: toB64u(randomBytes(16)),
    };
    const r = await request(server).post(`/vault/agents/${two.agentId}/intents`).set(auth(tokenOne))
      .send({ claims: iclaims, signature: signIntent(two.signing.priv, iclaims), args: null }).expect(403);
    expect(r.body.error).toBe("agent_token_scope_mismatch");
  });

  it("a wrong-key challenge signature is rejected", async () => {
    const a = await login("agentauth-owner3@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(enroll(PW, { profile }))).expect(201);
    const { agentId } = await registerAgent(a.token, "badsig-bot");
    const ch = await request(server).post(`/vault/agents/${agentId}/auth/challenge`).expect(201);
    const wrong = generateSigningKeyPair();
    const signature = signObject(wrong.priv, { v: 1, purpose: "agent-auth", agent: agentSubject(agentId), nonce: ch.body.nonce });
    const r = await request(server).post(`/vault/agents/${agentId}/auth/token`).send({ signature }).expect(400);
    expect(r.body.error).toBe("invalid_challenge_signature");
  });
});
