import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Binds accounts to a verified OIDC identity, replacing the email-only `dev-login` stub
 * (BL-C4 / issue #144).
 *
 * `(oidcIssuer, oidcSubject)` is the account's real identity; the email is descriptive only.
 * That split is what makes the takeover cases in doc 06 §6.7 safe — an address changing at
 * the IdP moves no keys, and two issuers asserting the same address cannot collide.
 *
 * All three columns are additive and nullable/defaulted, so existing rows (and the gated
 * dev-login used by the test harness) keep working: they simply have no bound OIDC identity
 * and an unverified address.
 */
export class UserOidcIdentity1719000000000 implements MigrationInterface {
  name = "UserOidcIdentity1719000000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" ADD COLUMN "oidcIssuer" text`);
    await q.query(`ALTER TABLE "users" ADD COLUMN "oidcSubject" text`);
    await q.query(`ALTER TABLE "users" ADD COLUMN "emailVerified" boolean NOT NULL DEFAULT false`);
    // Partial-unique semantics: two accounts may both have NULL identity (legacy/dev rows),
    // but a given (issuer, subject) pair may map to exactly one account. Postgres treats
    // NULLs as distinct in a UNIQUE index, which gives us that for free.
    await q.query(
      `CREATE UNIQUE INDEX "ux_users_oidc_identity" ON "users" ("oidcIssuer", "oidcSubject")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "ux_users_oidc_identity"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN "emailVerified"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN "oidcSubject"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN "oidcIssuer"`);
  }
}
