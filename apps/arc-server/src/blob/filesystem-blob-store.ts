import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BlobNotFoundError, type BlobStore } from "./blob-store";

/**
 * Filesystem blob store. Writes each blob to `<baseDir>/<sharded-path>` where the path is
 * derived from a SHA-256 of the (already-opaque) key — so the on-disk layout is
 * traversal-proof regardless of the key, and sharded two levels deep to avoid huge
 * directories. Suitable for a single-replica self-host with a persistent volume; for
 * multi-replica use S3.
 */
export class FilesystemBlobStore implements BlobStore {
  constructor(private readonly baseDir: string) {}

  private pathFor(key: string): string {
    // Hash the key → hex; shard ab/cd/<hash>. The key is server-generated and opaque, but
    // hashing makes the path independent of the key's characters (no `..`, `/`, etc.).
    const h = createHash("sha256").update(key).digest("hex");
    return join(this.baseDir, h.slice(0, 2), h.slice(2, 4), h);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    // Write to a temp sibling then rename for atomicity.
    const tmp = `${p}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    const { rename } = await import("node:fs/promises");
    await rename(tmp, p);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new BlobNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async has(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}
