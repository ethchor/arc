import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  enroll,
  generateHybridIdentityKeyPair,
  generateIdentityKeyPair,
  generateSigningKeyPair,
  randomBytes,
  signDelegation,
  toB64u,
  wrapVaultKeyFor,
} from "@arc/crypto";
import { scope } from "@arc/grants";
import { agentSubject, userSubject, type DelegationClaims } from "@arc/types";
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

describe("Engine-C agent identity + delegation (ADR-005)", () => {
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

  function delegationClaims(
    delegatorUserId: number,
    agentId: string,
    scopes: DelegationClaims["scopes"],
    over: Partial<DelegationClaims> = {},
  ): DelegationClaims {
    return {
      v: 1,
      delegator: userSubject(delegatorUserId),
      agent: agentSubject(agentId),
      scopes,
      taskId: randomUUID(),
      notBefore: new Date(Date.now() - 1000).toISOString(),
      notAfter: new Date(Date.now() + 3_600_000).toISOString(),
      maxCalls: 100,
      elevated: false,
      nonce: toB64u(randomBytes(16)),
      ...over,
    };
  }

  it("register → delegate → effective-scope intersection is enforced", async () => {
    const E = enroll(PW, { profile });
    const a = await login("delegator@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(E)).expect(201);

    // Register an agent owned by the delegator.
    const keys = freshAgentKeys();
    const reg = await request(server)
      .post("/vault/agents")
      .set(auth(a.token))
      .send({
        displayName: "ci-deploy-bot",
        signingPublicKey: keys.signingPublicKey,
        identityPublicKey: keys.identityPublicKey,
        identityPublicKeyMlkem: keys.identityPublicKeyMlkem,
      })
      .expect(201);
    const agentId: string = reg.body.id;
    expect(reg.body.autonomousAllowed).toBe(false); // deny-by-default
    expect(reg.body.status).toBe("active");

    // Ceilings: delegator can read/update/create under secret/data/app; the agent itself is
    // narrower (read/update only). Seed both directly through the policy engine.
    await grants.upsertPolicy({
      name: "delegator-app",
      scopes: [scope("secret/data/app", ["read", "update", "create"])],
    });
    await grants.attach(userSubject(a.userId), "delegator-app");
    await grants.upsertPolicy({
      name: "agent-app",
      scopes: [scope("secret/data/app", ["read", "update"])],
    });
    await grants.attach(agentSubject(agentId), "agent-app");

    // Delegation: read-only, and only under the narrower secret/data/app/db prefix.
    const claims = delegationClaims(a.userId, agentId, [
      { pathPrefix: "secret/data/app/db", capabilities: ["read"] },
    ]);
    const signature = signDelegation(E.session.signingPriv, claims);
    const del = await request(server)
      .post(`/vault/agents/${agentId}/delegations`)
      .set(auth(a.token))
      .send({ claims, signature })
      .expect(201);
    const delegationId: string = del.body.id;

    const authorize = (body: Record<string, unknown>) =>
      request(server).post(`/vault/agents/${agentId}/authorize`).set(auth(a.token)).send(body);

    // read @ db → allowed by delegation ∩ delegator ∩ agent.
    let r = await authorize({ path: "secret/data/app/db/main", capability: "read", delegationId }).expect(201);
    expect(r.body).toMatchObject({ decision: "allow", mode: "delegated", reason: "scope-match" });

    // update @ db → delegation only granted read → deny.
    r = await authorize({ path: "secret/data/app/db/main", capability: "update", delegationId }).expect(201);
    expect(r.body.decision).toBe("deny");

    // read @ a sibling outside the delegated prefix → deny (delegation scoped to db).
    r = await authorize({ path: "secret/data/app/api/key", capability: "read", delegationId }).expect(201);
    expect(r.body.decision).toBe("deny");
  });

  it("a delegation cannot exceed the delegator's own authority (no escalation)", async () => {
    const E = enroll(PW, { profile });
    const a = await login("delegator2@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(E)).expect(201);

    const keys = freshAgentKeys();
    const reg = await request(server)
      .post("/vault/agents")
      .set(auth(a.token))
      .send({
        displayName: "over-reach-bot",
        signingPublicKey: keys.signingPublicKey,
        identityPublicKey: keys.identityPublicKey,
        identityPublicKeyMlkem: keys.identityPublicKeyMlkem,
      })
      .expect(201);
    const agentId: string = reg.body.id;

    // Delegator only has READ under secret/data/app. Agent has sudo (so the agent ceiling
    // isn't the limiter — the delegator's ceiling is).
    await grants.upsertPolicy({ name: "delegator2-ro", scopes: [scope("secret/data/app", ["read"])] });
    await grants.attach(userSubject(a.userId), "delegator2-ro");
    await grants.upsertPolicy({ name: "agent2-sudo", scopes: [scope("", ["sudo"])] });
    await grants.attach(agentSubject(agentId), "agent2-sudo");

    // The delegation tries to lend DELETE — which the delegator never had.
    const claims = delegationClaims(a.userId, agentId, [
      { pathPrefix: "secret/data/app", capabilities: ["read", "delete"] },
    ]);
    const signature = signDelegation(E.session.signingPriv, claims);
    const del = await request(server)
      .post(`/vault/agents/${agentId}/delegations`)
      .set(auth(a.token))
      .send({ claims, signature })
      .expect(201);
    const delegationId: string = del.body.id;
    const authorize = (body: Record<string, unknown>) =>
      request(server).post(`/vault/agents/${agentId}/authorize`).set(auth(a.token)).send(body);

    // read is fine (all three allow it)…
    expect((await authorize({ path: "secret/data/app/x", capability: "read", delegationId })).body.decision).toBe("allow");
    // …but delete is denied: the delegator can't lend what they lack, even though the agent has sudo.
    expect((await authorize({ path: "secret/data/app/x", capability: "delete", delegationId })).body.decision).toBe("deny");
  });

  it("rejects a delegation signed by the wrong key / claiming a different delegator", async () => {
    const E = enroll(PW, { profile });
    const a = await login("delegator3@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(E)).expect(201);
    const keys = freshAgentKeys();
    const reg = await request(server)
      .post("/vault/agents")
      .set(auth(a.token))
      .send({
        displayName: "sig-check-bot",
        signingPublicKey: keys.signingPublicKey,
        identityPublicKey: keys.identityPublicKey,
        identityPublicKeyMlkem: keys.identityPublicKeyMlkem,
      })
      .expect(201);
    const agentId: string = reg.body.id;

    // Signed by an unrelated key → signature verification fails.
    const claims = delegationClaims(a.userId, agentId, [
      { pathPrefix: "secret/data/app", capabilities: ["read"] },
    ]);
    const wrong = generateSigningKeyPair();
    const badSig = signDelegation(wrong.priv, claims);
    const r1 = await request(server)
      .post(`/vault/agents/${agentId}/delegations`)
      .set(auth(a.token))
      .send({ claims, signature: badSig })
      .expect(400);
    expect(r1.body.error).toBe("invalid_delegation_signature");

    // Correct signature but the claims name a different delegator → forbidden.
    const spoof = delegationClaims(a.userId, agentId, [
      { pathPrefix: "secret/data/app", capabilities: ["read"] },
    ]);
    spoof.delegator = userSubject(99999);
    const sig = signDelegation(E.session.signingPriv, spoof);
    await request(server)
      .post(`/vault/agents/${agentId}/delegations`)
      .set(auth(a.token))
      .send({ claims: spoof, signature: sig })
      .expect(403);
  });

  it("autonomous mode is deny-by-default and opt-in; revoke + budget close the door", async () => {
    const E = enroll(PW, { profile });
    const a = await login("delegator4@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(E)).expect(201);
    const keys = freshAgentKeys();
    const reg = await request(server)
      .post("/vault/agents")
      .set(auth(a.token))
      .send({
        displayName: "autonomous-bot",
        signingPublicKey: keys.signingPublicKey,
        identityPublicKey: keys.identityPublicKey,
        identityPublicKeyMlkem: keys.identityPublicKeyMlkem,
      })
      .expect(201);
    const agentId: string = reg.body.id;
    await grants.upsertPolicy({ name: "agent4-app", scopes: [scope("secret/data/app", ["read"])] });
    await grants.attach(agentSubject(agentId), "agent4-app");
    const authorize = (body: Record<string, unknown>) =>
      request(server).post(`/vault/agents/${agentId}/authorize`).set(auth(a.token)).send(body);

    // No delegation + autonomy off → denied with the explicit reason.
    let r = await authorize({ path: "secret/data/app/x", capability: "read" }).expect(201);
    expect(r.body).toMatchObject({ decision: "deny", mode: "autonomous", reason: "autonomous-not-allowed" });

    // Admin enables autonomous; now bounded purely by the agent's own policy.
    await request(server).patch(`/vault/agents/${agentId}`).set(auth(a.token)).send({ autonomousAllowed: true }).expect(200);
    expect((await authorize({ path: "secret/data/app/x", capability: "read" })).body.decision).toBe("allow");
    expect((await authorize({ path: "secret/data/app/x", capability: "delete" })).body.decision).toBe("deny");

    // A spent call budget closes the delegated door.
    const exhausted = delegationClaims(a.userId, agentId, [
      { pathPrefix: "secret/data/app", capabilities: ["read"] },
    ], { maxCalls: 0 });
    // delegator needs the ceiling too
    await grants.upsertPolicy({ name: "delegator4-app", scopes: [scope("secret/data/app", ["read"])] });
    await grants.attach(userSubject(a.userId), "delegator4-app");
    const sigEx = signDelegation(E.session.signingPriv, exhausted);
    const delEx = await request(server)
      .post(`/vault/agents/${agentId}/delegations`)
      .set(auth(a.token))
      .send({ claims: exhausted, signature: sigEx })
      .expect(201);
    r = await authorize({ path: "secret/data/app/x", capability: "read", delegationId: delEx.body.id }).expect(201);
    expect(r.body.reason).toBe("delegation-call-budget-exhausted");

    // Revoke a live delegation → decision flips to revoked.
    const live = delegationClaims(a.userId, agentId, [
      { pathPrefix: "secret/data/app", capabilities: ["read"] },
    ]);
    const sigLive = signDelegation(E.session.signingPriv, live);
    const delLive = await request(server)
      .post(`/vault/agents/${agentId}/delegations`)
      .set(auth(a.token))
      .send({ claims: live, signature: sigLive })
      .expect(201);
    expect((await authorize({ path: "secret/data/app/x", capability: "read", delegationId: delLive.body.id })).body.decision).toBe("allow");
    await request(server).delete(`/vault/agents/${agentId}/delegations/${delLive.body.id}`).set(auth(a.token)).expect(200);
    r = await authorize({ path: "secret/data/app/x", capability: "read", delegationId: delLive.body.id }).expect(201);
    expect(r.body.reason).toBe("delegation-revoked");
  });

  it("audit rows carry agent attribution (actorKind/agentId/delegationId)", async () => {
    const E = enroll(PW, { profile });
    const a = await login("delegator5@example.com");
    await request(server).post("/vault/enroll").set(auth(a.token)).send(enrollDtoFrom(E)).expect(201);
    const keys = freshAgentKeys();
    const reg = await request(server)
      .post("/vault/agents")
      .set(auth(a.token))
      .send({
        displayName: "audit-bot",
        signingPublicKey: keys.signingPublicKey,
        identityPublicKey: keys.identityPublicKey,
        identityPublicKeyMlkem: keys.identityPublicKeyMlkem,
      })
      .expect(201);
    const agentId: string = reg.body.id;
    const claims = delegationClaims(a.userId, agentId, [
      { pathPrefix: "secret/data/app", capabilities: ["read"] },
    ]);
    const sig = signDelegation(E.session.signingPriv, claims);
    const del = await request(server)
      .post(`/vault/agents/${agentId}/delegations`)
      .set(auth(a.token))
      .send({ claims, signature: sig })
      .expect(201);

    // Reach into the data source to assert the attribution columns are populated.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DataSource } = require("typeorm");
    const ds = app.get(DataSource);
    const rows = await ds.query(
      `SELECT action, "actorKind", "agentId", "delegationId", "taskId" FROM vault_audit_log WHERE "agentId" = ? ORDER BY "createdAt" ASC`,
      [agentId],
    );
    const actions = rows.map((r: { action: string }) => r.action);
    expect(actions).toContain("agent_registered");
    expect(actions).toContain("agent_delegation_created");
    for (const row of rows) {
      expect(row.actorKind).toBe("agent");
      expect(row.agentId).toBe(agentId);
    }
    const delRow = rows.find((r: { action: string }) => r.action === "agent_delegation_created");
    expect(delRow.delegationId).toBe(del.body.id);
    expect(delRow.taskId).toBe(claims.taskId);
  });
});
