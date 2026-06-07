import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `vault_attachments` — encrypted-attachment metadata. The ciphertext bytes live in the
 * configured BlobStore (memory / filesystem / S3) keyed by `blobKey`; this table keeps only
 * the wrapped attachment key, the encrypted filename/MIME envelope, and the size. The server
 * stays zero-knowledge about attachment content (it only ever holds ciphertext).
 */
export class AttachmentsSchema1717600000000 implements MigrationInterface {
  name = "AttachmentsSchema1717600000000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "vault_attachments" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "vaultId" uuid NOT NULL,
        "itemId" uuid NOT NULL,
        "blobKey" text NOT NULL,
        "sizeBytes" integer NOT NULL,
        "wrappedKey" text NOT NULL,
        "encMetadata" text NOT NULL,
        "vaultKeyVersion" integer NOT NULL,
        "authorUserId" integer NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX "IDX_vault_attachments_vaultId" ON "vault_attachments" ("vaultId")`);
    await q.query(`CREATE INDEX "IDX_vault_attachments_itemId" ON "vault_attachments" ("itemId")`);
    await q.query(
      `CREATE INDEX "IDX_vault_attachments_vault_item" ON "vault_attachments" ("vaultId", "itemId")`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "vault_attachments"`);
  }
}
