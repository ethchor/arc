/**
 * A lease tracks the lifetime of a dynamically issued secret or token, mirroring Vault's
 * leasing model: every dynamic secret has a TTL, can be renewed (up to a hard max), and is
 * revoked either explicitly or automatically at expiry.
 */
export interface Lease {
  /** arc-internal lease id (opaque, unique). */
  readonly id: string;
  /** Mount path of the engine that issued the underlying secret (normalized, e.g. "database/"). */
  readonly mount: string;
  /** Opaque id from the backend that owns the real credential (e.g. an OpenBao `lease_id`). */
  readonly backendLeaseId?: string;
  /** Seconds granted per issuance/renewal before expiry. */
  readonly ttlSeconds: number;
  /** Hard ceiling: a lease can never live past `issuedAt + maxTtlSeconds`, regardless of renewals. */
  readonly maxTtlSeconds: number;
  /** Whether {@link Lease} renewal is permitted. */
  readonly renewable: boolean;
  /** Unix epoch milliseconds at issuance. */
  readonly issuedAt: number;
  /** Unix epoch milliseconds at which the lease expires unless renewed. Advanced by renewal. */
  expiresAt: number;
  /** Unix epoch milliseconds at which the lease was explicitly revoked, if ever. Terminal. */
  revokedAt?: number;
  /**
   * Engine-C task binding (ADR-005). When an agent issues a credential under a task, the
   * lease is tagged with that `taskId` so closing the task can cascade-revoke it
   * (`revokeByTaskId`). Absent for non-agent / human-issued leases.
   */
  readonly taskId?: string;
}

export type LeaseState = "active" | "expired" | "revoked";

export interface IssueLeaseInput {
  mount: string;
  ttlSeconds: number;
  /** Defaults to `ttlSeconds` when omitted. Must be >= `ttlSeconds`. */
  maxTtlSeconds?: number;
  /** Defaults to `true`. */
  renewable?: boolean;
  backendLeaseId?: string;
  /** Engine-C task binding (ADR-005) — tag the lease so task close can cascade-revoke it. */
  taskId?: string;
}

export type LeaseErrorCode =
  | "not_found"
  | "revoked"
  | "expired"
  | "not_renewable"
  | "invalid_ttl";
