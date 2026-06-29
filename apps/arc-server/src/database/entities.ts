import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";

/** An opaque ciphertext envelope (docs/04). The server never interprets it. */
export type EnvelopeJson = Record<string, unknown>;

// VaultType + MemberRole live in @arc/types so the SDK, web UI, and any future client can
// reference the same union without depending on the server's TypeORM entities. Imported
// for local use in this file's column type annotations, re-exported for the DTO + service
// modules that already import from this entities barrel.
import type { AgentTaskBudget, MemberRole, VaultType } from "@arc/types";
export type { MemberRole, VaultType };
export type MemberStatus = "invited" | "active" | "revoked";

/** Account identity (sync authorization only — never holds keys). */
@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text", unique: true })
  email!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

/** One per user: salts, params, public keys, and wrapped private keys (docs/08 §8.1). */
@Entity("vault_user_keys")
export class VaultUserKeysEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int", unique: true })
  userId!: number;

  @Column({ type: "text" })
  saltMk!: string;

  @Column({ type: "text" })
  saltAuth!: string;

  @Column({ type: "simple-json" })
  argonParams!: Record<string, unknown>;

  /** Server-side re-stretched authHash (never the raw client value). */
  @Column({ type: "text" })
  authHashStored!: string;

  @Column({ type: "text" })
  serverSalt!: string;

  @Column({ type: "text" })
  identityPublicKey!: string;

  /** ML-KEM-768 public key (base64url, 1184 bytes). ADR-002. */
  @Column({ type: "text" })
  identityPublicKeyMlkem!: string;

  @Column({ type: "text" })
  signingPublicKey!: string;

  @Column({ type: "text" })
  identitySelfAttestation!: string;

  @Column({ type: "simple-json" })
  encIdentityPriv!: EnvelopeJson;

  /** ML-KEM-768 private key wrapped under WK. ADR-002. */
  @Column({ type: "simple-json" })
  encIdentityPrivMlkem!: EnvelopeJson;

  @Column({ type: "simple-json" })
  encSigningPriv!: EnvelopeJson;

  @Column({ type: "simple-json" })
  encIdentityPrivRecovery!: EnvelopeJson;

  /** ML-KEM-768 private key wrapped under the recovery-derived KEK. ADR-002. */
  @Column({ type: "simple-json" })
  encIdentityPrivMlkemRecovery!: EnvelopeJson;

  /**
   * Signing (Ed25519) private key wrapped under the recovery-derived KEK (ADR-006). Nullable
   * for back-compat: keysets enrolled before ADR-006 lack it and can't do a clean recovery.
   */
  @Column({ type: "simple-json", nullable: true })
  encSigningPrivRecovery!: EnvelopeJson | null;

  @Column({ type: "int", default: 1 })
  keyVersion!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity("vaults")
export class VaultEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text" })
  type!: VaultType;

  @Column({ type: "uuid", nullable: true })
  orgId!: string | null;

  @Column({ type: "int" })
  ownerUserId!: number;

  @Column({ type: "simple-json", nullable: true })
  encName!: EnvelopeJson | null;

  @Column({ type: "int", default: 1 })
  currentKeyVersion!: number;

  /** Per-vault monotonic mutation counter (docs/10). int is sufficient here; bigint in prod. */
  @Column({ type: "int", default: 0 })
  seqCounter!: number;

  /**
   * Optional UI icon name from `VAULT_ICONS` (`@arc/types`). Plaintext — this is a
   * picker affordance, not a secret. Nullable for back-compat with existing vaults.
   */
  @Column({ type: "text", nullable: true })
  icon!: string | null;

  /**
   * Optional UI brand colour as `#RRGGBB`, drawn from `VAULT_COLORS`. Same posture as
   * `icon`: plaintext UI metadata, nullable for back-compat, allowlist-validated server-side.
   */
  @Column({ type: "text", nullable: true })
  color!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @DeleteDateColumn({ nullable: true })
  deletedAt!: Date | null;
}

