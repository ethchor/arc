import { BlobNotFoundError, type BlobStore } from "./blob-store";

/**
 * Minimal S3 surface the store needs. Kept tiny + injectable so this file has no compile-time
 * dependency on `@aws-sdk/client-s3` — tests inject a fake, and {@link createAwsS3Client}
 * lazily builds a real one only when the S3 backend is actually selected (so arc-server boots
 * fine without the AWS SDK installed unless you opt in).
 */
export interface S3Like {
  putObject(input: { bucket: string; key: string; body: Buffer }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<Buffer | null>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  headObject(input: { bucket: string; key: string }): Promise<boolean>;
}

export interface S3BlobStoreOptions {
  bucket: string;
  /** Optional key prefix prepended to every blob key (e.g. "prod/"). */
  prefix?: string;
  client: S3Like;
}

/**
 * S3 (or any S3-compatible: MinIO, Cloudflare R2, …) blob store. The blob is opaque
 * ciphertext, so server-side encryption is optional belt-and-suspenders, not the security
 * boundary.
 */
export class S3BlobStore implements BlobStore {
  private readonly prefix: string;

  constructor(private readonly opts: S3BlobStoreOptions) {
    this.prefix = opts.prefix ? opts.prefix.replace(/\/*$/, "/") : "";
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.opts.client.putObject({ bucket: this.opts.bucket, key: this.k(key), body: data });
  }

  async get(key: string): Promise<Buffer> {
    const body = await this.opts.client.getObject({ bucket: this.opts.bucket, key: this.k(key) });
    if (body === null) throw new BlobNotFoundError(key);
    return body;
  }

  async delete(key: string): Promise<void> {
    await this.opts.client.deleteObject({ bucket: this.opts.bucket, key: this.k(key) });
  }

  async has(key: string): Promise<boolean> {
    return this.opts.client.headObject({ bucket: this.opts.bucket, key: this.k(key) });
  }
}

/**
 * Build an {@link S3Like} backed by `@aws-sdk/client-s3` (declared as an optional dependency).
 * Imported lazily so the package is only required when the S3 backend is selected. Credentials
 * + region resolve via the AWS SDK default provider chain (env, shared config, IRSA, IMDS).
 */
export async function createAwsS3Client(options: { region?: string; endpoint?: string } = {}): Promise<S3Like> {
  // `@aws-sdk/client-s3` is an optional dependency that may not be installed. Import it with
  // a runtime-only specifier so this file typechecks without the package present, and the
  // import only happens when the S3 backend is actually selected.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    const specifier = "@aws-sdk/client-s3";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod = await (Function("s", "return import(s)") as (s: string) => Promise<any>)(specifier);
  } catch {
    throw new Error(
      "ARC_BLOB_BACKEND=s3 requires the optional peer dependency '@aws-sdk/client-s3' — install it in your image.",
    );
  }
  const client = new mod.S3Client({
    ...(options.region ? { region: options.region } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint, forcePathStyle: true } : {}),
  });

  return {
    async putObject({ bucket, key, body }) {
      await client.send(new mod.PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    },
    async getObject({ bucket, key }) {
      try {
        const res = await client.send(new mod.GetObjectCommand({ Bucket: bucket, Key: key }));
        const bytes = await res.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async deleteObject({ bucket, key }) {
      await client.send(new mod.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async headObject({ bucket, key }) {
      try {
        await client.send(new mod.HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === "NotFound") return false;
        throw err;
      }
    },
  };
}
