import type { Lease } from "@arc/leasing";
import type {
  EngineType,
  IssueOptions,
  IssuedCredential,
  KvFullMetadata,
  KvReadResult,
  KvWriteResult,
  PkiCertificate,
  PkiIssueRequest,
  PkiIssuedCertificate,
  PkiRevocation,
  PkiSignedCertificate,
  PkiSignRequest,
} from "./types";

/**
 * Base contract every secrets engine satisfies. arc routes requests to a concrete engine by
 * matching the request path against registered mounts (see {@link MountRegistry}).
 */
export interface SecretsEngine {
  readonly type: EngineType;
  /** Normalized mount path (trailing slash). */
  readonly mount: string;
}

/** Versioned key/value engine (KV v2 semantics: versions, soft-delete, check-and-set). */
export interface KvEngine extends SecretsEngine {
  readonly type: "kv-v2";
  get(path: string, version?: number): Promise<KvReadResult>;
  put(
    path: string,
    data: Record<string, unknown>,
    opts?: { cas?: number },
  ): Promise<KvWriteResult>;
  /** Soft-delete the *latest* version. Equivalent to `deleteVersions(path, [currentVersion])`. */
  deleteLatest(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Full version timeline + path metadata. Drives a "versions" history UI without N data reads. */
  readMetadata(path: string): Promise<KvFullMetadata>;
  /** Soft-delete one or more specific versions. Data can be restored via {@link undeleteVersions}. */
  deleteVersions(path: string, versions: readonly number[]): Promise<void>;
  /** Restore soft-deleted versions (no-op for versions that aren't currently soft-deleted). */
  undeleteVersions(path: string, versions: readonly number[]): Promise<void>;
  /** **Permanently** destroy versions' data. Metadata survives; the data is unrecoverable. */
  destroyVersions(path: string, versions: readonly number[]): Promise<void>;
}

/** Engine that mints short-lived credentials governed by a lease (databases, cloud, SCM, …). */
export interface DynamicSecretsEngine extends SecretsEngine {
  issue(role: string, opts?: IssueOptions): Promise<IssuedCredential>;
  renew(leaseId: string, incrementSeconds?: number): Promise<Lease>;
  revoke(leaseId: string): Promise<void>;
}

/**
 * Symmetric "encryption as a service" — the Vault/OpenBao `transit` engine. The engine
 * holds the key material; the caller never sees it. Use cases: server-side encryption of
 * application data that should *not* live behind the E2E vault (because multiple services
 * need to decrypt it), or as a key-wrap layer for storage backends.
 *
 * Compared to {@link DynamicSecretsEngine}, transit operations are not leased — they're
 * stateless apart from the key versions the engine tracks for {@link rotate}.
 */
export interface TransitEngine extends SecretsEngine {
  readonly type: "transit";
  /** Encrypt a single plaintext under a named key. */
  encrypt(keyName: string, plaintext: Uint8Array, opts?: TransitEncryptOptions): Promise<TransitCiphertext>;
  /** Decrypt a {@link TransitCiphertext} produced by {@link encrypt}. */
  decrypt(keyName: string, ciphertext: string, opts?: TransitDecryptOptions): Promise<Uint8Array>;
  /** Idempotently create a key. No-op if one already exists at this name. */
  createKey(keyName: string, opts?: TransitCreateKeyOptions): Promise<void>;
  /** Rotate the key, advancing `latestVersion` by one. Older versions remain valid for decrypt. */
  rotateKey(keyName: string): Promise<{ latestVersion: number }>;
}

/** Backend-portable ciphertext: the leading `vault:vN:` prefix carries the key version. */
export interface TransitCiphertext {
  /** Opaque, base64-suffixed string. Pass back to {@link TransitEngine.decrypt} unchanged. */
  ciphertext: string;
  /** Key version that produced this ciphertext. */
  keyVersion: number;
}

export interface TransitEncryptOptions {
  /** Optional context for derived keys; binds the ciphertext to that context. */
  contextBase64?: string;
}

export interface TransitDecryptOptions {
  contextBase64?: string;
}

export interface TransitCreateKeyOptions {
  /** Default `aes256-gcm96`. Other algorithms (chacha20-poly1305, etc.) depend on backend support. */
  algorithm?: string;
  /** Allow plaintext-export of this key. Defaults to `false` — strongly recommended. */
  exportable?: boolean;
}

/**
 * PKI engine — issues, signs, and revokes X.509 certificates against a backend CA. Mirrors
 * Vault/OpenBao's `pki/*` endpoints: roles bound by name, leaf certs minted under a role,
 * CSR signing for callers that hold their own private key, serial-based revocation.
 *
 * Not a {@link DynamicSecretsEngine}: certs carry their own embedded expiration (NotAfter),
 * and Vault's PKI only emits a `lease_id` when the role has `generate_lease=true` — uncommon
 * in modern setups. arc treats PKI as lease-free for now; if a role needs lease tracking it
 * can be layered on top by the caller.
 */
export interface PkiEngine extends SecretsEngine {
  readonly type: "pki";
  issueCertificate(role: string, req: PkiIssueRequest): Promise<PkiIssuedCertificate>;
  signCsr(role: string, req: PkiSignRequest): Promise<PkiSignedCertificate>;
  revokeCertificate(serialNumber: string): Promise<PkiRevocation>;
  readCertificate(serialNumber: string): Promise<PkiCertificate>;
  listCertificates(): Promise<string[]>;
  /** PEM-encoded issuer cert at `<mount>/ca/pem`. */
  readCaCertificate(): Promise<string>;
  /** PEM-encoded CA chain at `<mount>/ca_chain`. */
  readCaChain(): Promise<string>;
}