@Entity("vault_memberships")
@Unique(["vaultId", "userId"])
@Index(["vaultId", "role"])
export class VaultMembershipEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  vaultId!: string;

  @Index()
  @Column({ type: "int" })
  userId!: number;

  @Column({ type: "text" })
  role!: MemberRole;

  @Column({ type: "text", default: "active" })
  status!: MemberStatus;

  @Column({ type: "int", nullable: true })
  addedByUserId!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity("vault_key_grants")
@Unique(["vaultId", "keyVersion", "granteeUserId"])
export class VaultKeyGrantEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  vaultId!: string;

  @Column({ type: "int" })
  keyVersion!: number;

  @Column({ type: "int", nullable: true })
  granteeUserId!: number | null;

  @Column({ type: "uuid", nullable: true })
  granteeDeviceId!: string | null;

  @Column({ type: "simple-json" })
  wrappedVaultKey!: EnvelopeJson;

  @Column({ type: "int", nullable: true })
  wrappedByUserId!: number | null;

  @Column({ type: "simple-json", nullable: true })
  signature!: EnvelopeJson | null;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity("vault_items")
@Index(["vaultId", "seq"])
@Index(["vaultId", "updatedAt"])
export class VaultItemEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  vaultId!: string;

  @Column({ type: "uuid", nullable: true })
  folderId!: string | null;

  @Column({ type: "text", nullable: true })
  type!: string | null;

  @Column({ type: "simple-json" })
  ciphertext!: EnvelopeJson;

  @Column({ type: "simple-json" })
  wrappedItemKey!: EnvelopeJson;

  @Column({ type: "int" })
  vaultKeyVersion!: number;

  @Column({ type: "int", default: 1 })
  version!: number;

  @Column({ type: "int" })
  seq!: number;

  @Column({ type: "int" })
  authorUserId!: number;

  @Column({ type: "uuid", nullable: true })
  authorDeviceId!: string | null;

  @Column({ type: "simple-json", nullable: true })
  signature!: EnvelopeJson | null;

  @Column({ type: "datetime", nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

/**
 * Past versions of a vault item (history). On every *update*, `upsertItem` archives the prior
 * snapshot here before overwriting the live row in {@link VaultItemEntity} — so the current
 * version always lives in `vault_items` and history is "these rows + the live item". Each
 * snapshot keeps the exact `(ciphertext, wrappedItemKey, vaultKeyVersion)` it was encrypted
 * with, so the client can decrypt any past version; on key rotation those wrapped keys are
 * re-wrapped to the new VK (history survives a rotation). Retention is capped per item.
 */
@Entity("vault_item_versions")
@Index(["itemId", "version"], { unique: true })
@Index(["vaultId"])
export class VaultItemVersionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  itemId!: string;

  @Column({ type: "uuid" })
  vaultId!: string;

  @Column({ type: "int" })
  version!: number;

  @Column({ type: "simple-json" })
  ciphertext!: EnvelopeJson;

  @Column({ type: "simple-json" })
  wrappedItemKey!: EnvelopeJson;

  @Column({ type: "int" })
  vaultKeyVersion!: number;

  @Column({ type: "int" })
  authorUserId!: number;

  /** When this snapshot was the live version (the prior item's `updatedAt`). */
  @Column({ type: "datetime" })
  savedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity("vault_devices")
@Index(["userId", "approved"])
export class VaultDeviceEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "int" })
  userId!: number;

  @Column({ type: "text" })
  name!: string;

  /** Device X25519 public key (b64url). Always present for back-compat with classical seal. */
  @Column({ type: "text" })
  publicKey!: string;

  /**
   * Optional device ML-KEM-768 public key (b64url). Present when the device was enrolled by
   * an ADR-003 client; absent for legacy X25519-only devices. When present, the trusted
   * approver wraps the VK with `pqSeal` instead of `seal`.
   */
  @Column({ type: "text", nullable: true })
  publicKeyMlkem!: string | null;

  @Column({ type: "boolean", default: false })
  trusted!: boolean;

  @Column({ type: "boolean", default: false })
  approved!: boolean;

  @Column({ type: "datetime", nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}

/** Signed vault-head for rollback/omission detection (docs/10 §10.5). */
@Entity("vault_heads")
export class VaultHeadEntity {
  @PrimaryColumn({ type: "uuid" })
  vaultId!: string;

  @Column({ type: "int" })
  seq!: number;

  @Column({ type: "text" })
  chainHash!: string;

  @Column({ type: "text" })
  ts!: string;

  @Column({ type: "simple-json" })
  signature!: EnvelopeJson;

  @Column({ type: "int" })
  signerUserId!: number;

  @UpdateDateColumn()
  updatedAt!: Date;
}

/** Metadata-only audit log (docs/11). Never stores item content. */
@Entity("vault_audit_log")
export class VaultAuditLogEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid", nullable: true })
  vaultId!: string | null;

  @Column({ type: "int", nullable: true })
  actorUserId!: number | null;

  @Column({ type: "text" })
  action!: string;

  @Column({ type: "text", nullable: true })
  targetId!: string | null;

  // --- Engine-C agentic attribution (ADR-005). All nullable: human/service/device rows
  // leave them empty and behave exactly as before; agent-driven rows fill them so the
  // existing audit query API answers "who authorized this, which agent, under what
  // delegation, in which task" with no new endpoint. ---

  /** `user` | `agent` | `service` | `device`. Null ⇒ legacy/human (treated as `user`). */
  @Column({ type: "text", nullable: true })
  actorKind!: string | null;

  @Index()
  @Column({ type: "uuid", nullable: true })
  agentId!: string | null;

  @Column({ type: "uuid", nullable: true })
  delegationId!: string | null;

  @Index()
  @Column({ type: "uuid", nullable: true })
  taskId!: string | null;

  /** Optional tool-call detail for agent-driven Engine-A actions (ADR-005 Phase 3). */
  @Column({ type: "simple-json", nullable: true })
  toolCall!: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity("vault_folders")
export class VaultFolderEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  vaultId!: string;

  @Column({ type: "simple-json" })
  encName!: EnvelopeJson;

  @Column({ type: "uuid", nullable: true })
  parentId!: string | null;

  @Column({ type: "int", default: 0 })
  seq!: number;

  @Column({ type: "datetime", nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

/**
 * One row per registered passkey credential. The server holds the credential's public
 * key + signature counter (anti-clone), and the identity-private-key envelopes wrapped
 * under the per-credential PRF-derived KEK (see `wrapIdentityForPasskey` in arc-crypto).
 *
 * On unlock: client produces a WebAuthn assertion + extracts the PRF output, the server
 * verifies the assertion and returns the wrapped envelopes; the client unwraps them with
 * its PRF output entirely client-side — the server never sees the PRF output, the
 * identity key, or the master key. Same zero-knowledge posture as master-password unlock.
 */
@Entity("vault_user_passkeys")
@Unique(["userId", "credentialId"])
export class VaultUserPasskeyEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "int" })
  userId!: number;

  /** Base64url credential ID from the WebAuthn registration response. */
  @Column({ type: "text" })
  credentialId!: string;

  /** Base64url COSE public key. Stored exactly as `@simplewebauthn/server` returns it. */
  @Column({ type: "text" })
  publicKey!: string;

  /** Monotonic signature counter — anti-clone. Must strictly increase on each unlock. */
  @Column({ type: "bigint" })
  counter!: string;

  /**
   * Optional friendly label (e.g. "MacBook Touch ID", "YubiKey 5"). Returned in the
   * listing so the user can pick which passkey to unenroll.
   */
  @Column({ type: "text", nullable: true })
  label!: string | null;

  /** Identity X25519 private key wrapped under the PRF-derived KEK (per-credential). */
  @Column({ type: "simple-json" })
  encIdentityPrivPasskey!: EnvelopeJson;

  /** Identity ML-KEM-768 private key wrapped under the same KEK (PQ-hybrid path). */
  @Column({ type: "simple-json" })
  encIdentityPrivMlkemPasskey!: EnvelopeJson;

  /**
   * Signing (Ed25519) private key wrapped under the PRF-derived KEK. Wrapping all three
   * keys lets passkey unlock produce a full-capability session — decrypt VKs via identity
   * keys *and* sign vault-head updates. Without this, passkey unlock would be read-only.
   */
  @Column({ type: "simple-json" })
  encSigningPrivPasskey!: EnvelopeJson;

  /** Transports hint from the registration response — used to populate `allowCredentials`. */
  @Column({ type: "simple-json", nullable: true })
  transports!: string[] | null;

  /**
   * Per-user PRF salt (base64url). Stable across all of a user's credentials — without
   * this, each register would mint a different salt and the unlock-time PRF output
   * wouldn't match the register-time wrap key. The salt itself is non-secret; rotating
   * it requires re-registering every credential under the new salt.
   */
  @Column({ type: "text" })
  prfSalt!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

/** Scope shape stored inside a {@link PolicyEntity} (matches `@arc/grants`' `Scope`). */
export interface StoredScope {
  pathPrefix: string;
  capabilities: string[];
}

/**
 * A named policy bundle (Engine-A ACL). Mirrors `@arc/grants`' `Policy`: a name + a list of
 * path/capability scopes, serialized as JSON. The `name` is the natural primary key — policy
 * names are the handle admins attach to subjects, the same model Vault/OpenBao use.
 */
@Entity("policies")
export class PolicyEntity {
  @PrimaryColumn({ type: "text" })
  name!: string;

  @Column({ type: "simple-json" })
  scopes!: StoredScope[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

/**
 * Attaches a policy to a subject (today: a user id as a string; later: a service-account or
 * plugin identity). The (subject, policyName) pair is unique — attaching twice is a no-op.
 * No FK to `policies` on purpose: a removed policy with a lingering attachment is tolerated
 * (the lookup filters it out), matching the in-memory store's behavior.
 */
@Entity("policy_attachments")
@Unique(["subject", "policyName"])
export class PolicyAttachmentEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "text" })
  subject!: string;

  @Column({ type: "text" })
  policyName!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

/**
 * Subject ↔ group membership. Group names are opaque strings (no separate "groups"
 * table) — a group with no members and no policies attached doesn't exist. Indexed by
 * both columns so `listGroupsForSubject` and `listSubjectsInGroup` are both fast.
 */
@Entity("policy_group_memberships")
@Unique(["subject", "groupName"])
export class PolicyGroupMembershipEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "text" })
  subject!: string;

  @Index()
  @Column({ type: "text" })
  groupName!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

