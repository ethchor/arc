export type PluginKind = "secrets" | "auth" | "storage";

export interface PluginMeta {
  name: string;
  version: string;
  kind: PluginKind;
  description?: string;
}

/** Policy verbs, mirroring Vault/OpenBao capability names. */
export type Capability = "create" | "read" | "update" | "delete" | "list" | "sudo";

/** A scoped grant: which capabilities are allowed under a path prefix (normalized, trailing slash). */
export interface Scope {
  pathPrefix: string;
  capabilities: readonly Capability[];
}

// --- SecretsPlugin: dynamic credential generation + revocation (Vault "secret engine") ---

export interface IssueRequest {
  role: string;
  ttlSeconds?: number;
  params?: Record<string, unknown>;
}

export interface IssuedSecret {
  data: Record<string, unknown>;
  leaseId: string;
  ttlSeconds: number;
  renewable: boolean;
}

export interface LeaseInfo {
  leaseId: string;
  ttlSeconds: number;
  renewable: boolean;
}

export interface SecretsPlugin {
  readonly meta: PluginMeta;
  /** Validate + persist config (a plugin validates `input` against its own schema, e.g. Zod). */
  configure(input: unknown): Promise<void>;
  /** Mint a scoped, leased credential. */
  issue(req: IssueRequest): Promise<IssuedSecret>;
  renew(leaseId: string): Promise<LeaseInfo>;
  revoke(leaseId: string): Promise<void>;
}

// --- AuthPlugin: authenticate a caller against an external IdP (Vault "auth method") ---

export interface LoginRequest {
  /** Mount path of the auth method, e.g. "auth/oidc/". */
  mount: string;
  credentials: Record<string, unknown>;
}

export interface AuthResult {
  /** Stable identity (entity) id resolved by the auth method. */
  identityId: string;
  /** Display alias for this login (e.g. the IdP subject). */
  alias?: string;
  /** Policies granted to the resulting token. */
  policies: string[];
  tokenTtlSeconds: number;
  metadata?: Record<string, string>;
}

export interface AuthPlugin {
  readonly meta: PluginMeta;
  configure(input: unknown): Promise<void>;
  login(req: LoginRequest): Promise<AuthResult>;
}

// --- StoragePlugin: pluggable backend storage (optional, later) ---

export interface StoragePlugin {
  readonly meta: PluginMeta;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

export type Plugin = SecretsPlugin | AuthPlugin | StoragePlugin;
