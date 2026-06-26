import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { BLOB_STORE, type BlobStore, newAttachmentKey, BlobNotFoundError } from "../blob/blob-store";
import { DataSource, In, MoreThan, Repository } from "typeorm";
import { ctEqual, deviceSas, fingerprint, fromB64u, randomBytes, serverHashAuth, toB64u } from "@arc/crypto";
import { isVaultColor, isVaultIcon } from "@arc/types";
import { assertArgonParamsAboveFloor } from "./argon-floor";
import {
  type MemberRole,
  UserEntity,
  VaultAttachmentEntity,
  VaultAuditLogEntity,
  VaultDeviceEntity,
  VaultEntity,
  VaultFolderEntity,
  VaultHeadEntity,
  VaultItemEntity,
  VaultItemShareEntity,
  VaultKeyGrantEntity,
  VaultMembershipEntity,
  VaultUserKeysEntity,
} from "../database/entities";
import type {
  AddMemberDto,
  ApproveDeviceDto,
  CreateFolderDto,
  CreateItemShareDto,
  CreateVaultDto,
  EnrollDto,
  ItemShareWriteBackDto,
  PutHeadDto,
  RecoverKeysetDto,
  RegisterDeviceDto,
  RotateKeyDto,
  UpdateVaultUiDto,
  UpsertItemDto,
  UploadAttachmentDto,
} from "./dto";