/**
 * Group ↔ policy attachments. Same shape as {@link PolicyAttachmentEntity} but keyed by
 * group name instead of subject. No FK to `policies` for the same reason — a removed
 * policy with a lingering link is silently filtered on read.
 */
@Entity("policy_group_attachments")
@Unique(["groupName", "policyName"])
export class PolicyGroupAttachmentEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "text" })
  groupName!: string;

  @Column({ type: "text" })
  policyName!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

/**
 * Encrypted attachment metadata. The ciphertext bytes live in the BlobStore (memory / fs /
 * S3) keyed by `blobKey`; this row keeps only the wrapped attachment key + encrypted
 * filename/MIME envelope + size, so the server stays zero-knowledge about the attachment's
 * content. Deleting the row deletes the blob.
 */
@Entity("vault_attachments")
@Index(["vaultId", "itemId"])
export class VaultAttachmentEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  vaultId!: string;

  @Index()
  @Column({ type: "uuid" })
  itemId!: string;

  /** Opaque key into the BlobStore where the ciphertext bytes live. */
  @Column({ type: "text" })
  blobKey!: string;

  /** Ciphertext size in bytes (for quotas / UI; not the plaintext size). */
  @Column({ type: "int" })
  sizeBytes!: number;

  /** The attachment's content key, wrapped to the vault key (client-side). */
  @Column({ type: "simple-json" })
  wrappedKey!: EnvelopeJson;

  /** Encrypted filename + MIME (an envelope the client decrypts). */
  @Column({ type: "simple-json" })
  encMetadata!: EnvelopeJson;

  @Column({ type: "int" })
  vaultKeyVersion!: number;

  @Column({ type: "int" })
  authorUserId!: number;

  @CreateDateColumn()
  createdAt!: Date;
}

