import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `vault_devices.publicKeyMlkem` — the optional device ML-KEM-768 public key (b64url).
 * Nullable so existing X25519-only devices continue to work; new (ADR-003) clients populate
 * it on enrollment and approvers then wrap the VK with `pqSeal` instead of the classical
 * `seal` envelope. Closes the device-grant HNDL footnote in ADR-002.
 */
export class DeviceHybridKey1717700000000 implements MigrationInterface {
  name = "DeviceHybridKey1717700000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vault_devices" ADD COLUMN "publicKeyMlkem" text`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "vault_devices" DROP COLUMN "publicKeyMlkem"`);
  }
}
