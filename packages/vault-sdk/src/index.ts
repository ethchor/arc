import {
  computeAuthHash,
  createVaultKey,
  decryptItem,
  edPubFromPriv,
  encryptItem,
  enroll as cryptoEnroll,
  type Envelope,
  fromB64u,
  type JsonValue,
  type Keyset,
  openVaultKeyGrant,
  toB64u,
  unlock as cryptoUnlock,
  wrapVaultKeyFor,
  x25519PubFromPriv,
} from "@arc-vault/crypto";

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
}

export interface PulledItem {
  id: string;
  version: number;
  seq: number;
  deleted: boolean;
  data: JsonValue | null;
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
  private readonly vkCache = new Map<string, { vk: Uint8Array; keyVersion: number }>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: VaultClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
      Array<{ id: string; type: string; role: string; currentKeyVersion: number; grant: Envelope | null }>
    >("GET", "/vaults");
    const out: VaultSummary[] = [];
    for (const v of vaults) {
      if (v.grant) {
        this.vkCache.set(v.id, {
          vk: openVaultKeyGrant(v.grant, this.session.identityPriv),
          keyVersion: v.currentKeyVersion,
        });
      }
      out.push({ id: v.id, type: v.type, role: v.role, keyVersion: v.currentKeyVersion });
    }
    return out;
  }

  async createVault(type: VaultType = "team"): Promise<{ id: string; keyVersion: number }> {
    if (!this.session) throw new Error("not unlocked");
    const vkm = createVaultKey(1);
    const ownerGrant = wrapVaultKeyFor(vkm.vk, this.session.identityPub);
    const r = await this.http<{ id: string; currentKeyVersion: number }>("POST", "/vaults", { type, ownerGrant });
    this.vkCache.set(r.id, { vk: vkm.vk, keyVersion: r.currentKeyVersion });
    return { id: r.id, keyVersion: r.currentKeyVersion };
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
      if (row.deletedAt) return { id: row.id, version: row.version, seq: row.seq, deleted: true, data: null };
      const data = decryptItem(
        vk.vk,
        { vaultId, itemId: row.id, version: row.version, keyVersion: row.vaultKeyVersion },
        { ciphertext: row.ciphertext, wrappedItemKey: row.wrappedItemKey },
      );
      return { id: row.id, version: row.version, seq: row.seq, deleted: false, data };
    });
    return { items, cursor: res.cursor };
  }

  async putItem(
    vaultId: string,
    data: JsonValue,
    opts: { id?: string; baseVersion?: number; type?: string } = {},
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
    });
  }

  async deleteItem(vaultId: string, id: string): Promise<{ ok: boolean }> {
    return this.http("DELETE", `/vaults/${vaultId}/items/${id}`);
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
  deletedAt: string | null;
}
