import {
  computeAuthHash,
  createVaultKey,
  decryptFolderName,
  decryptItem,
  decryptVaultName,
  edPubFromPriv,
  encryptFolderName,
  encryptItem,
  encryptVaultName,
  enroll as cryptoEnroll,
  type Envelope,
  fingerprint,
  fromB64u,
  generateDeviceKeyPair,
  type JsonValue,
  type Keyset,
  openVaultKeyGrant,
  rewrapItemKey,
  sealOpen,
  toB64u,
  unlock as cryptoUnlock,
  wrapVaultKeyFor,
  x25519PubFromPriv,
} from "@arc/crypto";

export type VaultType = "personal" | "team" | "org";

export interface VaultClientOptions {
  baseUrl: string;
  /** Override fetch (tests / non-global environments). */
  fetchImpl?: typeof fetch;
  /** Argon2id profile for enroll/unlock (default desktop). */
  profile?: "desktop" | "mobile" | "test";
}

export class VaultApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`arc-vault API error ${status}`);
    this.name = "VaultApiError";
  }
}

interface ClientSession {
  identityPriv: Uint8Array;
  identityPub: Uint8Array;
  signingPriv?: Uint8Array;
  signingPub?: Uint8Array;
}

export interface VaultSummary {
  id: string;
  type: string;
  role: string;
  keyVersion: number;
  /** Decrypted vault name, if one was set. */
  name?: string;
}

export interface VaultMember {
  userId: number;
  role: string;
  status: string;
}

export interface PulledItem {
  id: string;
  version: number;
  seq: number;
  deleted: boolean;
  folderId: string | null;
  data: JsonValue | null;
}

export interface VaultFolder {
  id: string;
  name: string;
}

export interface PendingDevice {
  id: string;
  name: string;
  publicKey: string;
  verificationCode: string;
}

/**
 * One client for both personas:
 * - consumer: {@link enroll} / {@link unlock} derive the identity key from a master password.
 * - machine / service account: {@link setIdentity} injects the identity key directly — no
 *   master password, no Argon2id (docs/14 §14.2).
 */
