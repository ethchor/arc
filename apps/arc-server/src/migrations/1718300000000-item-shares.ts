import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ADR-007 — item-level shares. One row per (item, grantee): the recipient can decrypt one
 * version of one item via `wrappedIK` (pqSeal of the IK to their hybrid identity) + a
 * ciphertext snapshot, without becoming a vault member. Unique on (itemId, granteeUserId)
 * so re-sharing the same item to the same user upserts.
 */
export class ItemShares1718300000000 implements MigrationInterface {
  name = "ItemShares1718300000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vault_item_shares" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vaultId" uuid NOT NULL,
        "itemId" uuid NOT NULL,
        "granterUserId" integer NOT NULL,
        "granteeUserId" integer NOT NULL,
        "permission" text NOT NULL DEFAULT 'view',
        "wrappedIK" text NOT NULL,
        "ciphertext" text NOT NULL,
        "vaultKeyVersion" integer NOT NULL,
        "itemVersion" integer NOT NULL,
        "itemType" text,
        "expiresAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "IDX_vault_item_shares_vaultId" ON "vault_item_shares" ("vaultId")`);
    await q.query(`CREATE INDEX "IDX_vault_item_shares_itemId" ON "vault_item_shares" ("itemId")`);
    await q.query(`CREATE INDEX "IDX_vault_item_shares_granteeUserId" ON "vault_item_shares" ("granteeUserId")`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_vault_item_shares_itemId_granteeUserId" ON "vault_item_shares" ("itemId", "granteeUserId")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "vault_item_shares"`);
  }
}
