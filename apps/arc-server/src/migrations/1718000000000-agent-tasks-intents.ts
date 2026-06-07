import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Engine-C Phase 3 (ADR-005). Adds:
 *  - `vault_agent_tasks`   — the revocable task unit (budget + per-task intent-chain head).
 *  - `vault_agent_intents` — the recorded signed-intent chain (tamper-evidence + ordering).
 *  - `vault_audit_log.toolCall` — optional per-action tool-call detail (nullable).
 */
export class AgentTasksIntents1718000000000 implements MigrationInterface {
  name = "AgentTasksIntents1718000000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vault_agent_tasks" (
        "taskId" uuid PRIMARY KEY,
        "agentId" uuid NOT NULL,
        "ownerUserId" integer NOT NULL,
        "delegationId" uuid,
        "budget" text NOT NULL,
        "callsUsed" integer NOT NULL DEFAULT 0,
        "secretsUnsealed" integer NOT NULL DEFAULT 0,
        "chainHead" text NOT NULL,
        "status" text NOT NULL DEFAULT 'open',
        "deadlineAt" timestamp NOT NULL,
        "openedAt" timestamp NOT NULL DEFAULT now(),
        "closedAt" timestamp
      )
    `);
    await q.query(`CREATE INDEX "IDX_vault_agent_tasks_agentId" ON "vault_agent_tasks" ("agentId")`);

    await q.query(`
      CREATE TABLE "vault_agent_intents" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "taskId" uuid NOT NULL,
        "agentId" uuid NOT NULL,
        "seq" integer NOT NULL,
        "claims" text NOT NULL,
        "signature" text NOT NULL,
        "chainHead" text NOT NULL,
        "decision" text NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "IDX_vault_agent_intents_taskId" ON "vault_agent_intents" ("taskId")`);

    await q.query(`ALTER TABLE "vault_audit_log" ADD COLUMN "toolCall" text`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vault_audit_log" DROP COLUMN "toolCall"`);
    await q.query(`DROP TABLE "vault_agent_intents"`);
    await q.query(`DROP TABLE "vault_agent_tasks"`);
  }
}
