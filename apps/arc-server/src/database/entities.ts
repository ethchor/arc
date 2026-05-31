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

export type VaultType = "personal" | "team" | "org";
export type MemberRole = "owner" | "admin" | "editor" | "viewer";
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

  @Column({ type: "text" })
  signingPublicKey!: string;

  @Column({ type: "text" })
  identitySelfAttestation!: string;

  @Column({ type: "simple-json" })
  encIdentityPriv!: EnvelopeJson;

  @Column({ type: "simple-json" })
  encSigningPriv!: EnvelopeJson;

  @Column({ type: "simple-json" })
  encIdentityPrivRecovery!: EnvelopeJson;

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

  @Column({ type: "text" })
  publicKey!: string;

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
];
