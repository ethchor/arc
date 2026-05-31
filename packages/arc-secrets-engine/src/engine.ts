import type { Lease } from "@arc/leasing";
import type {
  EngineType,
  IssueOptions,
  IssuedCredential,
  KvReadResult,
  KvWriteResult,
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
  deleteLatest(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** Engine that mints short-lived credentials governed by a lease (databases, cloud, SCM, …). */
export interface DynamicSecretsEngine extends SecretsEngine {
  issue(role: string, opts?: IssueOptions): Promise<IssuedCredential>;
  renew(leaseId: string, incrementSeconds?: number): Promise<Lease>;
  revoke(leaseId: string): Promise<void>;
}
