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

export interface IssueOptions {
  ttlSeconds?: number;
  params?: Record<string, unknown>;
}

/** A dynamically generated credential plus the lease that governs its lifetime. */
export interface IssuedCredential {
  data: Record<string, unknown>;
  lease: Lease;
}