// --- Engine-C: agentic identity (ADR-005) ---

export type AgentStatusCol = "active" | "suspended" | "retired";

/**
 * An AI agent principal (ADR-005). A first-class identity — not a user, not a service
 * account — owned by a user, carrying its own Ed25519 signing key + X25519/ML-KEM-768
 * hybrid identity (so VK grants and dynamic creds can be `pqSeal`-wrapped to it). Attaches
 * to `@arc/grants` policies via the opaque `agent:<id>` subject handle.
 */
@Entity("vault_agents")
export class VaultAgentEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "int" })
  ownerUserId!: number;

  @Column({ type: "text" })
  displayName!: string;

  /** Ed25519 verifying key (b64url) — verifies intents the agent signs. */
  @Column({ type: "text" })
  signingPublicKey!: string;

  /** X25519 identity public key (b64url). */
  @Column({ type: "text" })
  identityPublicKey!: string;

  /** ML-KEM-768 identity public key (b64url) — ADR-002 PQ half. */
  @Column({ type: "text" })
  identityPublicKeyMlkem!: string;

  /** Opaque attestation (e.g. SPIFFE SVID) recorded at enrollment; null when none. */
  @Column({ type: "simple-json", nullable: true })
  attestation!: Record<string, unknown> | null;

  /** Deny-by-default (ADR-005): false unless an admin enabled autonomous operation. */
  @Column({ type: "boolean", default: false })
  autonomousAllowed!: boolean;

  @Column({ type: "text", default: "active" })
  status!: AgentStatusCol;

  /**
   * HIGH-C (audit): outstanding agent JWTs are bound to this counter at issuance. Any
   * event that should revoke the agent's existing tokens (task closure today; suspend /
   * delegation revoke later) bumps the counter, instantly invalidating every JWT minted
   * before the bump — the JwtAuthGuard refuses with `agent_token_revoked`. Defaults to 0
   * so existing rows + JWTs minted before this migration keep working until natural TTL.
   */
  @Column({ type: "int", default: 0 })
  tokenEpoch!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  lastSeenAt!: Date | null;
}

