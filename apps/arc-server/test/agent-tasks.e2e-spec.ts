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
  ZERO_CHAIN,
} from "@arc/crypto";
import { scope } from "@arc/grants";
import { agentSubject, userSubject, type DelegationClaims, type IntentClaims } from "@arc/types";
import { AppModule } from "../src/app.module";
import { GrantsService } from "../src/grants/grants.service";

const PW = "correct horse battery staple";
const profile = "test" as const;

const hybridPubFrom = (s: ReturnType<typeof enroll>["session"]) => ({
  x25519Pub: s.identityPub,
  mlkemPub: s.identityPubMlkem,
});

function enrollDtoFrom(e: ReturnType<typeof enroll>) {
  return {
    saltMk: e.keyset.saltMk,
    saltAuth: e.keyset.saltAuth,
    argonParams: e.keyset.argonParams,
    authHash: e.keyset.authHash,
    identityPublicKey: e.keyset.identityPublicKey,
    identityPublicKeyMlkem: e.keyset.identityPublicKeyMlkem,
    signingPublicKey: e.keyset.signingPublicKey,
    identitySelfAttestation: e.keyset.identitySelfAttestation,
    encIdentityPriv: e.keyset.encIdentityPriv,
    encIdentityPrivMlkem: e.keyset.encIdentityPrivMlkem,
    encSigningPriv: e.keyset.encSigningPriv,
    encIdentityPrivRecovery: e.keyset.encIdentityPrivRecovery,
    encIdentityPrivMlkemRecovery: e.keyset.encIdentityPrivMlkemRecovery,
    ownerGrant: wrapVaultKeyFor(e.personalVaultKey.vk, hybridPubFrom(e.session)),
  };
}