/** Hard ceiling for a single attachment's ciphertext, in bytes. 25 MiB. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ROLE_RANK: Record<MemberRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
const MAX_UNLOCK_FAILS = 5;
const LOCKOUT_MS = 30_000;

interface AttemptState {
  fails: number;
  lockedUntil: number;
}

@Injectable()
export class VaultService {
  private readonly attempts = new Map<number, AttemptState>();

  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(VaultUserKeysEntity) private readonly userKeys: Repository<VaultUserKeysEntity>,
    @InjectRepository(VaultEntity) private readonly vaults: Repository<VaultEntity>,
    @InjectRepository(VaultMembershipEntity) private readonly memberships: Repository<VaultMembershipEntity>,
    @InjectRepository(VaultKeyGrantEntity) private readonly grants: Repository<VaultKeyGrantEntity>,
    @InjectRepository(VaultItemEntity) private readonly items: Repository<VaultItemEntity>,
    @InjectRepository(VaultDeviceEntity) private readonly devices: Repository<VaultDeviceEntity>,
    @InjectRepository(VaultHeadEntity) private readonly heads: Repository<VaultHeadEntity>,
    @InjectRepository(VaultAuditLogEntity) private readonly audit: Repository<VaultAuditLogEntity>,
    @InjectRepository(VaultFolderEntity) private readonly folders: Repository<VaultFolderEntity>,
    @InjectRepository(VaultAttachmentEntity) private readonly attachments: Repository<VaultAttachmentEntity>,
    @InjectRepository(VaultItemShareEntity) private readonly itemShares: Repository<VaultItemShareEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
  ) {}

  /** Email→identity lookup used by the share dialog to find a member by their address. */
  async getUserIdentityKeyByEmail(email: string) {
    const user = await this.users.findOne({ where: { email } });
    if (!user) throw new NotFoundException("user not found");
    return this.getUserIdentityKey(user.id);
  }

  // --- folders ---

  async listFolders(userId: number, vaultId: string) {
    await this.requireRole(vaultId, userId, "viewer");
    const rows = await this.folders.find({ where: { vaultId } });
    return rows.filter((f) => !f.deletedAt).map((f) => ({ id: f.id, encName: f.encName }));
  }

  async createFolder(userId: number, vaultId: string, dto: CreateFolderDto) {
    await this.requireRole(vaultId, userId, "editor");
    const f = await this.folders.save(this.folders.create({ vaultId, encName: dto.encName, parentId: null, seq: 0 }));
    await this.writeAudit(vaultId, userId, "folder_created", f.id);
    return { id: f.id };
  }

  async deleteFolder(userId: number, vaultId: string, folderId: string) {
    await this.requireRole(vaultId, userId, "editor");
    const f = await this.folders.findOne({ where: { id: folderId, vaultId } });
    if (!f) throw new NotFoundException("folder not found");
    f.deletedAt = new Date();
    await this.folders.save(f);
    await this.writeAudit(vaultId, userId, "folder_deleted", folderId);
    return { ok: true };
  }

  // --- enrollment / keyset / unlock ---

  async enroll(userId: number, dto: EnrollDto) {
    const existing = await this.userKeys.findOne({ where: { userId } });
    if (existing) {
      // Anti-takeover: a valid JWT alone must not overwrite an existing keyset (docs/06 §6.7).
      throw new ConflictException("vault already enrolled for this account");
    }
    // LOW-B (audit): refuse enrollment with KDF parameters below the floor — see
    // `argon-floor.ts`. Production rejects anything weaker than the `mobile` profile;
    // dev/test stays permissive so the existing test profile (m=256) keeps working.
    assertArgonParamsAboveFloor(dto.argonParams);
    const serverSalt = toB64u(randomBytes(16));
    await this.userKeys.save(
      this.userKeys.create({
        userId,
        saltMk: dto.saltMk,
        saltAuth: dto.saltAuth,
        argonParams: dto.argonParams,
        authHashStored: serverHashAuth(dto.authHash, serverSalt),
        serverSalt,
        identityPublicKey: dto.identityPublicKey,
        identityPublicKeyMlkem: dto.identityPublicKeyMlkem,
        signingPublicKey: dto.signingPublicKey,
        identitySelfAttestation: dto.identitySelfAttestation,
        encIdentityPriv: dto.encIdentityPriv,
        encIdentityPrivMlkem: dto.encIdentityPrivMlkem,
        encSigningPriv: dto.encSigningPriv,
        encIdentityPrivRecovery: dto.encIdentityPrivRecovery,
        encIdentityPrivMlkemRecovery: dto.encIdentityPrivMlkemRecovery,
        encSigningPrivRecovery: dto.encSigningPrivRecovery ?? null,
        keyVersion: 1,
      }),
    );

    const vault = await this.vaults.save(
      this.vaults.create({
        type: "personal",
        ownerUserId: userId,
        encName: dto.personalVaultEncName ?? null,
        currentKeyVersion: 1,
        seqCounter: 0,
      }),
    );
    await this.memberships.save(
      this.memberships.create({ vaultId: vault.id, userId, role: "owner", status: "active", addedByUserId: userId }),
    );
    await this.grants.save(
      this.grants.create({ vaultId: vault.id, keyVersion: 1, granteeUserId: userId, wrappedVaultKey: dto.ownerGrant, wrappedByUserId: userId }),
    );

    let deviceId: string | undefined;
    if (dto.device) {
      const dev = await this.devices.save(
        this.devices.create({ userId, name: dto.device.name, publicKey: dto.device.publicKey, trusted: true, approved: true }),
      );
      deviceId = dev.id;
      if (dto.device.encVaultKey) {
        await this.grants.save(
          this.grants.create({ vaultId: vault.id, keyVersion: 1, granteeDeviceId: dev.id, wrappedVaultKey: dto.device.encVaultKey, wrappedByUserId: userId }),
        );
      }
    }

    await this.writeAudit(vault.id, userId, "vault_created", vault.id);
    return { vaultId: vault.id, deviceId };
  }

  async getKeyset(userId: number) {
    const k = await this.userKeys.findOne({ where: { userId } });
    if (!k) throw new NotFoundException("not enrolled");
    return {
      saltMk: k.saltMk,
      saltAuth: k.saltAuth,
      argonParams: k.argonParams,
      identityPublicKey: k.identityPublicKey,
      identityPublicKeyMlkem: k.identityPublicKeyMlkem,
      signingPublicKey: k.signingPublicKey,
      encIdentityPriv: k.encIdentityPriv,
      encIdentityPrivMlkem: k.encIdentityPrivMlkem,
      encSigningPriv: k.encSigningPriv,
      encIdentityPrivRecovery: k.encIdentityPrivRecovery,
      encIdentityPrivMlkemRecovery: k.encIdentityPrivMlkemRecovery,
      encSigningPrivRecovery: k.encSigningPrivRecovery,
      keyVersion: k.keyVersion,
    };
  }

  /**
   * Master-password recovery (ADR-006): replace the *wrapping* layer of an existing keyset.
   * The three public keys are **pinned** — any mismatch is rejected, which is the
   * anti-takeover guarantee (a session-holder without the recovery key can never swap in
   * their own identity). The identity stays the same, so every grant + signature keeps
   * working; only the password-derived + recovery wrapping, salts, authHash, and
   * self-attestation change.
   */
  async recoverKeyset(userId: number, dto: RecoverKeysetDto) {
    const k = await this.userKeys.findOne({ where: { userId } });
    if (!k) throw new NotFoundException("not enrolled");

    if (
      dto.identityPublicKey !== k.identityPublicKey ||
      dto.identityPublicKeyMlkem !== k.identityPublicKeyMlkem ||
      dto.signingPublicKey !== k.signingPublicKey
    ) {
      // Pinned identity: recovery re-wraps the *same* keys, it never rotates the identity.
      throw new BadRequestException({ error: "identity_pubkey_mismatch" });
    }
    // LOW-B (audit): recovery re-establishes the WK-wrap layer, so the same KDF-floor
    // check that gates enrollment must gate recovery — otherwise an attacker who
    // compromised the recovery key could re-enrol with weak params and degrade the
    // password-side defenses for future unlocks.
    assertArgonParamsAboveFloor(dto.argonParams);

    const serverSalt = toB64u(randomBytes(16));
    k.saltMk = dto.saltMk;
    k.saltAuth = dto.saltAuth;
    k.argonParams = dto.argonParams;
    k.authHashStored = serverHashAuth(dto.authHash, serverSalt);
    k.serverSalt = serverSalt;
    k.identitySelfAttestation = dto.identitySelfAttestation;
    k.encIdentityPriv = dto.encIdentityPriv;
    k.encIdentityPrivMlkem = dto.encIdentityPrivMlkem;
    k.encSigningPriv = dto.encSigningPriv;
    k.encIdentityPrivRecovery = dto.encIdentityPrivRecovery;
    k.encIdentityPrivMlkemRecovery = dto.encIdentityPrivMlkemRecovery;
    k.encSigningPrivRecovery = dto.encSigningPrivRecovery;
    await this.userKeys.save(k);

    // Clear any unlock-attempt lockout — the password just legitimately changed.
    this.attempts.delete(userId);
    await this.writeAudit(null, userId, "keyset_recovered", null);
    return { ok: true };
  }

  async unlock(userId: number, authHash: string) {
    const state = this.attempts.get(userId);
    if (state && state.lockedUntil > Date.now()) {
      throw new HttpException(
        { error: "locked", retryAfter: Math.ceil((state.lockedUntil - Date.now()) / 1000) },
        423,
      );
    }
    const k = await this.userKeys.findOne({ where: { userId } });
    if (!k) throw new NotFoundException("not enrolled");

    const candidate = serverHashAuth(authHash, k.serverSalt);
    if (!ctEqual(fromB64u(candidate), fromB64u(k.authHashStored))) {
      const fails = (state?.fails ?? 0) + 1;
      this.attempts.set(userId, {
        fails,
        lockedUntil: fails >= MAX_UNLOCK_FAILS ? Date.now() + LOCKOUT_MS : 0,
      });
      await this.writeAudit(null, userId, "unlock_failed", null);
      throw new UnauthorizedException("unlock failed");
    }
    this.attempts.delete(userId);
    return { ok: true };
  }

  // --- vaults / membership ---

  async listVaults(userId: number) {
    const mems = await this.memberships.find({ where: { userId, status: "active" } });
    const out = [];
    for (const m of mems) {
      const v = await this.vaults.findOne({ where: { id: m.vaultId } });
      if (!v || v.deletedAt) continue;
      const grant = await this.grants.findOne({
        where: { vaultId: v.id, granteeUserId: userId, keyVersion: v.currentKeyVersion },
      });
      out.push({
        id: v.id,
        type: v.type,
        encName: v.encName,
        icon: v.icon,
        color: v.color,
        currentKeyVersion: v.currentKeyVersion,
        role: m.role,
        grant: grant?.wrappedVaultKey ?? null,
      });
    }
    return out;
  }

  async createVault(userId: number, dto: CreateVaultDto) {
    // Allowlist-validate the UI affordance before we hit the DB — the column is plaintext
    // and gets rendered, so unknown values are rejected outright (no XSS via icon names, no
    // surprise URLs through the colour field).
    if (dto.icon !== undefined && !isVaultIcon(dto.icon)) {
      throw new BadRequestException({ error: "invalid_icon", icon: dto.icon });
    }
    if (dto.color !== undefined && !isVaultColor(dto.color)) {
      throw new BadRequestException({ error: "invalid_color", color: dto.color });
    }
    const vault = await this.vaults.save(
      this.vaults.create({
        type: dto.type,
        ownerUserId: userId,
        encName: dto.encName ?? null,
        icon: dto.icon ?? null,
        color: dto.color ?? null,
        currentKeyVersion: 1,
        seqCounter: 0,
      }),
    );
    await this.memberships.save(
      this.memberships.create({ vaultId: vault.id, userId, role: "owner", status: "active", addedByUserId: userId }),
    );
    await this.grants.save(
      this.grants.create({ vaultId: vault.id, keyVersion: 1, granteeUserId: userId, wrappedVaultKey: dto.ownerGrant, wrappedByUserId: userId }),
    );
    await this.writeAudit(vault.id, userId, "vault_created", vault.id);
    return {
      id: vault.id,
      currentKeyVersion: vault.currentKeyVersion,
      icon: vault.icon,
      color: vault.color,
    };
  }

  /**
   * Patch the per-vault UI affordance columns. Requires admin-or-higher because changing
   * the icon/colour is visible to every member — picker chrome, not the vault's own data.
   *
   * Semantics: `undefined` means "leave it alone"; `null` means "clear it". Each field is
   * validated against the same closed allowlists as `createVault` before any write.
   */
  async updateVaultUi(userId: number, vaultId: string, dto: UpdateVaultUiDto) {
    await this.requireRole(vaultId, userId, "admin");
    const vault = await this.vaults.findOne({ where: { id: vaultId } });
    if (!vault) throw new NotFoundException("vault not found");

    if (dto.icon !== undefined) {
      if (dto.icon !== null && !isVaultIcon(dto.icon)) {
        throw new BadRequestException({ error: "invalid_icon", icon: dto.icon });
      }
      vault.icon = dto.icon;
    }
    if (dto.color !== undefined) {
      if (dto.color !== null && !isVaultColor(dto.color)) {
        throw new BadRequestException({ error: "invalid_color", color: dto.color });
      }
      vault.color = dto.color;
    }
    await this.vaults.save(vault);
    await this.writeAudit(vaultId, userId, "vault_ui_updated", vaultId);
    return { id: vault.id, icon: vault.icon, color: vault.color };
  }

  async listMembers(userId: number, vaultId: string) {
    await this.requireRole(vaultId, userId, "viewer");
    const mems = await this.memberships.find({ where: { vaultId } });
    // Revoked members no longer hold access; the screen lists identities that *can* decrypt.
    return mems
      .filter((m) => m.status !== "revoked")
      .map((m) => ({ userId: m.userId, role: m.role, status: m.status }));
  }

  /**
   * Revoke a member's access: mark the membership revoked and delete their VK grants so the
   * server can never hand them the key again. Forward secrecy (they can't open *future* data)
   * comes from the client re-keying the vault right after this returns. Owner/admin only;
   * refuses to remove yourself or the last owner (which would orphan the vault).
   */
  async removeMember(userId: number, vaultId: string, targetUserId: number) {
    await this.requireRole(vaultId, userId, "admin");
    if (!Number.isInteger(targetUserId)) throw new BadRequestException({ error: "invalid_user" });
    if (targetUserId === userId) throw new BadRequestException({ error: "cannot_remove_self" });
    const target = await this.memberships.findOne({ where: { vaultId, userId: targetUserId } });
    if (!target || target.status === "revoked") throw new NotFoundException("member not found");
    if (target.role === "owner") {
      const owners = await this.memberships.count({
        where: { vaultId, role: "owner", status: "active" },
      });
      if (owners <= 1) throw new BadRequestException({ error: "cannot_remove_last_owner" });
    }
    target.status = "revoked";
    await this.memberships.save(target);
    await this.grants.delete({ vaultId, granteeUserId: targetUserId });
    await this.writeAudit(vaultId, userId, "member_revoked", String(targetUserId));
    return { ok: true };
  }

  async addMember(userId: number, vaultId: string, dto: AddMemberDto) {
    await this.requireRole(vaultId, userId, "admin");
    let m = await this.memberships.findOne({ where: { vaultId, userId: dto.userId } });
    if (m) {
      m.role = dto.role;
      m.status = "active";
      await this.memberships.save(m);
    } else {
      await this.memberships.save(
        this.memberships.create({ vaultId, userId: dto.userId, role: dto.role, status: "active", addedByUserId: userId }),
      );
    }
    await this.grants.save(
      this.grants.create({
        vaultId,
        keyVersion: dto.keyVersion,
        granteeUserId: dto.userId,
        wrappedVaultKey: dto.wrappedVaultKey,
        wrappedByUserId: userId,
        signature: dto.signature ?? null,
      }),
    );
    await this.writeAudit(vaultId, userId, "member_added", String(dto.userId));
    return { ok: true };
  }

  // --- items / sync ---

  async getItems(userId: number, vaultId: string, since: number) {
    await this.requireRole(vaultId, userId, "viewer");
    const rows = await this.items.find({
      where: { vaultId, seq: MoreThan(since) },
      order: { seq: "ASC" },
    });
    const vault = await this.vaults.findOne({ where: { id: vaultId } });
    return {
      items: rows.map((i) => this.toWireItem(i)),
      cursor: vault?.seqCounter ?? since,
    };
  }

  async upsertItem(userId: number, vaultId: string, dto: UpsertItemDto) {
    await this.requireRole(vaultId, userId, "editor");
    return this.dataSource.transaction(async (mgr) => {
      const vault = await mgr.findOne(VaultEntity, { where: { id: vaultId } });
      if (!vault) throw new NotFoundException("vault not found");

      let item = dto.id
        ? await mgr.findOne(VaultItemEntity, { where: { id: dto.id, vaultId } })
        : null;

      if (item) {
        // Optimistic concurrency (docs/10 §10.3): stale write -> 409 with current ciphertext.
        if (dto.baseVersion === undefined || item.version !== dto.baseVersion) {
          throw new ConflictException({ error: "conflict", current: this.toWireItem(item) });
        }
        vault.seqCounter += 1;
        item.ciphertext = dto.ciphertext;
        item.wrappedItemKey = dto.wrappedItemKey;
        item.vaultKeyVersion = dto.vaultKeyVersion;
        item.type = dto.type ?? item.type;
        item.folderId = dto.folderId ?? item.folderId;
        item.signature = dto.signature ?? null;
        item.version += 1;
        item.seq = vault.seqCounter;
        item.deletedAt = null;
        item.authorUserId = userId;
        await mgr.save(vault);
        item = await mgr.save(item);
        await this.writeAudit(vaultId, userId, "item_updated", item.id);
      } else {
        vault.seqCounter += 1;
        item = mgr.create(VaultItemEntity, {
          id: dto.id,
          vaultId,
          ciphertext: dto.ciphertext,
          wrappedItemKey: dto.wrappedItemKey,
          vaultKeyVersion: dto.vaultKeyVersion,
          type: dto.type ?? null,
          folderId: dto.folderId ?? null,
          signature: dto.signature ?? null,
          version: 1,
          seq: vault.seqCounter,
          authorUserId: userId,
        });
        await mgr.save(vault);
        item = await mgr.save(item);
        await this.writeAudit(vaultId, userId, "item_created", item.id);
      }
      return { id: item.id, version: item.version, seq: item.seq, updatedAt: item.updatedAt };
    });
  }

  async deleteItem(userId: number, vaultId: string, itemId: string) {
    await this.requireRole(vaultId, userId, "editor");
    return this.dataSource.transaction(async (mgr) => {
      const vault = await mgr.findOne(VaultEntity, { where: { id: vaultId } });
      const item = await mgr.findOne(VaultItemEntity, { where: { id: itemId, vaultId } });
      if (!vault || !item) throw new NotFoundException("item not found");
      vault.seqCounter += 1;
      item.deletedAt = new Date();
      item.version += 1;
      item.seq = vault.seqCounter;
      item.authorUserId = userId;
      await mgr.save(vault);
      await mgr.save(item);
      await this.writeAudit(vaultId, userId, "item_deleted", item.id);
      return { ok: true, seq: item.seq };
    });
  }

  /** Rotate the vault key (docs/07 §7.5): bump version, add new grants, re-point IKs. */
  async rotateKey(userId: number, vaultId: string, dto: RotateKeyDto) {
    await this.requireRole(vaultId, userId, "admin");
    return this.dataSource.transaction(async (mgr) => {
      const vault = await mgr.findOne(VaultEntity, { where: { id: vaultId } });
      if (!vault) throw new NotFoundException("vault not found");
      vault.currentKeyVersion = dto.newKeyVersion;
      // The vault name is sealed under the VK, so the client re-seals it under the new key and
      // sends it here; without this the name breaks on every rotation. `undefined` (older
      // clients) leaves the stored name as-is.
      if (dto.encName !== undefined) vault.encName = dto.encName;

      for (const g of dto.grants) {
        await mgr.save(
          mgr.create(VaultKeyGrantEntity, {
            vaultId,
            keyVersion: dto.newKeyVersion,
            granteeUserId: g.granteeUserId,
            wrappedVaultKey: g.wrappedVaultKey,
            wrappedByUserId: userId,
            signature: g.signature ?? null,
          }),
        );
      }

      for (const r of dto.rewrappedItemKeys) {
        const item = await mgr.findOne(VaultItemEntity, { where: { id: r.itemId, vaultId } });
        if (!item) continue;
        // Re-wrap only changes the wrapped IK + its VK version. The payload (and its item
        // version, which its AAD binds) is untouched. Bump seq so the change syncs.
        vault.seqCounter += 1;
        item.wrappedItemKey = r.wrappedItemKey;
        item.vaultKeyVersion = dto.newKeyVersion;
        item.seq = vault.seqCounter;
        await mgr.save(item);
      }

      await mgr.save(vault);
      await this.writeAudit(vaultId, userId, "vault_key_rotated", String(dto.newKeyVersion));
      return { ok: true, keyVersion: dto.newKeyVersion };
    });
  }

  // --- signed vault-head (docs/10 §10.5) ---

  async getHead(userId: number, vaultId: string) {
    await this.requireRole(vaultId, userId, "viewer");
    const head = await this.heads.findOne({ where: { vaultId } });
    return head
      ? { seq: head.seq, chainHash: head.chainHash, ts: head.ts, signature: head.signature, signerUserId: head.signerUserId }
      : null;
  }

  async putHead(userId: number, vaultId: string, dto: PutHeadDto) {
    await this.requireRole(vaultId, userId, "editor");
    let head = await this.heads.findOne({ where: { vaultId } });
    if (head) {
      head.seq = dto.seq;
      head.chainHash = dto.chainHash;
      head.ts = dto.ts;
      head.signature = dto.signature;
      head.signerUserId = userId;
      await this.heads.save(head);
    } else {
      await this.heads.save(
        this.heads.create({ vaultId, seq: dto.seq, chainHash: dto.chainHash, ts: dto.ts, signature: dto.signature, signerUserId: userId }),
      );
    }
    return { ok: true };
  }

  // --- directory / devices ---

  async getUserIdentityKey(targetUserId: number) {
    const k = await this.userKeys.findOne({ where: { userId: targetUserId } });
    if (!k) throw new NotFoundException("user has no published identity key");
    return {
      userId: targetUserId,
      identityPublicKey: k.identityPublicKey,
      identityPublicKeyMlkem: k.identityPublicKeyMlkem,
      signingPublicKey: k.signingPublicKey,
      identitySelfAttestation: k.identitySelfAttestation,
      fingerprint: fingerprint(fromB64u(k.identityPublicKey)),
    };
  }

  async registerDevice(userId: number, dto: RegisterDeviceDto) {
    const dev = await this.devices.save(
      this.devices.create({
        userId,
        name: dto.name,
        publicKey: dto.publicKey,
        publicKeyMlkem: dto.publicKeyMlkem ?? null,
        trusted: false,
        approved: false,
      }),
    );
    await this.writeAudit(null, userId, "device_added", dev.id);
    return { id: dev.id, approved: false };
  }

  async listPendingDevices(userId: number) {
    const devs = await this.devices.find({ where: { userId, approved: false } });
    return devs.map((d) => ({
      id: d.id,
      name: d.name,
      publicKey: d.publicKey,
      // Exposed so the trusted approver knows whether to wrap with `pqSeal` (ADR-003) vs
      // the classical `seal` envelope. `null` for legacy X25519-only devices.
      publicKeyMlkem: d.publicKeyMlkem,
      // LOW-D (audit): SAS binds both halves of the hybrid pair so a MITM swapping the
      // ML-KEM pub can't slip past the human compare. Legacy X25519-only devices
      // (`publicKeyMlkem == null`) use the old fingerprint shape under the hood.
      verificationCode: deviceSas(
        fromB64u(d.publicKey),
        d.publicKeyMlkem ? fromB64u(d.publicKeyMlkem) : null,
      ),
    }));
  }

  /**
   * List the user's approved devices with their last-seen timestamp + trusted flag. Used
   * by the device-management UI ("My devices") and by the auto-revoke job to drive its
   * stale-device scan.
   */
  async listApprovedDevices(userId: number) {
    const devs = await this.devices.find({ where: { userId, approved: true } });
    return devs.map((d) => ({
      id: d.id,
      name: d.name,
      publicKey: d.publicKey,
      // `null` for legacy X25519-only devices (enrolled before ADR-003).
      publicKeyMlkem: d.publicKeyMlkem,
      trusted: d.trusted,
      lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  /**
   * Update a device's `lastSeenAt` to now. Validates that the device belongs to the
   * authenticated user — a different user's deviceId is rejected as 404. Cheap enough to
   * call on a heartbeat from each unlocked client; pairs with the auto-revoke job.
   */
  async touchDevice(userId: number, deviceId: string) {
    const dev = await this.devices.findOne({ where: { id: deviceId, userId } });
    if (!dev) throw new NotFoundException("device not found");
    dev.lastSeenAt = new Date();
    await this.devices.save(dev);
    return { ok: true, lastSeenAt: dev.lastSeenAt.toISOString() };
  }

  async approveDevice(userId: number, deviceId: string, dto: ApproveDeviceDto) {
    const dev = await this.devices.findOne({ where: { id: deviceId, userId } });
    if (!dev) throw new NotFoundException("device not found");
    // LOW-C (audit): require an active membership in EVERY vault for which the user is
    // wrapping a VK. The server can't decrypt the wrap (it's E2E), but accepting a grant
    // for a vault the user isn't a member of would let a malicious session add their
    // device as a "viewer of vault X" without ever joining vault X — bypassing the
    // membership table that every other authorization decision keys on.
    //
    // `requireRole(..., "viewer")` is the lowest tier: every active member can issue
    // grants for their own additional devices (the same right they exercise during
    // their own enroll). If a future ACL change tightens this to "self-grant only when
    // role >= editor", flipping the floor here is the one place to change.
    for (const g of dto.grants) {
      await this.requireRole(g.vaultId, userId, "viewer");
    }
    for (const g of dto.grants) {
      await this.grants.save(
        this.grants.create({ vaultId: g.vaultId, keyVersion: g.keyVersion, granteeDeviceId: dev.id, wrappedVaultKey: g.wrappedVaultKey, wrappedByUserId: userId }),
      );
    }
    dev.approved = true;
    await this.devices.save(dev);
    await this.writeAudit(null, userId, "device_approved", dev.id);
    return { ok: true };
  }

  async getDeviceKeyset(userId: number, deviceId: string) {
    const dev = await this.devices.findOne({ where: { id: deviceId, userId } });
    if (!dev || !dev.approved) throw new NotFoundException("device not approved");
    const grants = await this.grants.find({ where: { granteeDeviceId: deviceId } });
    return grants.map((g) => ({ vaultId: g.vaultId, keyVersion: g.keyVersion, wrappedVaultKey: g.wrappedVaultKey }));
  }

  async revokeDevice(userId: number, deviceId: string) {
    const dev = await this.devices.findOne({ where: { id: deviceId, userId } });
    if (!dev) throw new NotFoundException("device not found");
    await this.grants.delete({ granteeDeviceId: deviceId });
    await this.devices.delete({ id: deviceId });
    await this.writeAudit(null, userId, "device_revoked", deviceId);
    return { ok: true };
  }

  /**
   * Scan every approved-but-untrusted device whose `lastSeenAt` is older than
   * `inactiveBeforeMs` (or whose `lastSeenAt` is null and `createdAt` is older). Revoke
   * each one and write a distinct `device_auto_revoked` audit entry so the operator can
   * tell apart "user intentionally retired this device" from "device went inactive".
   *
   * Trusted devices are exempt from auto-revoke — that's what `trusted: true` is for.
   * Pending (`approved: false`) devices are also skipped; they have their own TTL story
   * (operator-defined cleanup), and revoking them confuses the approval flow.
   *
   * Returns the IDs of devices that were revoked, so the caller (the schedule loop, or
   * an admin-triggered run) can log + assert in tests.
   */
  async autoRevokeStaleDevices(inactiveBeforeMs: number): Promise<{ revokedIds: string[] }> {
    const cutoff = new Date(Date.now() - inactiveBeforeMs);
    const candidates = await this.devices.find({ where: { approved: true } });
    const stale = candidates.filter((d) => !d.trusted && referenceAt(d) < cutoff);
    if (stale.length === 0) return { revokedIds: [] };
    const ids = stale.map((d) => d.id);
    await this.grants.delete({ granteeDeviceId: In(ids) });
    await this.devices.delete({ id: In(ids) });
    for (const d of stale) {
      await this.writeAudit(null, d.userId, "device_auto_revoked", d.id);
    }
    return { revokedIds: ids };
  }

  // --- attachments -------------------------------------------------------------

  /**
   * Upload an encrypted attachment. The body's `ciphertextB64` is an opaque envelope the
   * client already encrypted under a one-shot attachment key (wrapped to the vault key in
   * `wrappedKey`). The server decodes only to validate size + persist the bytes — it never
   * sees plaintext.
   */
  async uploadAttachment(userId: number, vaultId: string, itemId: string, dto: UploadAttachmentDto) {
    await this.requireRole(vaultId, userId, "editor");
    const item = await this.items.findOne({ where: { id: itemId, vaultId } });
    if (!item) throw new NotFoundException("item not found");

    const bytes = Buffer.from(dto.ciphertextB64, "base64");
    if (bytes.length === 0) throw new PayloadTooLargeException("ciphertextB64 is empty");
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new PayloadTooLargeException(
        `attachment ciphertext is ${bytes.length} bytes; max is ${MAX_ATTACHMENT_BYTES}`,
      );
    }

    const blobKey = newAttachmentKey(vaultId);
    await this.blobs.put(blobKey, bytes);

    let row: VaultAttachmentEntity;
    try {
      row = await this.attachments.save(
        this.attachments.create({
          vaultId,
          itemId,
          blobKey,
          sizeBytes: bytes.length,
          wrappedKey: dto.wrappedKey,
          encMetadata: dto.encMetadata,
          vaultKeyVersion: dto.vaultKeyVersion,
          authorUserId: userId,
        }),
      );
    } catch (err) {
      // Don't leave an orphaned blob if the metadata insert fails.
      await this.blobs.delete(blobKey).catch(() => undefined);
      throw err;
    }

    await this.writeAudit(vaultId, userId, "attachment_added", row.id);
    return { id: row.id, sizeBytes: row.sizeBytes };
  }

  /** List attachment metadata for an item (no ciphertext bytes — those need a separate GET). */
  async listAttachments(userId: number, vaultId: string, itemId: string) {
    await this.requireRole(vaultId, userId, "viewer");
    const rows = await this.attachments.find({ where: { vaultId, itemId }, order: { createdAt: "ASC" } });
    return rows.map((r) => ({
      id: r.id,
      sizeBytes: r.sizeBytes,
      wrappedKey: r.wrappedKey,
      encMetadata: r.encMetadata,
      vaultKeyVersion: r.vaultKeyVersion,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Download the attachment ciphertext (base64). The server never decrypts; the client opens
   * the envelope with the unwrapped attachment key.
   */
  async downloadAttachment(userId: number, vaultId: string, itemId: string, attachmentId: string) {
    await this.requireRole(vaultId, userId, "viewer");
    const row = await this.attachments.findOne({ where: { id: attachmentId, vaultId, itemId } });
    if (!row) throw new NotFoundException("attachment not found");
    let bytes: Buffer;
    try {
      bytes = await this.blobs.get(row.blobKey);
    } catch (err) {
      if (err instanceof BlobNotFoundError) {
        // Metadata-without-blob is an inconsistent state — surface it loudly rather than
        // silently returning empty.
        throw new NotFoundException("attachment ciphertext missing from blob store");
      }
      throw err;
    }
    return {
      id: row.id,
      sizeBytes: row.sizeBytes,
      wrappedKey: row.wrappedKey,
      encMetadata: row.encMetadata,
      vaultKeyVersion: row.vaultKeyVersion,
      ciphertextB64: bytes.toString("base64"),
    };
  }

  /** Delete the metadata row + its blob. Idempotent at the blob layer. */
  async deleteAttachment(userId: number, vaultId: string, itemId: string, attachmentId: string) {
    await this.requireRole(vaultId, userId, "editor");
    const row = await this.attachments.findOne({ where: { id: attachmentId, vaultId, itemId } });
    if (!row) throw new NotFoundException("attachment not found");
    await this.attachments.delete({ id: row.id });
    await this.blobs.delete(row.blobKey).catch(() => undefined);
    await this.writeAudit(vaultId, userId, "attachment_deleted", row.id);
    return { ok: true };
  }

  // --- item-level shares (ADR-007) -------------------------------------------

  /**
   * Share one item with one user. The granter must be a viewer-or-higher of the source
   * vault — `requireRole("viewer")` *also* enforces "not a member → 404 vault not found",
   * so a non-member can't share something they can't read. The server snapshots the item's
   * *current* ciphertext + versions and persists alongside the granter's pre-computed
   * `pqSeal(IK, recipientHybridPub)` envelope. Server never sees the IK.
   *
   * Unique on `(itemId, granteeUserId)` — re-sharing the same item to the same user is an
   * **upsert** to the newest version, not an error.
   */
  async createItemShare(granterUserId: number, vaultId: string, dto: CreateItemShareDto) {
    await this.requireRole(vaultId, granterUserId, "viewer");
    if (granterUserId === dto.granteeUserId) {
      // Sharing with yourself is a no-op that masks a bug — refuse cleanly rather than
      // creating a row that won't tell you anything new.
      throw new BadRequestException({ error: "cannot_share_with_self" });
    }
    const expiresAt = this.parseShareExpiry(dto.expiresAtMs);
    const recipient = await this.users.findOne({ where: { id: dto.granteeUserId } });
    if (!recipient) throw new NotFoundException("grantee not found");
    const item = await this.items.findOne({ where: { id: dto.itemId, vaultId } });
    if (!item || item.deletedAt) throw new NotFoundException("item not found");

    const existing = await this.itemShares.findOne({
      where: { itemId: dto.itemId, granteeUserId: dto.granteeUserId },
    });
    if (existing) {
      // Upsert: same row, refreshed wrapping + snapshot. Updated-at moves forward.
      // A re-share also clears any pending write-back — it was based on a version the
      // granter has now superseded by re-sharing.
      existing.granterUserId = granterUserId;
      existing.permission = dto.permission ?? "view";
      existing.wrappedIK = dto.wrappedIK;
      existing.ciphertext = item.ciphertext;
      existing.vaultKeyVersion = item.vaultKeyVersion;
      existing.itemVersion = item.version;
      existing.itemType = item.type;
      existing.expiresAt = expiresAt;
      this.clearPendingFields(existing);
      await this.itemShares.save(existing);
      await this.writeAudit(vaultId, granterUserId, "item_shared", existing.id);
      return this.toWireShare(existing);
    }
    const row = await this.itemShares.save(
      this.itemShares.create({
        vaultId,
        itemId: dto.itemId,
        granterUserId,
        granteeUserId: dto.granteeUserId,
        permission: dto.permission ?? "view",
        wrappedIK: dto.wrappedIK,
        ciphertext: item.ciphertext,
        vaultKeyVersion: item.vaultKeyVersion,
        itemVersion: item.version,
        itemType: item.type,
        expiresAt,
      }),
    );
    await this.writeAudit(vaultId, granterUserId, "item_shared", row.id);
    return this.toWireShare(row);
  }

  /**
   * Every share where the caller is the grantee. The whole point — no vault membership
   * required. Expired shares are excluded and lazily hard-deleted: TTL'd shares behave as
   * revoked the moment the clock passes, without needing a background sweeper.
   */
  async listIncomingShares(userId: number) {
    const rows = await this.itemShares.find({
      where: { granteeUserId: userId },
      order: { createdAt: "DESC" },
    });
    const now = Date.now();
    const live = rows.filter((r) => !this.isExpired(r, now));
    const dead = rows.filter((r) => this.isExpired(r, now));
    if (dead.length > 0) {
      // Best-effort cleanup — a failed delete just means the row is filtered again next time.
      await this.itemShares.delete({ id: In(dead.map((r) => r.id)) }).catch(() => undefined);
    }
    return live.map((r) => this.toWireShare(r));
  }

  /** Every share the caller has granted (any vault they have access to). */
  async listOutgoingShares(userId: number) {
    const rows = await this.itemShares.find({
      where: { granterUserId: userId },
      order: { createdAt: "DESC" },
    });
    return rows.map((r) => this.toWireShare(r));
  }

  /** Revoke a share. Either the granter or the grantee can remove it. Idempotent (404 on miss). */
  async revokeItemShare(userId: number, shareId: string) {
    const row = await this.itemShares.findOne({ where: { id: shareId } });
    if (!row) throw new NotFoundException("share not found");
    if (row.granterUserId !== userId && row.granteeUserId !== userId) {
      // Hide existence from third parties (same posture as vault membership 404s).
      throw new NotFoundException("share not found");
    }
    await this.itemShares.delete({ id: shareId });
    await this.writeAudit(row.vaultId, userId, "item_share_revoked", shareId);
    return { ok: true };
  }

  /**
   * Grantee proposes a new version of an edit-share (ADR-007 extension). Requirements:
   * the caller IS the grantee (404-hide otherwise), the share grants `edit`, the share
   * hasn't expired, and `baseItemVersion` matches the source item's *current* version
   * (optimistic concurrency — 409 with the current version on mismatch so the grantee
   * can refresh + re-propose). The proposal parks on the share row; the source item is
   * untouched until the granter applies it through the normal member write path.
   */
  async writeBackItemShare(userId: number, shareId: string, dto: ItemShareWriteBackDto) {
    const row = await this.itemShares.findOne({ where: { id: shareId } });
    if (!row || row.granteeUserId !== userId) throw new NotFoundException("share not found");
    if (row.permission !== "edit") {
      throw new ForbiddenException({ error: "share_not_editable" });
    }
    if (this.isExpired(row, Date.now())) {
      // Expired = revoked. Same hide-don't-explain posture as a deleted share.
      await this.itemShares.delete({ id: row.id }).catch(() => undefined);
      throw new NotFoundException("share not found");
    }
    const item = await this.items.findOne({ where: { id: row.itemId, vaultId: row.vaultId } });
    if (!item || item.deletedAt) throw new NotFoundException("item not found");
    if (dto.baseItemVersion !== item.version) {
      throw new ConflictException({ error: "version_conflict", currentVersion: item.version });
    }

    row.pendingCiphertext = dto.ciphertext;
    row.pendingWrappedIK = dto.wrappedIKForGranter;
    row.pendingBaseVersion = dto.baseItemVersion;
    row.pendingKeyVersion = item.vaultKeyVersion;
    row.pendingAt = new Date();
    await this.itemShares.save(row);
    await this.writeAudit(row.vaultId, userId, "item_share_writeback", row.id);
    return this.toWireShare(row);
  }

  /**
   * Granter clears a pending write-back — after applying it via the normal item-update
   * path, or to reject it outright. Granter-only (404-hide for everyone else, including
   * the grantee: the grantee's lever is submitting a new proposal, not retracting).
   */
  async clearItemSharePending(userId: number, shareId: string) {
    const row = await this.itemShares.findOne({ where: { id: shareId } });
    if (!row || row.granterUserId !== userId) throw new NotFoundException("share not found");
    if (row.pendingAt === null) {
      // Nothing pending — idempotent success keeps granter retry loops simple.
      return { ok: true };
    }
    this.clearPendingFields(row);
    await this.itemShares.save(row);
    await this.writeAudit(row.vaultId, userId, "item_share_writeback_cleared", row.id);
    return { ok: true };
  }

  private clearPendingFields(row: VaultItemShareEntity): void {
    row.pendingCiphertext = null;
    row.pendingWrappedIK = null;
    row.pendingBaseVersion = null;
    row.pendingKeyVersion = null;
    row.pendingAt = null;
  }

  private isExpired(r: VaultItemShareEntity, nowMs: number): boolean {
    return r.expiresAt !== null && new Date(r.expiresAt).getTime() <= nowMs;
  }

  private parseShareExpiry(expiresAtMs: number | undefined): Date | null {
    if (expiresAtMs === undefined) return null;
    if (expiresAtMs <= Date.now()) {
      throw new BadRequestException({ error: "expiry_in_past" });
    }
    return new Date(expiresAtMs);
  }

  private toWireShare(r: VaultItemShareEntity) {
    return {
      id: r.id,
      vaultId: r.vaultId,
      itemId: r.itemId,
      granterUserId: r.granterUserId,
      granteeUserId: r.granteeUserId,
      permission: r.permission,
      wrappedIK: r.wrappedIK,
      ciphertext: r.ciphertext,
      vaultKeyVersion: r.vaultKeyVersion,
      itemVersion: r.itemVersion,
      itemType: r.itemType,
      expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
      // Pending write-back (ADR-007 extension). Present on both granter + grantee wire
      // views — the grantee authored it, the granter consumes it; hiding it from either
      // would only complicate the serializer for zero secrecy gain.
      pending: r.pendingAt
        ? {
            ciphertext: r.pendingCiphertext,
            wrappedIKForGranter: r.pendingWrappedIK,
            baseVersion: r.pendingBaseVersion,
            keyVersion: r.pendingKeyVersion,
            at: new Date(r.pendingAt).toISOString(),
          }
        : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  // --- helpers ---

  private async requireRole(vaultId: string, userId: number, min: MemberRole): Promise<VaultMembershipEntity> {
    const m = await this.memberships.findOne({ where: { vaultId, userId, status: "active" } });
    if (!m) throw new NotFoundException("vault not found"); // hide existence from non-members
    if (ROLE_RANK[m.role] < ROLE_RANK[min]) {
      throw new ForbiddenException({ error: "forbidden", requiredRole: min });
    }
    return m;
  }

  private toWireItem(i: VaultItemEntity) {
    return {
      id: i.id,
      ciphertext: i.ciphertext,
      wrappedItemKey: i.wrappedItemKey,
      vaultKeyVersion: i.vaultKeyVersion,
      version: i.version,
      seq: i.seq,
      type: i.type,
      folderId: i.folderId,
      signature: i.signature,
      deletedAt: i.deletedAt,
      updatedAt: i.updatedAt,
    };
  }

  private async writeAudit(vaultId: string | null, actorUserId: number | null, action: string, targetId: string | null) {
    await this.audit.save(this.audit.create({ vaultId, actorUserId, action, targetId }));
  }

  /**
   * Vault-scoped audit log. Requires viewer-or-higher membership on the vault. Returns
   * the newest events first, bounded by `limit` (1-200, default 50) and optionally
   * paginated with the `before` ISO timestamp from the prior page's last entry.
   */
  async listAudit(
    userId: number,
    vaultId: string,
    opts: { limit?: number; before?: string } = {},
  ) {
    await this.requireRole(vaultId, userId, "viewer");
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const qb = this.audit
      .createQueryBuilder("a")
      .where("a.vaultId = :vaultId", { vaultId })
      .orderBy("a.createdAt", "DESC")
      .limit(limit);
    if (opts.before) qb.andWhere("a.createdAt < :before", { before: opts.before });
    const rows = await qb.getMany();
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorUserId: r.actorUserId,
      targetId: r.targetId,
      ts: r.createdAt.toISOString(),
    }));
  }
}

/**
 * The "is this device inactive?" reference timestamp. Devices that have been seen at least
 * once (the SDK calls /vault/devices/me/touch on unlock + periodically) use `lastSeenAt`;
 * devices that were enrolled but never touched fall back to `createdAt` so they don't
 * become immortal just because no client ever heart-beat them.
 */
function referenceAt(d: VaultDeviceEntity): Date {
  return d.lastSeenAt ?? d.createdAt;
}
