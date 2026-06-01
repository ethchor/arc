import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the Engine-A grants tables: named policies + subject→policy attachments. Backs the
 * `@arc/grants` `MutablePolicyStore` so ACL policies survive a server restart (previously
 * the in-memory store lost them on every boot).
 *
 * Runs after the init schema. `policies.scopes` is `text` because the entity column is
 * TypeORM `simple-json` (JSON-stringified), the same mapping `argonParams` / `encName` use.
 * No FK from `policy_attachments` to `policies` on purpose — a removed policy with a
 * lingering attachment is tolerated (the lookup filters it out), matching the in-memory
 * store's semantics and keeping detach idempotent.
 */
export class GrantsSchema1717300000000 implements MigrationInterface {
  name = "GrantsSchema1717300000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "policies" (
        "name" text PRIMARY KEY,
        "scopes" text NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE "policy_attachments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "subject" text NOT NULL,
        "policyName" text NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "uq_policy_attachment" UNIQUE ("subject", "policyName")
      )
    `);
    await q.query(`CREATE INDEX "ix_policy_attachment_subject" ON "policy_attachments" ("subject")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "policy_attachments"`);
    await q.query(`DROP TABLE IF EXISTS "policies"`);
  }
}
