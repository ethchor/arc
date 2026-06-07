import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Engine-C — agentic identity (ADR-005). Adds:
 *  - `vault_agents`      — the agent principal (own signing + hybrid identity keys).
 *  - `vault_delegations` — signed, scoped, time-boxed on-behalf-of grants.
 *  - attribution columns on `vault_audit_log` (`actorKind`, `agentId`, `delegationId`,
 *    `taskId`) — all nullable, so existing rows and human/service callers are unaffected.
 */
export class AgentIdentity1717900000000 implements MigrationInterface {
  name = "AgentIdentity1717900000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vault_agents" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ownerUserId" integer NOT NULL,
        "displayName" text NOT NULL,
        "signingPublicKey" text NOT NULL,
        "identityPublicKey" text NOT NULL,
        "identityPublicKeyMlkem" text NOT NULL,
        "attestation" text,
        "autonomousAllowed" boolean NOT NULL DEFAULT false,
        "status" text NOT NULL DEFAULT 'active',
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "lastSeenAt" timestamp
      )
    `);
    await q.query(`CREATE INDEX "IDX_vault_agents_ownerUserId" ON "vault_agents" ("ownerUserId")`);

    await q.query(`
      CREATE TABLE "vault_delegations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "agentId" uuid NOT NULL,
        "delegatorUserId" integer NOT NULL,
        "taskId" uuid NOT NULL,
        "claims" text NOT NULL,
        "signature" text NOT NULL,
        "notBefore" timestamp NOT NULL,
        "notAfter" timestamp NOT NULL,
        "maxCalls" integer,
        "callsUsed" integer NOT NULL DEFAULT 0,
        "elevated" boolean NOT NULL DEFAULT false,
        "revokedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "IDX_vault_delegations_agentId" ON "vault_delegations" ("agentId")`);
    await q.query(
      `CREATE INDEX "IDX_vault_delegations_delegatorUserId" ON "vault_delegations" ("delegatorUserId")`,
    );
    await q.query(`CREATE INDEX "IDX_vault_delegations_taskId" ON "vault_delegations" ("taskId")`);
    await q.query(`CREATE INDEX "IDX_vault_delegations_notAfter" ON "vault_delegations" ("notAfter")`);

    await q.query(`ALTER TABLE "vault_audit_log" ADD COLUMN "actorKind" text`);
    await q.query(`ALTER TABLE "vault_audit_log" ADD COLUMN "agentId" uuid`);
    await q.query(`ALTER TABLE "vault_audit_log" ADD COLUMN "delegationId" uuid`);
    await q.query(`ALTER TABLE "vault_audit_log" ADD COLUMN "taskId" uuid`);
    await q.query(`CREATE INDEX "IDX_vault_audit_log_agentId" ON "vault_audit_log" ("agentId")`);
    await q.query(`CREATE INDEX "IDX_vault_audit_log_taskId" ON "vault_audit_log" ("taskId")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "IDX_vault_audit_log_taskId"`);
    await q.query(`DROP INDEX "IDX_vault_audit_log_agentId"`);
    await q.query(`ALTER TABLE "vault_audit_log" DROP COLUMN "taskId"`);
    await q.query(`ALTER TABLE "vault_audit_log" DROP COLUMN "delegationId"`);
    await q.query(`ALTER TABLE "vault_audit_log" DROP COLUMN "agentId"`);
    await q.query(`ALTER TABLE "vault_audit_log" DROP COLUMN "actorKind"`);
    await q.query(`DROP TABLE "vault_delegations"`);
    await q.query(`DROP TABLE "vault_agents"`);
  }
}
