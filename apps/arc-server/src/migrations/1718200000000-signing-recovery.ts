import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ADR-006 — master-password recovery. Adds `vault_user_keys.encSigningPrivRecovery`: the
 * Ed25519 signing private key wrapped under the recovery-derived KEK, so recovery can restore
 * the *full* identity (identity + signing) and re-enroll with no public-key change. Nullable
 * for back-compat with keysets enrolled before ADR-006.
 */
export class SigningRecovery1718200000000 implements MigrationInterface {
  name = "SigningRecovery1718200000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vault_user_keys" ADD COLUMN "encSigningPrivRecovery" text`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vault_user_keys" DROP COLUMN "encSigningPrivRecovery"`);
  }
}
