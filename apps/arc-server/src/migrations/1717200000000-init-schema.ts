import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Initial schema migration. Captures the entire arc-server data model as of develop
 * @ 0009d02 — users, vault keysets (with hybrid X25519 + ML-KEM-768 identity columns per
 * ADR-002), vaults, memberships, grants, items, devices, signed heads, audit log,
 * folders.
 *
 * Production should run this migration via `migrationsRun: true` (configured in
 * `app.module.ts`) instead of TypeORM's `synchronize`, so column changes never silently
 * drop ciphertext.
 *
 * In dev/test we still use sql.js with `synchronize: true` for the fast feedback loop —
 * the test profile in `app.module.ts` short-circuits past the migrations path. This
 * matches the same split Vault / OpenBao deployments use (dev mode = ephemeral, prod
 * mode = migrations-only).
 */
export class InitSchema1717200000000 implements MigrationInterface {
  name = "InitSchema1717200000000";

  async up(q: QueryRunner): Promise<void> {
    // pgcrypto / uuid-ossp aren't required: every UUID column is generated client-side
    // (TypeORM's @PrimaryGeneratedColumn("uuid") uses `gen_random_uuid()` if available
    // but the entities also accept caller-supplied uuids). We don't enable an extension
    // here so the migration runs against a stock postgres.

    await q.query(`
      CREATE TABLE "users" (
        "id" SERIAL PRIMARY KEY,
        "email" text NOT NULL UNIQUE,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE "vault_user_keys" (
        "id" SERIAL PRIMARY KEY,
        "userId" integer NOT NULL UNIQUE,
        "saltMk" text NOT NULL,
        "saltAuth" text NOT NULL,
        "argonParams" text NOT NULL,
        "authHashStored" text NOT NULL,
        "serverSalt" text NOT NULL,
        "identityPublicKey" text NOT NULL,
        "identityPublicKeyMlkem" text NOT NULL,
        "signingPublicKey" text NOT NULL,
        "identitySelfAttestation" text NOT NULL,
        "encIdentityPriv" text NOT NULL,
        "encIdentityPrivMlkem" text NOT NULL,
        "encSigningPriv" text NOT NULL,
        "encIdentityPrivRecovery" text NOT NULL,
        "encIdentityPrivMlkemRecovery" text NOT NULL,
        "keyVersion" integer NOT NULL DEFAULT 1,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE "vaults" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type" text NOT NULL,
        "orgId" uuid,
        "ownerUserId" integer NOT NULL,
        "encName" text,
        "currentKeyVersion" integer NOT NULL DEFAULT 1,
        "seqCounter" integer NOT NULL DEFAULT 0,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        "deletedAt" timestamp
      )
    `);

    await q.query(`
      CREATE TABLE "vault_memberships" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vaultId" uuid NOT NULL,
        "userId" integer NOT NULL,
        "role" text NOT NULL,
        "status" text NOT NULL DEFAULT 'active',
        "addedByUserId" integer,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "uq_membership_vault_user" UNIQUE ("vaultId", "userId")
      )
    `);
    await q.query(`CREATE INDEX "ix_membership_vault" ON "vault_memberships" ("vaultId")`);
    await q.query(`CREATE INDEX "ix_membership_user" ON "vault_memberships" ("userId")`);
    await q.query(
      `CREATE INDEX "ix_membership_vault_role" ON "vault_memberships" ("vaultId", "role")`,
    );

    await q.query(`
      CREATE TABLE "vault_key_grants" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vaultId" uuid NOT NULL,
        "keyVersion" integer NOT NULL,
        "granteeUserId" integer,
        "granteeDeviceId" uuid,
        "wrappedVaultKey" text NOT NULL,
        "wrappedByUserId" integer,
        "signature" text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "uq_grant_vault_kv_user" UNIQUE ("vaultId", "keyVersion", "granteeUserId")
      )
    `);
    await q.query(`CREATE INDEX "ix_grant_vault" ON "vault_key_grants" ("vaultId")`);

    await q.query(`
      CREATE TABLE "vault_items" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vaultId" uuid NOT NULL,
        "folderId" uuid,
        "type" text,
        "ciphertext" text NOT NULL,
        "wrappedItemKey" text NOT NULL,
        "vaultKeyVersion" integer NOT NULL,
        "version" integer NOT NULL DEFAULT 1,
        "seq" integer NOT NULL,
        "authorUserId" integer NOT NULL,
        "authorDeviceId" uuid,
        "signature" text,
        "deletedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "ix_item_vault" ON "vault_items" ("vaultId")`);
    await q.query(`CREATE INDEX "ix_item_vault_seq" ON "vault_items" ("vaultId", "seq")`);
    await q.query(
      `CREATE INDEX "ix_item_vault_updated" ON "vault_items" ("vaultId", "updatedAt")`,
    );

    await q.query(`
      CREATE TABLE "vault_devices" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" integer NOT NULL,
        "name" text NOT NULL,
        "publicKey" text NOT NULL,
        "trusted" boolean NOT NULL DEFAULT false,
        "approved" boolean NOT NULL DEFAULT false,
        "lastSeenAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "ix_device_user" ON "vault_devices" ("userId")`);
    await q.query(
      `CREATE INDEX "ix_device_user_approved" ON "vault_devices" ("userId", "approved")`,
    );

    await q.query(`
      CREATE TABLE "vault_heads" (
        "vaultId" uuid PRIMARY KEY,
        "seq" integer NOT NULL,
        "chainHash" text NOT NULL,
        "ts" text NOT NULL,
        "signature" text NOT NULL,
        "signerUserId" integer NOT NULL,
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE "vault_audit_log" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vaultId" uuid,
        "actorUserId" integer,
        "action" text NOT NULL,
        "targetId" text,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "ix_audit_vault" ON "vault_audit_log" ("vaultId")`);

    await q.query(`
      CREATE TABLE "vault_folders" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vaultId" uuid NOT NULL,
        "encName" text NOT NULL,
        "parentId" uuid,
        "seq" integer NOT NULL DEFAULT 0,
        "deletedAt" timestamp,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "ix_folder_vault" ON "vault_folders" ("vaultId")`);
  }

  async down(q: QueryRunner): Promise<void> {
    // Drop in reverse-dependency order. None of the tables have FKs today (we enforce
    // referential integrity in the service layer because the membership/grant graph is
    // append-only), but reverse order keeps the migration symmetric.
    await q.query(`DROP TABLE IF EXISTS "vault_folders"`);
    await q.query(`DROP TABLE IF EXISTS "vault_audit_log"`);
    await q.query(`DROP TABLE IF EXISTS "vault_heads"`);
    await q.query(`DROP TABLE IF EXISTS "vault_devices"`);
    await q.query(`DROP TABLE IF EXISTS "vault_items"`);
    await q.query(`DROP TABLE IF EXISTS "vault_key_grants"`);
    await q.query(`DROP TABLE IF EXISTS "vault_memberships"`);
    await q.query(`DROP TABLE IF EXISTS "vaults"`);
    await q.query(`DROP TABLE IF EXISTS "vault_user_keys"`);
    await q.query(`DROP TABLE IF EXISTS "users"`);
  }
}
