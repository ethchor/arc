import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ADR-007 extension — edit-back shares. A grantee holding a `permission='edit'` share can
 * propose a new version of the item; the proposal parks on the share row (ciphertext under
 * a grantee-generated IK + that IK pqSeal'd to the *granter's* hybrid identity) until the
 * granter reviews, re-encrypts under the VK, and writes the item through the normal path.
 * One pending proposal per share row — a newer write-back overwrites the previous one.
 *
 * `expiresAt` was already reserved by the v1 migration; no schema change needed for TTL.
 */
export class ItemShareWriteBack1718400000000 implements MigrationInterface {
  name = "ItemShareWriteBack1718400000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vault_item_shares" ADD COLUMN "pendingCiphertext" text`);
    await q.query(`ALTER TABLE "vault_item_shares" ADD COLUMN "pendingWrappedIK" text`);
    await q.query(`ALTER TABLE "vault_item_shares" ADD COLUMN "pendingBaseVersion" integer`);
    await q.query(`ALTER TABLE "vault_item_shares" ADD COLUMN "pendingKeyVersion" integer`);
    await q.query(`ALTER TABLE "vault_item_shares" ADD COLUMN "pendingAt" timestamp`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vault_item_shares" DROP COLUMN "pendingAt"`);
    await q.query(`ALTER TABLE "vault_item_shares" DROP COLUMN "pendingKeyVersion"`);
    await q.query(`ALTER TABLE "vault_item_shares" DROP COLUMN "pendingBaseVersion"`);
    await q.query(`ALTER TABLE "vault_item_shares" DROP COLUMN "pendingWrappedIK"`);
    await q.query(`ALTER TABLE "vault_item_shares" DROP COLUMN "pendingCiphertext"`);
  }
}
