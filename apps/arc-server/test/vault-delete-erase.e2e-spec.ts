/**
 * SEC-M3 (#152): deleting an item must actually ERASE its secret material, not just flag it.
 * Before the fix, `deleteItem` set `deletedAt` but left the live ciphertext, every archived
 * version, and any attachment blob intact — so a current member could still recover a "deleted"
 * item's contents (via the versions endpoint or the attachment) despite the delete.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type AddressInfo } from "node:net";
import { DataSource, type Repository } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { VaultClient } from "@arc/sdk";
import { AppModule } from "../src/app.module";
import { VaultAttachmentEntity } from "../src/database/entities";
import { BLOB_STORE, type BlobStore, newAttachmentKey } from "../src/blob/blob-store";

describe("SEC-M3: deleteItem erases ciphertext + history + attachments (#152)", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("erases the live ciphertext, purges every version + attachment, refuses history, still syncs the tombstone", async () => {
    const C = new VaultClient({ baseUrl, profile: "test" });
    await C.devLogin("delete-erase@example.com");
    await C.enroll("master-password-D");
    const v = await C.createVault("team", "Erase");

    const c = await C.putItem(v.id, { type: "secret", key: "K", value: "v1" }, { type: "secret" });
    const u2 = await C.putItem(
      v.id,
      { type: "secret", key: "K", value: "v2" },
      { id: c.id, baseVersion: c.version, type: "secret" },
    );
    await C.putItem(
      v.id,
      { type: "secret", key: "K", value: "v3" },
      { id: c.id, baseVersion: u2.version, type: "secret" },
    );
    // Precondition: two archived versions exist before the delete.
    expect((await C.listItemVersions(v.id, c.id)).map((x) => x.version)).toEqual([2, 1]);

    // Seed an attachment (blob + row) for the item — the SDK attachment path isn't wired yet,
    // so reach into the repos the same way the device e2e seeds server state.
    const blobs = app.get<BlobStore>(BLOB_STORE);
    const attachments = app.get(getRepositoryToken(VaultAttachmentEntity)) as Repository<VaultAttachmentEntity>;
    const blobKey = newAttachmentKey(v.id);
    await blobs.put(blobKey, Buffer.from([1, 2, 3, 4]));
    await attachments.save(
      attachments.create({
        vaultId: v.id,
        itemId: c.id,
        blobKey,
        sizeBytes: 4,
        wrappedKey: {},
        encMetadata: {},
        vaultKeyVersion: 1,
        authorUserId: 1,
      }),
    );

    await C.deleteItem(v.id, c.id);
    const ds = app.get(DataSource);

    // (1) history purged — zero version rows survive.
    const vrows = (await ds.query(`SELECT COUNT(*) AS n FROM vault_item_versions WHERE "itemId" = ?`, [
      c.id,
    ])) as Array<{ n: number }>;
    expect(Number(vrows[0]!.n)).toBe(0);

    // (2) live ciphertext + wrapped key erased to an empty envelope; the deletedAt/seq tombstone stays.
    const irows = (await ds.query(
      `SELECT "ciphertext", "wrappedItemKey", "deletedAt" FROM vault_items WHERE id = ?`,
      [c.id],
    )) as Array<{ ciphertext: string; wrappedItemKey: string; deletedAt: unknown }>;
    expect(irows).toHaveLength(1);
    expect(JSON.parse(irows[0]!.ciphertext)).toEqual({});
    expect(JSON.parse(irows[0]!.wrappedItemKey)).toEqual({});
    expect(irows[0]!.deletedAt).not.toBeNull();

    // (3) attachment row + blob are gone.
    expect(await attachments.count({ where: { itemId: c.id } })).toBe(0);
    let blobGone = false;
    try {
      await blobs.get(blobKey);
    } catch {
      blobGone = true;
    }
    expect(blobGone).toBe(true);

    // (4) the history endpoint refuses a deleted item (indistinguishable from missing).
    await expect(C.listItemVersions(v.id, c.id)).rejects.toThrow();

    // (5) sync is not broken — pull still surfaces the delete as a tombstone with no data.
    const pulled = await C.pull(v.id, 0);
    const row = pulled.items.find((i) => i.id === c.id)!;
    expect(row.deleted).toBe(true);
    expect(row.data).toBeNull();
  });
});
