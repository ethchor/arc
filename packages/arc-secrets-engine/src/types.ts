import type { Lease } from "@arc-vault/leasing";

/** Well-known engine types, kept open so adapters/plugins can introduce their own. */
export type EngineType = "kv-v2" | "database" | "pki" | "transit" | "ssh" | (string & {});

export interface MountConfig {
  /** Mount path; normalized to a single trailing slash on registration. */
  path: string;
  type: EngineType;
  description?: string;
  /** Default lease TTL (seconds) for dynamic secrets minted from this mount. */
  defaultTtlSeconds?: number;
  /** Hard max lease TTL (seconds) for this mount. */
  maxTtlSeconds?: number;
}

export interface KvVersionMetadata {
  version: number;
  createdTime: string;
  deleted: boolean;
  destroyed: boolean;
}

export interface KvReadResult {
  data: Record<string, unknown>;
  metadata: KvVersionMetadata;
}

export interface KvWriteResult {
  version: number;
  createdTime: string;
}

export interface IssueOptions {
  ttlSeconds?: number;
  params?: Record<string, unknown>;
}

/** A dynamically generated credential plus the lease that governs its lifetime. */
export interface IssuedCredential {
  data: Record<string, unknown>;
  lease: Lease;
}
