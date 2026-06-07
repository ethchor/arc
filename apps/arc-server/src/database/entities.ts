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
import type { MemberRole, VaultType } from "@arc/types";
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
];