/**
 * A signed delegation: a user lending scoped, time-boxed Engine-A authority to an agent
 * (ADR-005). `claims` is the canonical signed body; `signature` is the delegator's Ed25519
 * envelope over it. Effective authority is the intersection of `claims.scopes` with the
 * delegator's own policy and the agent's own policy — a delegation can only narrow.
 */
@Entity("vault_delegations")
export class VaultDelegationEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  agentId!: string;

  /** The delegating user (subject `user:<delegatorUserId>`). */
  @Index()
  @Column({ type: "int" })
  delegatorUserId!: number;

  /** Binds the delegation to a task unit (Phase 3). */
  @Index()
  @Column({ type: "uuid" })
  taskId!: string;

  /** The full signed claims object as received (source of truth for re-verification). */
  @Column({ type: "simple-json" })
  claims!: Record<string, unknown>;

  /** The delegator's signature envelope over `claims`. */
  @Column({ type: "simple-json" })
  signature!: EnvelopeJson;

  @Column({ type: "datetime" })
  notBefore!: Date;

  @Index()
  @Column({ type: "datetime" })
  notAfter!: Date;

  @Column({ type: "int", nullable: true })
  maxCalls!: number | null;

  @Column({ type: "int", default: 0 })
  callsUsed!: number;

  @Column({ type: "boolean", default: false })
  elevated!: boolean;

  @Column({ type: "datetime", nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}

export type AgentTaskStatusCol = "open" | "closed" | "expired" | "exhausted";

/**
 * A task (ADR-005 Phase 3): the revocable unit binding an agent's delegation, its leases,
 * and its signed-intent chain. `chainHead` is the running per-task hash-chain head;
 * closing the task cascades revoke to every delegation + lease tagged with `taskId`.
 */
@Entity("vault_agent_tasks")
export class VaultAgentTaskEntity {
  /** The task id is the shared key with the delegation + lease tags. */
  @PrimaryColumn({ type: "uuid" })
  taskId!: string;

  @Index()
  @Column({ type: "uuid" })
  agentId!: string;

  @Column({ type: "int" })
  ownerUserId!: number;

  @Column({ type: "uuid", nullable: true })
  delegationId!: string | null;

  /** `{ wallClockMs, maxCalls, maxSecretsUnsealed }`. */
  @Column({ type: "simple-json" })
  budget!: AgentTaskBudget;

  @Column({ type: "int", default: 0 })
  callsUsed!: number;

  @Column({ type: "int", default: 0 })
  secretsUnsealed!: number;

  /** Running per-task intent-chain head (hex). Starts at ZERO_CHAIN. */
  @Column({ type: "text" })
  chainHead!: string;

  @Column({ type: "text", default: "open" })
  status!: AgentTaskStatusCol;

  @Column({ type: "datetime" })
  deadlineAt!: Date;

  @CreateDateColumn()
  openedAt!: Date;

  @Column({ type: "datetime", nullable: true })
  closedAt!: Date | null;
}

/**
 * One recorded signed intent (ADR-005 Phase 3): the agent's signed declaration of an action,
 * its authorization decision, and the chain head *after* folding it in. The ordered set of
 * these for a task reproduces `task.chainHead` — tamper-evidence + gap detection.
 */
@Entity("vault_agent_intents")
@Index("UQ_vault_agent_intents_task_digest", ["taskId", "intentDigest"], {
  unique: true,
  where: '"intentDigest" IS NOT NULL',
})
export class VaultAgentIntentEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  taskId!: string;

  @Column({ type: "uuid" })
  agentId!: string;

  /** 0-based position within the task's chain. */
  @Column({ type: "int" })
  seq!: number;

  @Column({ type: "simple-json" })
  claims!: Record<string, unknown>;

  @Column({ type: "simple-json" })
  signature!: EnvelopeJson;

  /** Chain head after folding this intent (`chainNext(prev, intentDigest(claims))`). */
  @Column({ type: "text" })
  chainHead!: string;

  /**
   * HIGH-D (audit): `intentDigest(claims)` persisted so the unique constraint above
   * catches replay at the DB layer (`(taskId, intentDigest)` partial-unique on the
   * non-null rows). Nullable so the migration is additive — pre-existing test rows
   * have NULL and the partial-unique index skips them. New rows always write it.
   */
  @Column({ type: "text", nullable: true })
  intentDigest!: string | null;

  @Column({ type: "text" })
  decision!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

export type ApprovalStatusCol = "pending" | "approved" | "denied" | "consumed";

/**
 * A push-consent approval (ADR-005 Phase 4). An `elevated` delegation can't act until the
 * owning human proves control out-of-band (a WebAuthn assertion) — arc's CIBA. The row binds
 * the approval to a specific intent via `intentDigest`, so a granted approval authorizes
 * exactly the action that was shown to the human, and nothing else.
 */
@Entity("vault_pending_approvals")
export class VaultPendingApprovalEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  agentId!: string;

  @Index()
  @Column({ type: "uuid" })
  taskId!: string;

  @Index()
  @Column({ type: "int" })
  ownerUserId!: number;

  /** `intentDigest(claims)` — pins the approval to one exact action. */
  @Index()
  @Column({ type: "text" })
  intentDigest!: string;

  @Column({ type: "text" })
  op!: string;

  @Column({ type: "text" })
  path!: string;

  @Column({ type: "text", default: "pending" })
  status!: ApprovalStatusCol;

  /** WebAuthn challenge issued when the owner begins approval; null until then. */
  @Column({ type: "text", nullable: true })
  challenge!: string | null;

  @Column({ type: "datetime" })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: "datetime", nullable: true })
  resolvedAt!: Date | null;
}

