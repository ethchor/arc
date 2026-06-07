import { BlobNotFoundError, type BlobStore } from "./blob-store";

/**
 * In-process Map-backed blob store. The default backend — fine for dev, tests, and small
 * single-replica self-hosts where attachments live in process memory (they're lost on
 * restart, so document that). Production uses filesystem or S3.
 */
export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<void> {
    // Copy so a later mutation of the caller's buffer can't change stored bytes.
    this.blobs.set(key, Buffer.from(data));
  }

  async get(key: string): Promise<Buffer> {
    const v = this.blobs.get(key);
    if (!v) throw new BlobNotFoundError(key);
    return Buffer.from(v);
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.blobs.has(key);
  }

  /** Test helper: number of stored blobs. */
  get size(): number {
    return this.blobs.size;
  }
}