export class VaultClient {
  private token?: string;
  private session?: ClientSession;
  private devicePriv?: Uint8Array;
  private devicePub?: Uint8Array;
  private readonly vkCache = new Map<string, { vk: Uint8Array; keyVersion: number }>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: VaultClientOptions) {
    // Bind to globalThis: native fetch throws "Illegal invocation" if called with a
    // non-global `this` (which happens when stored as an instance property).
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  setToken(token: string): void {
    this.token = token;
  }

  /** Machine/service-account mode: provide the identity (and optionally signing) private key. */
  setIdentity(identityPrivB64: string, signingPrivB64?: string): void {
    const identityPriv = fromB64u(identityPrivB64);
    this.session = {
      identityPriv,
      identityPub: x25519PubFromPriv(identityPriv),
      signingPriv: signingPrivB64 ? fromB64u(signingPrivB64) : undefined,
      signingPub: signingPrivB64 ? edPubFromPriv(fromB64u(signingPrivB64)) : undefined,
    };
    this.vkCache.clear();
  }

  get identityPublicKeyB64(): string | undefined {
    return this.session ? toB64u(this.session.identityPub) : undefined;
  }

  private async http<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(this.opts.baseUrl + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) throw new VaultApiError(res.status, parsed);
    return parsed as T;
  }

  /** Dev-only login (stubs OAuth sync authorization). */
  async devLogin(email: string): Promise<{ userId: number; token: string }> {
    const r = await this.http<{ accessToken: string; userId: number }>("POST", "/auth/dev-login", { email });
    this.token = r.accessToken;
    return { userId: r.userId, token: r.accessToken };
  }

  async enroll(masterPassword: string): Promise<{ recoveryKey: string }> {
    const e = cryptoEnroll(masterPassword, { profile: this.opts.profile });
    const ownerGrant = wrapVaultKeyFor(e.personalVaultKey.vk, e.session.identityPub);
    await this.http("POST", "/vault/enroll", {
      saltMk: e.keyset.saltMk,
      saltAuth: e.keyset.saltAuth,
      argonParams: e.keyset.argonParams,
      authHash: e.keyset.authHash,
      identityPublicKey: e.keyset.identityPublicKey,
      signingPublicKey: e.keyset.signingPublicKey,
      identitySelfAttestation: e.keyset.identitySelfAttestation,
      encIdentityPriv: e.keyset.encIdentityPriv,
      encSigningPriv: e.keyset.encSigningPriv,
      encIdentityPrivRecovery: e.keyset.encIdentityPrivRecovery,
      ownerGrant,
    });
    this.session = {
      identityPriv: e.session.identityPriv,
      identityPub: e.session.identityPub,
      signingPriv: e.session.signingPriv,
      signingPub: e.session.signingPub,
    };
    return { recoveryKey: e.recoveryKey };
  }

  async unlock(masterPassword: string): Promise<void> {
    const ks = await this.http<Keyset>("GET", "/vault/keyset");
    const authHash = computeAuthHash(masterPassword, ks);
    await this.http("POST", "/vault/unlock", { authHash });
    const s = cryptoUnlock(masterPassword, { ...ks, authHash });
    this.session = {
      identityPriv: s.identityPriv,
      identityPub: s.identityPub,
      signingPriv: s.signingPriv,
      signingPub: s.signingPub,
    };
    this.vkCache.clear();
  }

  /** List vaults and unwrap each VK grant into the in-memory cache. */
  async listVaults(): Promise<VaultSummary[]> {
    if (!this.session) throw new Error("not unlocked: call enroll/unlock/setIdentity first");
    const vaults = await this.http<
      Array<{
        id: string;
        type: string;
        role: string;
        currentKeyVersion: number;
        grant: Envelope | null;
        encName: Envelope | null;
      }>
    >("GET", "/vaults");
    const out: VaultSummary[] = [];
    for (const v of vaults) {
      let name: string | undefined;
      if (v.grant) {
        const vk = openVaultKeyGrant(v.grant, this.session.identityPriv);
        this.vkCache.set(v.id, { vk, keyVersion: v.currentKeyVersion });
        if (v.encName) {
          try {
            name = decryptVaultName(vk, v.encName, v.currentKeyVersion);
          } catch {
            name = undefined;
          }
        }
      }
      out.push({ id: v.id, type: v.type, role: v.role, keyVersion: v.currentKeyVersion, name });
    }
    return out;
  }

  async createVault(type: VaultType = "team", name?: string): Promise<{ id: string; keyVersion: number }> {
    if (!this.session) throw new Error("not unlocked");
    const vkm = createVaultKey(1);
    const ownerGrant = wrapVaultKeyFor(vkm.vk, this.session.identityPub);
    const encName = name ? encryptVaultName(vkm.vk, name, 1) : undefined;
    const r = await this.http<{ id: string; currentKeyVersion: number }>("POST", "/vaults", {
      type,
      ownerGrant,
      ...(encName ? { encName } : {}),
    });
    this.vkCache.set(r.id, { vk: vkm.vk, keyVersion: r.currentKeyVersion });
    return { id: r.id, keyVersion: r.currentKeyVersion };
  }

  async listMembers(vaultId: string): Promise<VaultMember[]> {
    return this.http("GET", `/vaults/${vaultId}/members`);
  }

  async getUserIdentityKey(userId: number): Promise<{
    userId: number;
    identityPublicKey: string;
    signingPublicKey: string;
    fingerprint: string;
  }> {
    return this.http("GET", `/vault/users/${userId}/identity-key`);
  }

  /** Grant a member access by wrapping the vault's VK to their identity public key. */
  async addMember(
    vaultId: string,
    userId: number,
    role: string,
    recipientIdentityPubB64: string,
  ): Promise<void> {
    const vk = this.requireVk(vaultId);
    await this.http("POST", `/vaults/${vaultId}/members`, {
      userId,
      role,
      keyVersion: vk.keyVersion,
      wrappedVaultKey: wrapVaultKeyFor(vk.vk, fromB64u(recipientIdentityPubB64)),
    });
  }

  async pull(vaultId: string, since = 0): Promise<{ items: PulledItem[]; cursor: number }> {
    const vk = this.requireVk(vaultId);
    const res = await this.http<{ items: ItemRow[]; cursor: number }>(
      "GET",
      `/vaults/${vaultId}/items?since=${since}`,
    );
    const items = res.items.map((row): PulledItem => {
      if (row.deletedAt) {
        return { id: row.id, version: row.version, seq: row.seq, deleted: true, folderId: row.folderId ?? null, data: null };
      }
      const data = decryptItem(
        vk.vk,
        { vaultId, itemId: row.id, version: row.version, keyVersion: row.vaultKeyVersion },
        { ciphertext: row.ciphertext, wrappedItemKey: row.wrappedItemKey },
      );
      return { id: row.id, version: row.version, seq: row.seq, deleted: false, folderId: row.folderId ?? null, data };
    });
    return { items, cursor: res.cursor };
  }

  async putItem(
    vaultId: string,
    data: JsonValue,
    opts: { id?: string; baseVersion?: number; type?: string; folderId?: string | null } = {},
  ): Promise<{ id: string; version: number; seq: number }> {
    const vk = this.requireVk(vaultId);
    const id = opts.id ?? crypto.randomUUID();
    const version = (opts.baseVersion ?? 0) + 1;
    const enc = encryptItem(vk.vk, { vaultId, itemId: id, version, keyVersion: vk.keyVersion }, data);
    return this.http("POST", `/vaults/${vaultId}/items`, {
      id,
      ciphertext: enc.ciphertext,
      wrappedItemKey: enc.wrappedItemKey,
      vaultKeyVersion: vk.keyVersion,
      ...(opts.baseVersion !== undefined ? { baseVersion: opts.baseVersion } : {}),
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.folderId ? { folderId: opts.folderId } : {}),
    });
  }

  async listFolders(vaultId: string): Promise<VaultFolder[]> {
    const vk = this.requireVk(vaultId);
    const rows = await this.http<Array<{ id: string; encName: Envelope }>>("GET", `/vaults/${vaultId}/folders`);
    return rows.map((f) => {
      let name = f.id;
      try {
        name = decryptFolderName(vk.vk, f.encName, vk.keyVersion);
      } catch {
        /* leave id as fallback */
      }
      return { id: f.id, name };
    });
  }

  async createFolder(vaultId: string, name: string): Promise<{ id: string }> {
    const vk = this.requireVk(vaultId);
    return this.http("POST", `/vaults/${vaultId}/folders`, {
      encName: encryptFolderName(vk.vk, name, vk.keyVersion),
    });
  }

  async deleteFolder(vaultId: string, folderId: string): Promise<{ ok: boolean }> {
    return this.http("DELETE", `/vaults/${vaultId}/folders/${folderId}`);
  }

  async deleteItem(vaultId: string, id: string): Promise<{ ok: boolean }> {
    return this.http("DELETE", `/vaults/${vaultId}/items/${id}`);
  }

  private async rawItems(vaultId: string): Promise<ItemRow[]> {
    const res = await this.http<{ items: ItemRow[]; cursor: number }>(
      "GET",
      `/vaults/${vaultId}/items?since=0`,
    );
    return res.items;
  }

  /**
   * Rotate the vault key for secure member revocation (docs/07 §7.5). Generates a new VK,
   * re-wraps every item's IK to it (payloads untouched), and grants the new VK only to the
   * supplied remaining members. Any member not listed gets no new-version grant and is
   * cryptographically denied future reads.
   */
  async rotateKey(
    vaultId: string,
    remainingMembers: Array<{ userId: number; identityPubB64: string }>,
  ): Promise<{ keyVersion: number }> {
    const current = this.requireVk(vaultId);
    const newKeyVersion = current.keyVersion + 1;
    const newVk = createVaultKey(newKeyVersion).vk;

    const rewrappedItemKeys = (await this.rawItems(vaultId))
      .filter((r) => !r.deletedAt)
      .map((r) => ({
        itemId: r.id,
        wrappedItemKey: rewrapItemKey(
          current.vk,
          newVk,
          { vaultId, itemId: r.id, oldKeyVersion: r.vaultKeyVersion, newKeyVersion },
          r.wrappedItemKey,
        ),
      }));

    const grants = remainingMembers.map((m) => ({
      granteeUserId: m.userId,
      wrappedVaultKey: wrapVaultKeyFor(newVk, fromB64u(m.identityPubB64)),
    }));

    await this.http("POST", `/vaults/${vaultId}/rotate-key`, {
      newKeyVersion,
      grants,
      rewrappedItemKeys,
    });
    this.vkCache.set(vaultId, { vk: newVk, keyVersion: newKeyVersion });
    return { keyVersion: newKeyVersion };
  }

  /**
   * Rotate the VK and re-grant to every current active member (key hygiene / post-incident).
   * To revoke a member instead, pass the trimmed member set to {@link rotateKey}.
   */
  async rotateForAllMembers(vaultId: string): Promise<{ keyVersion: number }> {
    const members = (await this.listMembers(vaultId)).filter((m) => m.status === "active");
    const remaining = await Promise.all(
      members.map(async (m) => ({
        userId: m.userId,
        identityPubB64: (await this.getUserIdentityKey(m.userId)).identityPublicKey,
      })),
    );
    return this.rotateKey(vaultId, remaining);
  }

  // --- multi-device onboarding (docs/06 §6.3) ---

  /** New device: generate a device keypair (kept in memory) and register its public key. */
  async registerDevice(name: string): Promise<{ deviceId: string; verificationCode: string }> {
    const kp = generateDeviceKeyPair();
    this.devicePriv = kp.priv;
    this.devicePub = kp.pub;
    const r = await this.http<{ id: string; approved: boolean }>("POST", "/vault/devices", {
      publicKey: toB64u(kp.pub),
      name,
    });
    return { deviceId: r.id, verificationCode: fingerprint(kp.pub, 3) };
  }

  /** Trusted device: list devices awaiting approval (with their verification codes). */
  async listPendingDevices(): Promise<PendingDevice[]> {
    return this.http("GET", "/vault/devices?pending=true");
  }

  /** Trusted device: wrap every cached VK to the new device's public key and approve it. */
  async approveDevice(deviceId: string, devicePublicKeyB64: string): Promise<void> {
    const devicePub = fromB64u(devicePublicKeyB64);
    const grants = [...this.vkCache.entries()].map(([vaultId, { vk, keyVersion }]) => ({
      vaultId,
      keyVersion,
      wrappedVaultKey: wrapVaultKeyFor(vk, devicePub),
    }));
    await this.http("POST", `/vault/devices/${deviceId}/approve`, { grants });
  }

  /** New device: fetch and open this device's VK grants with the device private key. */
  async loadDeviceGrants(deviceId: string): Promise<Array<{ id: string; keyVersion: number }>> {
    if (!this.devicePriv) throw new Error("no device key; call registerDevice first");
    const grants = await this.http<
      Array<{ vaultId: string; keyVersion: number; wrappedVaultKey: Envelope }>
    >("GET", `/vault/devices/me/keyset?deviceId=${deviceId}`);
    const out: Array<{ id: string; keyVersion: number }> = [];
    for (const g of grants) {
      this.vkCache.set(g.vaultId, {
        vk: sealOpen(this.devicePriv, g.wrappedVaultKey),
        keyVersion: g.keyVersion,
      });
      out.push({ id: g.vaultId, keyVersion: g.keyVersion });
    }
    return out;
  }

  /** New device: list the vaults this device can decrypt (names via the device VK). */
  async listDeviceVaults(): Promise<VaultSummary[]> {
    const vaults = await this.http<
      Array<{ id: string; type: string; role: string; currentKeyVersion: number; encName: Envelope | null }>
    >("GET", "/vaults");
    const out: VaultSummary[] = [];
    for (const v of vaults) {
      const cached = this.vkCache.get(v.id);
      if (!cached) continue;
      let name: string | undefined;
      if (v.encName) {
        try {
          name = decryptVaultName(cached.vk, v.encName, v.currentKeyVersion);
        } catch {
          name = undefined;
        }
      }
      out.push({ id: v.id, type: v.type, role: v.role, keyVersion: v.currentKeyVersion, name });
    }
    return out;
  }

  private requireVk(vaultId: string): { vk: Uint8Array; keyVersion: number } {
    const vk = this.vkCache.get(vaultId);
    if (!vk) throw new Error(`no VK cached for vault ${vaultId}; call listVaults() first`);
    return vk;
  }
}

interface ItemRow {
  id: string;
  version: number;
  seq: number;
  vaultKeyVersion: number;
  ciphertext: Envelope;
  wrappedItemKey: Envelope;
  folderId: string | null;
  deletedAt: string | null;
}