export type ItemSharePermission = "view" | "edit";

/**
 * Item-level share (ADR-007). One row = one user has cryptographic access to one *version*
 * of one item, via `wrappedIK` (the item key re-wrapped with `pqSeal` to the recipient's
 * hybrid identity). Server stays zero-knowledge: it just stores envelopes + a ciphertext
 * snapshot. Unique on `(itemId, granteeUserId)` so re-sharing upserts.
 *
 * Snapshot semantics on purpose: when the granter edits the source item, `upsertItem`
 * generates a fresh IK + ciphertext; the existing share's wrappedIK doesn't open the new
 * ciphertext, but the **snapshot** still decrypts (you shared a specific version). To
 * propagate updates, the granter shares again — which overwrites this row.
 */
@Entity("vault_item_shares")
@Index(["itemId", "granteeUserId"], { unique: true })
export class VaultItemShareEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  vaultId!: string;

  @Index()
  @Column({ type: "uuid" })
  itemId!: string;

  @Column({ type: "int" })
  granterUserId!: number;

  @Index()
  @Column({ type: "int" })
  granteeUserId!: number;

  @Column({ type: "text", default: "view" })
  permission!: ItemSharePermission;

  /** `pqSeal`(IK, recipient hybrid identity). Opaque envelope; server never opens it. */
  @Column({ type: "simple-json" })
  wrappedIK!: EnvelopeJson;

  /** Ciphertext + AAD context as of share time. Recipient `aeadOpen`s with the unwrapped IK. */
  @Column({ type: "simple-json" })
  ciphertext!: EnvelopeJson;

  @Column({ type: "int" })
  vaultKeyVersion!: number;

  @Column({ type: "int" })
  itemVersion!: number;

  @Column({ type: "text", nullable: true })
  itemType!: string | null;

  /**
   * TTL'd shares (ADR-007 extension): the share is treated as revoked once `expiresAt`
   * passes — excluded from the grantee's incoming list (and lazily deleted), refused for
   * write-backs. Null = no expiry.
   */
  @Column({ type: "datetime", nullable: true })
  expiresAt!: Date | null;

  // --- edit-back proposal (ADR-007 extension). One pending proposal per share row; a
  //     newer write-back overwrites. All five columns are set + cleared together. ---

  /** Grantee's proposed ciphertext, sealed under a grantee-generated IK. */
  @Column({ type: "simple-json", nullable: true })
  pendingCiphertext!: EnvelopeJson | null;

  /** That IK, `pqSeal`'d to the *granter's* hybrid identity (not the vault key). */
  @Column({ type: "simple-json", nullable: true })
  pendingWrappedIK!: EnvelopeJson | null;

  /** Source-item version the proposal was based on (AAD binds to baseVersion + 1). */
  @Column({ type: "int", nullable: true })
  pendingBaseVersion!: number | null;

  /** Vault key version at proposal time — part of the AAD ref the granter reconstructs. */
  @Column({ type: "int", nullable: true })
  pendingKeyVersion!: number | null;

  @Column({ type: "datetime", nullable: true })
  pendingAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

