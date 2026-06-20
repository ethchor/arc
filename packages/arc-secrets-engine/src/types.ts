import type { Lease } from "@arc/leasing";

/** Well-known engine types, kept open so adapters/plugins can introduce their own. */
export type EngineType = "kv-v2" | "database" | "pki" | "transit" | "ssh" | (string & {});

/** Format the backend should return PEM/DER artifacts in (Vault parity values). */
export type PkiFormat = "pem" | "der" | "pem_bundle";

export interface PkiIssueRequest {
  /** Subject CN. Most backends require this. */
  commonName: string;
  /** Cert TTL in seconds. Backend enforces max via role config. */
  ttlSeconds?: number;
  /** SAN: DNS names. */
  altNames?: string[];
  /** SAN: IPs. */
  ipSans?: string[];
  /** SAN: URIs. */
  uriSans?: string[];
  /** Exclude CN from SANs (Vault calls this `exclude_cn_from_sans`). */
  excludeCnFromSans?: boolean;
  format?: PkiFormat;
}

export interface PkiIssuedCertificate {
  certificate: string;
  issuingCa: string;
  caChain: string[];
  privateKey: string;
  privateKeyType: string;
  serialNumber: string;
  /** Unix epoch seconds — backend returns this as `expiration`. */
  expiration: number;
}

export interface PkiSignRequest {
  /** PEM-encoded CSR. */
  csr: string;
  /** Override the CN in the CSR. Optional. */
  commonName?: string;
  ttlSeconds?: number;
  altNames?: string[];
  ipSans?: string[];
  uriSans?: string[];
  excludeCnFromSans?: boolean;
  format?: PkiFormat;
}

export interface PkiSignedCertificate {
  certificate: string;
  issuingCa: string;
  caChain: string[];
  serialNumber: string;
  expiration: number;
}

export interface PkiCertificate {
  certificate: string;
  /** Unix epoch seconds. `undefined` (or 0) until the cert is revoked. */
  revocationTime?: number;
}

export interface PkiRevocation {
  /** Unix epoch seconds when the backend recorded the revocation. */
  revocationTime: number;
}

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

/**
 * Per-version timeline entry returned by {@link KvEngine.readMetadata}. Mirrors KV v2's
 * `versions` map (`/<mount>/metadata/<path>`): each version has a `createdTime`, may have a
 * `deletionTime` (soft-deleted), and may be `destroyed` (permanently gone — only metadata
 * survives). Both flags `false` ⇒ the version is live and readable via {@link KvEngine.get}.
 */
export interface KvVersionInfo {
  version: number;
  createdTime: string;
  /** ISO 8601 when this version was soft-deleted. Absent or empty string ⇒ not deleted. */
  deletionTime?: string;
  /** `true` when the version's data has been destroyed (only metadata survives). */
  destroyed?: boolean;
}

/**
 * Full path metadata: the timeline of every version plus path-level config (max retained
 * versions, CAS guard, free-form custom metadata). Returned by {@link KvEngine.readMetadata}
 * and used by clients to render a version history with per-version controls
 * (soft-delete / undelete / destroy) without re-reading each payload.
 */
export interface KvFullMetadata {
  /** Highest version number (live or not). 0 ⇒ no versions yet. */
  currentVersion: number;
  /** Server-side retention cap (0 ⇒ unlimited / backend default). */
  maxVersions: number;
  /** When set, writes must pass a `cas` matching the latest version. */
  casRequired: boolean;
  customMetadata: Record<string, string>;
  /** ISO 8601 — when the *path* was first written. */
  createdTime: string;
  /** ISO 8601 — when any version under the path was last touched. */
  updatedTime: string;
  /** Descending by version number. May include soft-deleted and destroyed entries. */
  versions: KvVersionInfo[];
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
