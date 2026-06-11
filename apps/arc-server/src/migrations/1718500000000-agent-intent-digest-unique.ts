import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * HIGH-D (audit: human→agent→action trust chain) — replay-block at the storage layer.
 *
 * `submitIntent` verified the agent's signature + argsDigest + delegation window + budget,
 * but never enforced that a given signed intent could only be submitted once. The same
 * `SignedIntent` JSON could be POSTed N times, folding into the chain N times and
 * double-counting against the task budget. ADR-005 §3/§4 promise replay protection via
 * the signed nonce — pinning that promise in the DB:
 *
 *   - Add nullable `intentDigest text` to `vault_agent_intents` (the SHA-256 over JCS of
 *     the signed claims object — already-computed in the service for the elevated/CIBA
 *     path).
 *   - Partial UNIQUE INDEX on `(taskId, intentDigest) WHERE intentDigest IS NOT NULL`. The
 *     partial form keeps existing pre-migration rows (NULL digest) valid while making
 *     duplicates among newly-written rows a constraint violation. arc-server's
 *     `submitIntent` ALSO pre-checks inside its transaction so the public error is a
 *     clean 409 `intent_replay`; the constraint is the belt-and-suspenders against a
 *     race the in-process check can't catch.
 */
export class AgentIntentDigestUnique1718500000000 implements MigrationInterface {
  name = "AgentIntentDigestUnique1718500000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vault_agent_intents" ADD COLUMN "intentDigest" text`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_vault_agent_intents_task_digest" ` +
        `ON "vault_agent_intents" ("taskId", "intentDigest") ` +
        `WHERE "intentDigest" IS NOT NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "UQ_vault_agent_intents_task_digest"`);
    await q.query(`ALTER TABLE "vault_agent_intents" DROP COLUMN "intentDigest"`);
  }
}
