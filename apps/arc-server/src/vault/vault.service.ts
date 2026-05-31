import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, MoreThan, Repository } from "typeorm";
import { ctEqual, fingerprint, fromB64u, randomBytes, serverHashAuth, toB64u } from "@arc/crypto";
import {
  type MemberRole,
  VaultAuditLogEntity,
  VaultDeviceEntity,
  VaultEntity,
  VaultFolderEntity,
  VaultHeadEntity,
  VaultItemEntity,
  VaultKeyGrantEntity,
  VaultMembershipEntity,
  VaultUserKeysEntity,
} from "../database/entities";
import type {
  AddMemberDto,
  ApproveDeviceDto,
  CreateFolderDto,
  CreateVaultDto,
  EnrollDto,
  PutHeadDto,
  RegisterDeviceDto,
  RotateKeyDto,
  UpsertItemDto,
} from "./dto";

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
    @InjectRepository(VaultUserKeysEntity) private readonly userKeys: Repository<VaultUserKeysEntity>,
    @InjectRepository(VaultEntity) private readonly vaults: Repository<VaultEntity>,
    @InjectRepository(VaultMembershipEntity) private readonly memberships: Repository<VaultMembershipEntity>,
    @InjectRepository(VaultKeyGrantEntity) private readonly grants: Repository<VaultKeyGrantEntity>,
    @InjectRepository(VaultItemEntity) private readonly items: Repository<VaultItemEntity>,
    @InjectRepository(VaultDeviceEntity) private readonly devices: Repository<VaultDeviceEntity>,
    @InjectRepository(VaultHeadEntity) private readonly heads: Repository<VaultHeadEntity>,
    @InjectRepository(VaultAuditLogEntity) private readonly audit: Repository<VaultAuditLogEntity>,
    @InjectRepository(VaultFolderEntity) private readonly folders: Repository<VaultFolderEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

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
        signingPublicKey: dto.signingPublicKey,
        identitySelfAttestation: dto.identitySelfAttestation,
        encIdentityPriv: dto.encIdentityPriv,
        encSigningPriv: dto.encSigningPriv,
        encIdentityPrivRecovery: dto.encIdentityPrivRecovery,
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
      signingPublicKey: k.signingPublicKey,
      encIdentityPriv: k.encIdentityPriv,
      encSigningPriv: k.encSigningPriv,
      encIdentityPrivRecovery: k.encIdentityPrivRecovery,
      keyVersion: k.keyVersion,
    };
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
        currentKeyVersion: v.currentKeyVersion,
        role: m.role,
        grant: grant?.wrappedVaultKey ?? null,
      });
    }
    return out;
  }

  async createVault(userId: number, dto: CreateVaultDto) {
    const vault = await this.vaults.save(
      this.vaults.create({ type: dto.type, ownerUserId: userId, encName: dto.encName ?? null, currentKeyVersion: 1, seqCounter: 0 }),
    );
    await this.memberships.save(
      this.memberships.create({ vaultId: vault.id, userId, role: "owner", status: "active", addedByUserId: userId }),
    );
    await this.grants.save(
      this.grants.create({ vaultId: vault.id, keyVersion: 1, granteeUserId: userId, wrappedVaultKey: dto.ownerGrant, wrappedByUserId: userId }),
    );
    await this.writeAudit(vault.id, userId, "vault_created", vault.id);
    return { id: vault.id, currentKeyVersion: vault.currentKeyVersion };
  }

  async listMembers(userId: number, vaultId: string) {
    await this.requireRole(vaultId, userId, "viewer");
    const mems = await this.memberships.find({ where: { vaultId } });
    return mems.map((m) => ({ userId: m.userId, role: m.role, status: m.status }));
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
      signingPublicKey: k.signingPublicKey,
      identitySelfAttestation: k.identitySelfAttestation,
      fingerprint: fingerprint(fromB64u(k.identityPublicKey)),
    };
  }

  async registerDevice(userId: number, dto: RegisterDeviceDto) {
    const dev = await this.devices.save(
      this.devices.create({ userId, name: dto.name, publicKey: dto.publicKey, trusted: false, approved: false }),
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
      verificationCode: fingerprint(fromB64u(d.publicKey), 3),
    }));
  }

  async approveDevice(userId: number, deviceId: string, dto: ApproveDeviceDto) {
    const dev = await this.devices.findOne({ where: { id: deviceId, userId } });
    if (!dev) throw new NotFoundException("device not found");
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
}
