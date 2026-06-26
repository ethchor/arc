import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `vault_leases` — the persisted lease registry (#113). The arc `LeaseManager` was an
 * in-memory `Map`, so every active lease's arc-id → backend-id binding was lost on restart
 * and could never be shared across replicas. This table is the durable, multi-replica-safe
 * store; renew/revoke take a `SELECT … FOR UPDATE` row lock against it.
 *
 * Timestamps are epoch-ms `bigint` (matching `@arc/leasing`'s `Lease` numeric fields), not
 * `timestamptz`, so the wire shape and the lifecycle math stay integer-only on both sides.
 */
export class VaultLeasesSchema1718800000000 implements MigrationInterface {
  name = "VaultLeasesSchema1718800000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vault_leases" (
        "id" uuid PRIMARY KEY,
        "mount" text NOT NULL,
        "backendLeaseId" text,
        "ttlSeconds" int NOT NULL,
        "maxTtlSeconds" int NOT NULL,
        "renewable" boolean NOT NULL,
        "issuedAt" bigint NOT NULL,
        "expiresAt" bigint NOT NULL,
        "revokedAt" bigint,
        "taskId" text,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "ix_vault_leases_mount" ON "vault_leases" ("mount")`);
    await q.query(
      `CREATE INDEX "ix_vault_leases_mount_revoked" ON "vault_leases" ("mount", "revokedAt")`,
    );
    await q.query(`CREATE INDEX "ix_vault_leases_expires" ON "vault_leases" ("expiresAt")`);
    await q.query(`CREATE INDEX "ix_vault_leases_task" ON "vault_leases" ("taskId")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "vault_leases"`);
  }
}
