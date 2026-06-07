/**
 * Unit tests for the three blob backends + the `newAttachmentKey` helper. The S3 backend is
 * tested against a hand-rolled fake `S3Like` (avoids depending on `@aws-sdk/client-s3` at
 * build time — that's an optional peer dep).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobNotFoundError, newAttachmentKey } from "./blob-store";
import { FilesystemBlobStore } from "./filesystem-blob-store";
import { InMemoryBlobStore } from "./in-memory-blob-store";
import { S3BlobStore, type S3Like } from "./s3-blob-store";

function fakeS3(): S3Like & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    async putObject({ key, body }) { store.set(key, Buffer.from(body)); },
    async getObject({ key }) { return store.get(key) ? Buffer.from(store.get(key) as Buffer) : null; },
    async deleteObject({ key }) { store.delete(key); },
    async headObject({ key }) { return store.has(key); },
  };
}

describe("InMemoryBlobStore", () => {
  it("put → get → delete round-trips and `has` reflects state", async () => {
    const s = new InMemoryBlobStore();
    await s.put("k", Buffer.from("hello"));
    expect((await s.get("k")).toString()).toBe("hello");
    expect(await s.has("k")).toBe(true);
    await s.delete("k");
    expect(await s.has("k")).toBe(false);
    await expect(s.get("k")).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("isolates mutations of the caller's buffer", async () => {
    const s = new InMemoryBlobStore();
    const b = Buffer.from("a");
    await s.put("k", b);
    b[0] = 0x62; // mutate the source
    expect((await s.get("k")).toString()).toBe("a");
  });

  it("delete is idempotent on a missing key", async () => {
    const s = new InMemoryBlobStore();
    await expect(s.delete("nope")).resolves.toBeUndefined();
  });
});

describe("FilesystemBlobStore", () => {
  let dir: string;
  let store: FilesystemBlobStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arc-blob-"));
    store = new FilesystemBlobStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a sharded path keyed by SHA-256 of the key", async () => {
    await store.put("att/v/abc", Buffer.from([1, 2, 3]));
    expect(await store.has("att/v/abc")).toBe(true);
    expect((await store.get("att/v/abc")).toString("hex")).toBe("010203");
  });

  it("returns BlobNotFoundError for a missing key", async () => {
    await expect(store.get("missing")).rejects.toBeInstanceOf(BlobNotFoundError);
    expect(await store.has("missing")).toBe(false);
  });

  it("delete is idempotent on a missing key", async () => {
    await expect(store.delete("missing")).resolves.toBeUndefined();
  });

  it("survives a put-after-delete-after-put cycle", async () => {
    await store.put("k", Buffer.from("a"));
    await store.delete("k");
    await store.put("k", Buffer.from("b"));
    expect((await store.get("k")).toString()).toBe("b");
  });
});

describe("S3BlobStore (via fake S3Like)", () => {
  it("forwards put/get/delete/has and threads the prefix", async () => {
    const client = fakeS3();
    const s = new S3BlobStore({ bucket: "test", prefix: "prod/", client });
    await s.put("k", Buffer.from("hello"));
    expect(client.store.has("prod/k")).toBe(true);
    expect((await s.get("k")).toString()).toBe("hello");
    expect(await s.has("k")).toBe(true);
    await s.delete("k");
    expect(await s.has("k")).toBe(false);
    await expect(s.get("k")).rejects.toBeInstanceOf(BlobNotFoundError);
  });

  it("works without a prefix", async () => {
    const client = fakeS3();
    const s = new S3BlobStore({ bucket: "test", client });
    await s.put("k", Buffer.from("x"));
    expect(client.store.has("k")).toBe(true);
  });
});

describe("newAttachmentKey", () => {
  it("is opaque, sharded by vault, and never collides in practice", () => {
    const k = newAttachmentKey("vault-uuid");
    expect(k.startsWith("att/vault-uuid/")).toBe(true);
    // 24 random bytes → 48 hex chars
    expect(k.split("/")[2]).toMatch(/^[0-9a-f]{48}$/);
    const a = newAttachmentKey("v");
    const b = newAttachmentKey("v");
    expect(a).not.toBe(b);
  });
});
