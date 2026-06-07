import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `vaults.icon` + `vaults.color` — optional UI affordances picked from the closed
 * sets exported by `@arc/types` (`VAULT_ICONS`, `VAULT_COLORS`). Plaintext is fine: this
 * is a vault-picker chip, not a secret; the vault's *name* stays encrypted via `encName`.
 * Nullable for back-compat with vaults created before this column landed.
 */
export class VaultUi1717800000000 implements MigrationInterface {
  name = "VaultUi1717800000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vaults" ADD COLUMN "icon" text`);
    await q.query(`ALTER TABLE "vaults" ADD COLUMN "color" text`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vaults" DROP COLUMN "color"`);
    await q.query(`ALTER TABLE "vaults" DROP COLUMN "icon"`);
  }
}
