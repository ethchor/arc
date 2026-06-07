import { randomBytes } from "node:crypto";

/**
 * Opaque blob storage for large item-ciphertext payloads (attachments). arc-server is
 * zero-knowledge — a blob is always *ciphertext the client produced*, so where it physically
 * lives (memory / disk / S3) is purely operational, never a security boundary. The DB row
 * keeps the metadata + the wrapped key; only the encrypted bytes go here.
 *
 * Keys are server-generated, opaque, and collision-resistant; callers never choose them.
 */
export interface BlobStore {
  /** Store `data` under `key`. Overwrites if the key already exists. */
  put(key: string, data: Buffer): Promise<void>;
  /** Read the bytes for `key`. Throws {@link BlobNotFoundError} if absent. */
  get(key: string): Promise<Buffer>;
  /** Delete `key`. Idempotent — deleting a missing key is a no-op. */
  delete(key: string): Promise<void>;
  /** True if `key` exists. */
  has(key: string): Promise<boolean>;
}

export class BlobNotFoundError extends Error {
  constructor(key: string) {
    super(`blob not found: ${key}`);
    this.name = "BlobNotFoundError";
  }
}

/** DI token for the configured {@link BlobStore}. */
export const BLOB_STORE = Symbol("BLOB_STORE");

/**
 * Generate a fresh, opaque blob key for a vault attachment. Shape:
 * `att/<vaultId>/<random>` — sharded by vault so a filesystem backend doesn't pile every
 * blob into one directory, and prefixed so an S3 bucket can lifecycle/scope by prefix.
 */
export function newAttachmentKey(vaultId: string): string {
  return `att/${vaultId}/${randomBytes(24).toString("hex")}`;
}
