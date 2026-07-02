import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `vault_item_versions` — the per-item history archive. `upsertItem` overwrote the live
 * row in `vault_items` on every edit, so prior versions were lost. Now, on each update, the
 * prior snapshot (its exact ciphertext + wrapped item key + VK version) is archived here, so
 * the client can list and restore past versions. On key rotation the wrapped keys are
 * re-wrapped to the new VK, so history survives a rotation. Unique on (itemId, version).
 */
export class VaultItemVersionsSchema1718900000000 implements MigrationInterface {
  name = "VaultItemVersionsSchema1718900000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vault_item_versions" (
        "id" uuid PRIMARY KEY,
        "itemId" uuid NOT NULL,
        "vaultId" uuid NOT NULL,
        "version" int NOT NULL,
        "ciphertext" text NOT NULL,
        "wrappedItemKey" text NOT NULL,
        "vaultKeyVersion" int NOT NULL,
        "authorUserId" int NOT NULL,
        "savedAt" timestamp NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "ix_vault_item_versions_item" ON "vault_item_versions" ("itemId")`);
    await q.query(`CREATE INDEX "ix_vault_item_versions_vault" ON "vault_item_versions" ("vaultId")`);
    await q.query(
      `CREATE UNIQUE INDEX "ux_vault_item_versions_item_version" ON "vault_item_versions" ("itemId", "version")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "vault_item_versions"`);
  }
}
