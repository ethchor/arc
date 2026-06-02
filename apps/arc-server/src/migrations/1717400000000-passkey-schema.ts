import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `vault_user_passkeys` — one row per registered passkey credential. Stores the
 * credential public key + sign counter (anti-clone) and the identity-private envelopes
 * wrapped under the PRF-derived KEK (`wrapIdentityForPasskey` in arc-crypto).
 *
 * The server never sees the PRF output, the identity key, or the master key. Same
 * zero-knowledge posture as master-password unlock — passkey is an additive unlock path,
 * not a replacement.
 */
export class PasskeySchema1717400000000 implements MigrationInterface {
  name = "PasskeySchema1717400000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vault_user_passkeys" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" integer NOT NULL,
        "credentialId" text NOT NULL,
        "publicKey" text NOT NULL,
        "counter" bigint NOT NULL,
        "label" text,
        "encIdentityPrivPasskey" text NOT NULL,
        "encIdentityPrivMlkemPasskey" text NOT NULL,
        "encSigningPrivPasskey" text NOT NULL,
        "transports" text,
        "prfSalt" text NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "uq_user_credential" UNIQUE ("userId", "credentialId")
      )
    `);
    await q.query(`CREATE INDEX "ix_passkey_user" ON "vault_user_passkeys" ("userId")`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "vault_user_passkeys"`);
  }
}
