import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * HIGH-C (audit: human→agent→action trust chain) — make agent JWTs revocable.
 *
 * Until this commit an agent JWT issued via `POST /vault/agents/:id/auth/token` lived
 * for its full TTL (10 min today) regardless of what happened to the agent's tasks or
 * status. Closing a task DID refuse new intents for THAT task (`task_not_open`), but it
 * did not stop the same JWT from being re-used to authenticate against `submitIntent`
 * for any OTHER task the agent had open — including a new task the owner opened
 * post-closure. ADR-005 §3.5 calls "close task" the revocation primitive; the JWT
 * surface needs to honour it.
 *
 * Fix: bind every issued JWT to a per-agent `tokenEpoch` counter. The
 * AgentAuthService embeds the counter in the JWT at issuance; JwtAuthGuard refuses
 * the request with `agent_token_revoked` whenever the JWT's epoch does not equal the
 * agent's current epoch. AgentTasksService.closeTask() bumps the counter atomically
 * with the task-status update, so the next API call from any outstanding JWT for
 * that agent fails closed. Default `0` lets pre-migration JWTs keep working until
 * their natural TTL — back-compat tradeoff for the 10-minute window.
 */
export class AgentTokenEpoch1718600000000 implements MigrationInterface {
  name = "AgentTokenEpoch1718600000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "vault_agents" ADD COLUMN "tokenEpoch" integer NOT NULL DEFAULT 0`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vault_agents" DROP COLUMN "tokenEpoch"`);
  }
}