/**
 * A configured workflow attached to a vault (Phase 1: JIT-access / approval workflows).
 *
 * `definition` is the canonical workflow JSON (`WorkflowDefinition` from `@arc/workflows`),
 * always re-validated server-side on save — see `WorkflowsService.upsert`. The validator
 * refuses anything outside the fixed vocabulary, so a row in this table can only express
 * actions the codebase already knows how to audit.
 *
 * `version` is an optimistic-concurrency token: every successful save increments it, and
 * the next save MUST submit the version it read or it gets a 409. Stops two admins
 * silently clobbering each other's edits in the editor.
 *
 * Audit + execution: `WorkflowExecutorService` reads enabled workflows scoped to a vault
 * and runs them against incoming elevated agent intents. Disabled rows stay around but
 * the executor skips them.
 */
@Entity("vault_workflows")
@Index(["vaultId", "enabled"])
export class VaultWorkflowEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "uuid" })
  vaultId!: string;

  @Column({ type: "text" })
  name!: string;

  /** Canonical workflow definition. Server validates it on every save. */
  @Column({ type: "simple-json" })
  definition!: Record<string, unknown>;

  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  /** Bumped on every save; clients pass it back so we can refuse stale writes (409). */
  @Column({ type: "int", default: 1 })
  version!: number;

  @Column({ type: "int" })
  createdByUserId!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