describe("Engine-C signed intents + task chain (ADR-005 Phase 3)", () => {
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

  afterAll(async () => {
    await app.close();
  });

  async function login(email: string): Promise<{ token: string; userId: number }> {
    const res = await request(server).post("/auth/dev-login").send({ email }).expect(201);
    return { token: res.body.accessToken, userId: res.body.userId };
  }
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  function freshAgentKeys() {
    const signing = generateSigningKeyPair();
    const id = generateIdentityKeyPair();
    const hybrid = generateHybridIdentityKeyPair();
    return {
      signing,
      signingPublicKey: toB64u(signing.pub),
      identityPublicKey: toB64u(id.pub),
      identityPublicKeyMlkem: toB64u(hybrid.mlkem.publicKey),
    };
  }

  /** Build a signed intent. `argsForDigest` defaults to `args` (set differently to forge a mismatch). */
  function buildIntent(
    agentId: string,
    signingPriv: Uint8Array,
    f: { taskId: string; op: string; path: string; delegationId?: string | null; args?: unknown; argsForDigest?: unknown },
  ) {
    const args = f.args ?? null;
    const claims: IntentClaims = {
      v: 1,
      agent: agentSubject(agentId),
      delegation: f.delegationId ?? null,
      taskId: f.taskId,
      op: f.op,
      path: f.path,
      argsDigest: intentArgsDigest((f.argsForDigest ?? args) as never),
      ts: new Date().toISOString(),
      nonce: toB64u(randomBytes(16)),
    };
    const signature = signIntent(signingPriv, claims);
    return { claims, signature, args };
  }

  /** Full fixture: delegator enrolled, agent registered, ceilings seeded, read delegation created. */
  async function setup(email: string, label: string) {
    const E = enroll(PW, { profile });
    const a = await login(email);
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(E)).expect(201);
    const keys = freshAgentKeys();
    const reg = await request(server)
      .post("/vault/agents")
      .set(auth(a.token))
      .send({
        displayName: label,
        signingPublicKey: keys.signingPublicKey,
        identityPublicKey: keys.identityPublicKey,
        identityPublicKeyMlkem: keys.identityPublicKeyMlkem,
      })
      .expect(201);
    const agentId: string = reg.body.id;
    await grants.upsertPolicy({ name: `${label}-deleg`, scopes: [scope("secret/data/app", ["read"])] });
    await grants.attach(userSubject(a.userId), `${label}-deleg`);
    await grants.upsertPolicy({ name: `${label}-agent`, scopes: [scope("secret/data/app", ["read"])] });
    await grants.attach(agentSubject(agentId), `${label}-agent`);

    const claims: DelegationClaims = {
      v: 1,
      delegator: userSubject(a.userId),
      agent: agentSubject(agentId),
      scopes: [{ pathPrefix: "secret/data/app", capabilities: ["read"] }],
      taskId: randomUUID(),
      notBefore: new Date(Date.now() - 1000).toISOString(),
      notAfter: new Date(Date.now() + 3_600_000).toISOString(),
      maxCalls: null,
      elevated: false,
      nonce: toB64u(randomBytes(16)),
    };
    const sig = signDelegation(E.session.signingPriv, claims);
    const del = await request(server)
      .post(`/vault/agents/${agentId}/delegations`)
      .set(auth(a.token))
      .send({ claims, signature: sig })
      .expect(201);
    return { token: a.token, agentId, signingPriv: keys.signing.priv, delegationId: del.body.id as string };
  }

  it("opens a task, chains allowed + denied intents, and verifies the chain", async () => {
    const { token, agentId, signingPriv, delegationId } = await setup("p3a@example.com", "p3a");
    const task = await request(server)
      .post(`/vault/agents/${agentId}/tasks`)
      .set(auth(token))
      .send({ delegationId })
      .expect(201);
    const taskId: string = task.body.taskId;

    // Allowed read → seq 0, chain advances off ZERO_CHAIN.
    const i0 = buildIntent(agentId, signingPriv, { taskId, op: "kv.read", path: "secret/data/app/db", delegationId, args: { k: "DATABASE_URL" } });
    let r = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(i0).expect(201);
    expect(r.body).toMatchObject({ decision: "allow", seq: 0 });
    expect(r.body.chainHead).not.toBe(ZERO_CHAIN);
    const headAfter0: string = r.body.chainHead;

    // Out-of-scope delete → recorded as deny, chain still advances (seq 1).
    const i1 = buildIntent(agentId, signingPriv, { taskId, op: "kv.delete", path: "secret/data/app/db", delegationId });
    r = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(i1).expect(201);
    expect(r.body).toMatchObject({ decision: "deny", seq: 1 });
    expect(r.body.chainHead).not.toBe(headAfter0);

    // Verify the recorded chain reproduces the task head.
    const v = await request(server).get(`/vault/agents/${agentId}/tasks/${taskId}?verify=true`).set(auth(token)).expect(200);
    expect(v.body).toMatchObject({ chainOk: true, length: 2, callsUsed: 2 });
    expect(v.body.recomputedHead).toBe(r.body.chainHead);
  });

  it("rejects a forged args digest and a wrong-key signature", async () => {
    const { token, agentId, signingPriv, delegationId } = await setup("p3b@example.com", "p3b");
    const task = await request(server).post(`/vault/agents/${agentId}/tasks`).set(auth(token)).send({ delegationId }).expect(201);
    const taskId: string = task.body.taskId;

    // argsDigest computed over a different body than the one sent → 400.
    const forged = buildIntent(agentId, signingPriv, {
      taskId, op: "kv.read", path: "secret/data/app/db", delegationId,
      args: { k: "real" }, argsForDigest: { k: "claimed-something-else" },
    });
    const r1 = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(forged).expect(400);
    expect(r1.body.error).toBe("args_digest_mismatch");

    // Signed by an unrelated key → signature verification fails.
    const wrong = generateSigningKeyPair();
    const badSig = buildIntent(agentId, wrong.priv, { taskId, op: "kv.read", path: "secret/data/app/db", delegationId });
    const r2 = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(badSig).expect(400);
    expect(r2.body.error).toBe("invalid_intent_signature");
  });

  it("enforces the task call budget", async () => {
    const { token, agentId, signingPriv, delegationId } = await setup("p3c@example.com", "p3c");
    const task = await request(server)
      .post(`/vault/agents/${agentId}/tasks`)
      .set(auth(token))
      .send({ delegationId, budget: { maxCalls: 1 } })
      .expect(201);
    const taskId: string = task.body.taskId;

    const ok = buildIntent(agentId, signingPriv, { taskId, op: "kv.read", path: "secret/data/app/db", delegationId });
    const r1 = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(ok).expect(201);
    expect(r1.body.callsRemaining).toBe(0);

    const over = buildIntent(agentId, signingPriv, { taskId, op: "kv.read", path: "secret/data/app/db", delegationId });
    const r2 = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(over).expect(409);
    expect(r2.body.error).toBe("task_budget_exhausted");
  });

  it("closing a task cascades revoke and refuses further intents", async () => {
    const { token, agentId, signingPriv, delegationId } = await setup("p3d@example.com", "p3d");
    const task = await request(server).post(`/vault/agents/${agentId}/tasks`).set(auth(token)).send({ delegationId }).expect(201);
    const taskId: string = task.body.taskId;

    // One good action, then close.
    const i0 = buildIntent(agentId, signingPriv, { taskId, op: "kv.read", path: "secret/data/app/db", delegationId });
    await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(i0).expect(201);

    const close = await request(server).post(`/vault/agents/${agentId}/tasks/${taskId}/close`).set(auth(token)).expect(201);
    expect(close.body.ok).toBe(true);
    expect(close.body.revokedDelegations).toBe(1);

    // The delegation is now revoked → authorize reflects it.
    const dec = await request(server)
      .post(`/vault/agents/${agentId}/authorize`)
      .set(auth(token))
      .send({ path: "secret/data/app/db", capability: "read", delegationId })
      .expect(201);
    expect(dec.body.reason).toBe("delegation-revoked");

    // Further intents on the closed task are refused.
    const i1 = buildIntent(agentId, signingPriv, { taskId, op: "kv.read", path: "secret/data/app/db", delegationId });
    const r = await request(server).post(`/vault/agents/${agentId}/intents`).set(auth(token)).send(i1).expect(409);
    expect(r.body.error).toBe("task_not_open");
  });

  /**
   * HIGH-D regression (audit: human→agent→action trust chain). ADR-005 §3/§4 claim
   * "Replay is blocked by nonce + task-chain position" — but the implementation
   * never enforced nonce uniqueness. Submitting an identical signed intent twice
   * folded it into the chain twice, double-incrementing callsUsed and growing the
   * intent ledger. The fix: an `intentDigest` column on `vault_agent_intents` with
   * a UNIQUE constraint per `(taskId, intentDigest)`, plus an explicit pre-check
   * inside the submit transaction so we return a clean 409 instead of a raw
   * constraint violation.
   */
  it("rejects an identical resubmitted signed intent with 409 intent_replay", async () => {
    const { token, agentId, signingPriv, delegationId } = await setup("replay@example.com", "replay");
    const task = await request(server)
      .post(`/vault/agents/${agentId}/tasks`)
      .set(auth(token)).send({ delegationId }).expect(201);
    const taskId: string = task.body.taskId;

    const i0 = buildIntent(agentId, signingPriv, {
      taskId, op: "kv.read", path: "secret/data/app/db", delegationId, args: { k: "DATABASE_URL" },
    });

    // First submit lands.
    const ok = await request(server)
      .post(`/vault/agents/${agentId}/intents`)
      .set(auth(token)).send(i0).expect(201);
    expect(ok.body).toMatchObject({ decision: "allow", seq: 0 });
    const headAfterOne: string = ok.body.chainHead;

    // Exact same payload → 409 intent_replay. Chain MUST NOT advance, budget MUST NOT
    // increment. Verifying via getTask(verify=true): length stays 1, callsUsed stays 1.
    const dupe = await request(server)
      .post(`/vault/agents/${agentId}/intents`)
      .set(auth(token)).send(i0).expect(409);
    expect(dupe.body.error).toBe("intent_replay");

    const after = await request(server)
      .get(`/vault/agents/${agentId}/tasks/${taskId}?verify=true`)
      .set(auth(token)).expect(200);
    expect(after.body).toMatchObject({
      chainOk: true,
      length: 1,
      callsUsed: 1,
      chainHead: headAfterOne,
    });

    // A *new* intent (different nonce, same op + path) still works — only true replays
    // are blocked, not legitimate sequential reads.
    const i1 = buildIntent(agentId, signingPriv, {
      taskId, op: "kv.read", path: "secret/data/app/db", delegationId, args: { k: "DATABASE_URL" },
    });
    const next = await request(server)
      .post(`/vault/agents/${agentId}/intents`)
      .set(auth(token)).send(i1).expect(201);
    expect(next.body).toMatchObject({ decision: "allow", seq: 1 });
    expect(next.body.chainHead).not.toBe(headAfterOne);
  });
});
