import { Global, Logger, Module } from "@nestjs/common";
import { BLOB_STORE, type BlobStore } from "./blob-store";
import { FilesystemBlobStore } from "./filesystem-blob-store";
import { InMemoryBlobStore } from "./in-memory-blob-store";
import { S3BlobStore, createAwsS3Client } from "./s3-blob-store";

/**
 * Provides the configured {@link BlobStore} under {@link BLOB_STORE}. Backend is env-driven:
 *
 *   ARC_BLOB_BACKEND = memory (default) | filesystem | s3
 *
 *   filesystem:  ARC_BLOB_DIR           (default /var/lib/arc/blobs)
 *   s3:          ARC_BLOB_S3_BUCKET      (required)
 *                ARC_BLOB_S3_PREFIX      (optional key prefix)
 *                ARC_BLOB_S3_REGION      (else AWS SDK default chain)
 *                ARC_BLOB_S3_ENDPOINT    (for MinIO / R2 / S3-compatible)
 *
 * The store only ever holds client-produced ciphertext, so the backend choice is operational,
 * not a security decision.
 */
@Global()
@Module({
  providers: [
    {
      provide: BLOB_STORE,
      useFactory: async (): Promise<BlobStore> => {
        const logger = new Logger("BlobStore");
        const backend = (process.env.ARC_BLOB_BACKEND ?? "memory").toLowerCase();
        switch (backend) {
          case "filesystem": {
            const dir = process.env.ARC_BLOB_DIR ?? "/var/lib/arc/blobs";
            logger.log(`backend=filesystem dir=${dir}`);
            return new FilesystemBlobStore(dir);
          }
          case "s3": {
            const bucket = process.env.ARC_BLOB_S3_BUCKET;
            if (!bucket) throw new Error("ARC_BLOB_BACKEND=s3 requires ARC_BLOB_S3_BUCKET");
            const client = await createAwsS3Client({
              region: process.env.ARC_BLOB_S3_REGION,
              endpoint: process.env.ARC_BLOB_S3_ENDPOINT,
            });
            logger.log(`backend=s3 bucket=${bucket}`);
            return new S3BlobStore({ bucket, prefix: process.env.ARC_BLOB_S3_PREFIX, client });
          }
          case "memory":
          default: {
            if (backend !== "memory") logger.warn(`unknown ARC_BLOB_BACKEND="${backend}", falling back to memory`);
            logger.log("backend=memory (blobs are lost on restart — use filesystem or s3 in production)");
            return new InMemoryBlobStore();
          }
        }
      },
    },
  ],
  exports: [BLOB_STORE],
})
export class BlobModule {}