/**
 * Persisted lease registry (#113). Mirrors `@arc/leasing`'s `Lease` shape so the arc
 * `LeaseManager` can be backed by Postgres instead of process memory — leases now survive a
 * server restart and stay consistent across replicas (renew/revoke take a row lock). Epoch-ms
 * timestamps are stored as `bigint`; the transformer coerces the driver's string-bigint back
 * to a JS number on read (Postgres returns bigint as string to avoid precision loss; epoch-ms
 * is well within `Number.MAX_SAFE_INTEGER`).
 */
const epochMsColumn = {
  to: (v: number | null | undefined): number | null => v ?? null,
  from: (v: string | number | null): number | null => (v == null ? null : Number(v)),
};

@Entity("vault_leases")
@Index(["mount", "revokedAt"]) // active-by-mount lookups (revokePrefix, the operator list)
@Index(["taskId"]) // ADR-005 cascade revoke on task close
export class VaultLeaseEntity {
  /** The arc-internal lease id — assigned by `LeaseManager.idGen`, not the DB. */
  @PrimaryColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "text" })
  mount!: string;

  /** Opaque backend (OpenBao / plugin) lease id; null for leases with no backend handle. */
  @Column({ type: "text", nullable: true })
  backendLeaseId!: string | null;

  @Column({ type: "int" })
  ttlSeconds!: number;

  @Column({ type: "int" })
  maxTtlSeconds!: number;

  @Column({ type: "boolean" })
  renewable!: boolean;

  @Column({ type: "bigint", transformer: epochMsColumn })
  issuedAt!: number;

  /** Indexed for the sweep janitor + the active-lease ordering. */
  @Index()
  @Column({ type: "bigint", transformer: epochMsColumn })
  expiresAt!: number;

  @Column({ type: "bigint", nullable: true, transformer: epochMsColumn })
  revokedAt!: number | null;

  /** Engine-C task binding (ADR-005); null for human-issued leases. */
  @Column({ type: "text", nullable: true })
  taskId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}

export const entities = [
  UserEntity,
  VaultUserKeysEntity,
  VaultEntity,
  VaultMembershipEntity,
  VaultKeyGrantEntity,
  VaultItemEntity,
  VaultDeviceEntity,
  VaultHeadEntity,
  VaultAuditLogEntity,
  VaultFolderEntity,
  VaultUserPasskeyEntity,
  VaultAttachmentEntity,
  PolicyEntity,
  PolicyAttachmentEntity,
  PolicyGroupMembershipEntity,
  PolicyGroupAttachmentEntity,
  VaultAgentEntity,
  VaultDelegationEntity,
  VaultAgentTaskEntity,
  VaultAgentIntentEntity,
  VaultPendingApprovalEntity,
  VaultItemShareEntity,
  VaultWorkflowEntity,
  VaultLeaseEntity,
  VaultItemVersionEntity,
];
