import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `vault_workflows` — per-vault declarative JIT-access workflow definitions
 * (Phase 1). The row body is a canonical JSON `WorkflowDefinition` (vocabulary-checked
 * by `@arc/workflows`), so the only schema this migration carries is the envelope:
 * vault scoping, name, enabled flag, optimistic-concurrency `version`, audit columns.
 */
export class WorkflowsSchema1718700000000 implements MigrationInterface {
  name = "WorkflowsSchema1718700000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vault_workflows" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vaultId" uuid NOT NULL,
        "name" text NOT NULL,
        "definition" jsonb NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "version" int NOT NULL DEFAULT 1,
        "createdByUserId" int NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "ix_vault_workflows_vault" ON "vault_workflows" ("vaultId")`);
    await q.query(
      `CREATE INDEX "ix_vault_workflows_vault_enabled" ON "vault_workflows" ("vaultId", "enabled")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "vault_workflows"`);
  }
}
