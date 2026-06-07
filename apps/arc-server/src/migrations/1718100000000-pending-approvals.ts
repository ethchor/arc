import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Engine-C Phase 4 (ADR-005). Adds `vault_pending_approvals` — push-consent (CIBA) records
 * for `elevated` agent actions: an elevated intent can't proceed until the owning human
 * proves control out-of-band (a WebAuthn assertion). Each row is pinned to one `intentDigest`.
 */
export class PendingApprovals1718100000000 implements MigrationInterface {
  name = "PendingApprovals1718100000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vault_pending_approvals" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "agentId" uuid NOT NULL,
        "taskId" uuid NOT NULL,
        "ownerUserId" integer NOT NULL,
        "intentDigest" text NOT NULL,
        "op" text NOT NULL,
        "path" text NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "challenge" text,
        "expiresAt" timestamp NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "resolvedAt" timestamp
      )
    `);
    await q.query(`CREATE INDEX "IDX_vault_pending_approvals_agentId" ON "vault_pending_approvals" ("agentId")`);
    await q.query(`CREATE INDEX "IDX_vault_pending_approvals_taskId" ON "vault_pending_approvals" ("taskId")`);
    await q.query(`CREATE INDEX "IDX_vault_pending_approvals_ownerUserId" ON "vault_pending_approvals" ("ownerUserId")`);
    await q.query(`CREATE INDEX "IDX_vault_pending_approvals_intentDigest" ON "vault_pending_approvals" ("intentDigest")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "vault_pending_approvals"`);
  }
}
