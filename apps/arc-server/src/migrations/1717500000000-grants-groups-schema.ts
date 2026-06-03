import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds group attachments to the grants ACL model. A subject (a vault userId today;
 * possibly a service-account id later) can belong to one or more groups, and groups
 * carry their own policy attachments. `PolicyEngine.getPoliciesForSubject` returns the
 * union of direct attachments + every policy reached via an attached group — same shape
 * Vault / OpenBao use.
 *
 * Two new tables:
 *   - `policy_group_memberships`: (subject, groupName) unique, indexed both ways
 *   - `policy_group_attachments`:  (groupName, policyName) unique, indexed by group
 *
 * No FK to `policies` on `policy_group_attachments` for the same reason
 * `policy_attachments` skips it — a removed policy with a lingering link is silently
 * filtered on read, matching the in-memory store's semantics.
 */
export class GrantsGroupsSchema1717500000000 implements MigrationInterface {
  name = "GrantsGroupsSchema1717500000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "policy_group_memberships" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "subject" text NOT NULL,
        "groupName" text NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "uq_membership" UNIQUE ("subject", "groupName")
      )
    `);
    await q.query(`CREATE INDEX "ix_membership_subject" ON "policy_group_memberships" ("subject")`);
    await q.query(`CREATE INDEX "ix_membership_group" ON "policy_group_memberships" ("groupName")`);

    await q.query(`
      CREATE TABLE "policy_group_attachments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "groupName" text NOT NULL,
        "policyName" text NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "uq_group_attachment" UNIQUE ("groupName", "policyName")
      )
    `);
    await q.query(`CREATE INDEX "ix_group_attachment_group" ON "policy_group_attachments" ("groupName")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "policy_group_attachments"`);
    await q.query(`DROP TABLE IF EXISTS "policy_group_memberships"`);
  }
}
