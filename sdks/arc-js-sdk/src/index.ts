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
  mlkemPubFromPriv,
  openVaultKeyGrant,
  rewrapItemKey,
  seal,
  sealOpen,
  toB64u,
  unlock as cryptoUnlock,
  unwrapIdentityFromPasskey,
  unwrapIdentityMlkemFromPasskey,
  unwrapSigningFromPasskey,
  wrapIdentityForPasskey,
  wrapIdentityMlkemForPasskey,
  wrapSigningForPasskey,
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
  identityPrivMlkem: Uint8Array;
  identityPubMlkem: Uint8Array;
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

export interface AuditEvent {
  id: string;
  action: string;
  actorUserId: number | null;
  targetId: string | null;
  /** ISO 8601 server timestamp. */
  ts: string;
}

// -- Passkey unlock types ---------------------------------------------------------------

export interface PasskeySummary {
  id: string;
  credentialId: string;
  label: string | null;
  createdAt: string;
}

export interface PasskeyRegistrationOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  attestation?: string;
  authenticatorSelection?: Record<string, unknown>;
  excludeCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  /** Base64url-encoded PRF salt to include in the `extensions.prf.eval.first` of the request. */
  prfSalt: string;
}

export interface PasskeyUnlockOptions {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: string;
  allowCredentials?: Array<{ id: string; type: "public-key"; transports?: string[] }>;
  prfSalt: string;
}

/** Body the SDK sends to `POST /vault/passkey/register`. */
export interface PasskeyRegisterRequest {
  registration: Record<string, unknown>;
  encIdentityPrivPasskey: Envelope;
  encIdentityPrivMlkemPasskey: Envelope;
  encSigningPrivPasskey: Envelope;
  label?: string;
}

/** What the SDK hands back to `registerPasskey`'s authenticator adapter. */
export interface AuthenticatorAttestation {
  /** The WebAuthn attestation response, JSON-shaped per `@simplewebauthn/types`. */
  attestation: unknown;
  /** PRF first-eval output (32 bytes). Required — passkey unlock cannot work without PRF. */
  prfOutput?: Uint8Array;
}

export interface AuthenticatorAssertion {
  /** The WebAuthn assertion response, JSON-shaped per `@simplewebauthn/types`. */
  assertion: unknown;
  prfOutput?: Uint8Array;
}

/**
 * Adapter the SDK calls to drive `navigator.credentials.create/get`. Injectable so Node
 * tests can stub it; the default {@link browserPasskeyAuthenticator} delegates to the
 * browser platform when invoked in a window context.
 */
export interface PasskeyAuthenticator {
  create(
    opts: PasskeyRegistrationOptions & { prfFirst: Uint8Array },
  ): Promise<AuthenticatorAttestation>;
  get(opts: PasskeyUnlockOptions & { prfFirst: Uint8Array }): Promise<AuthenticatorAssertion>;
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

  /**
   * Machine/service-account mode: provide the hybrid identity (X25519 + ML-KEM-768) and
   * optionally the signing private key. Both identity privs are required so the client can
   * open hybrid-wrapped grants (ADR-002).
   */
  setIdentity(
    identity: { identityPrivB64: string; identityPrivMlkemB64: string },
    signingPrivB64?: string,
  ): void {
    const identityPriv = fromB64u(identity.identityPrivB64);
    const identityPrivMlkem = fromB64u(identity.identityPrivMlkemB64);
    this.session = {
      identityPriv,
      identityPub: x25519PubFromPriv(identityPriv),
      identityPrivMlkem,
      identityPubMlkem: mlkemPubFromPriv(identityPrivMlkem),
      signingPriv: signingPrivB64 ? fromB64u(signingPrivB64) : undefined,
      signingPub: signingPrivB64 ? edPubFromPriv(fromB64u(signingPrivB64)) : undefined,
    };
    this.vkCache.clear();
  }

  get identityPublicKeyB64(): string | undefined {
    return this.session ? toB64u(this.session.identityPub) : undefined;
  }

  get identityPublicKeyMlkemB64(): string | undefined {
    return this.session ? toB64u(this.session.identityPubMlkem) : undefined;
  }

  private hybridPub(): { x25519Pub: Uint8Array; mlkemPub: Uint8Array } {
    if (!this.session) throw new Error("not unlocked");
    return { x25519Pub: this.session.identityPub, mlkemPub: this.session.identityPubMlkem };
  }

  private hybridPriv(): { x25519Priv: Uint8Array; mlkemPriv: Uint8Array } {
    if (!this.session) throw new Error("not unlocked");
    return { x25519Priv: this.session.identityPriv, mlkemPriv: this.session.identityPrivMlkem };
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
    const ownerGrant = wrapVaultKeyFor(e.personalVaultKey.vk, {
      x25519Pub: e.session.identityPub,
      mlkemPub: e.session.identityPubMlkem,
    });
    await this.http("POST", "/vault/enroll", {
      saltMk: e.keyset.saltMk,
      saltAuth: e.keyset.saltAuth,
      argonParams: e.keyset.argonParams,
      authHash: e.keyset.authHash,
      identityPublicKey: e.keyset.identityPublicKey,
      identityPublicKeyMlkem: e.keyset.identityPublicKeyMlkem,
      signingPublicKey: e.keyset.signingPublicKey,
      identitySelfAttestation: e.keyset.identitySelfAttestation,
      encIdentityPriv: e.keyset.encIdentityPriv,
      encIdentityPrivMlkem: e.keyset.encIdentityPrivMlkem,
      encSigningPriv: e.keyset.encSigningPriv,
      encIdentityPrivRecovery: e.keyset.encIdentityPrivRecovery,
      encIdentityPrivMlkemRecovery: e.keyset.encIdentityPrivMlkemRecovery,
      ownerGrant,
    });
    this.session = {
      identityPriv: e.session.identityPriv,
      identityPub: e.session.identityPub,
      identityPrivMlkem: e.session.identityPrivMlkem,
      identityPubMlkem: e.session.identityPubMlkem,
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
      identityPrivMlkem: s.identityPrivMlkem,
      identityPubMlkem: s.identityPubMlkem,
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
        const vk = openVaultKeyGrant(v.grant, this.hybridPriv());
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
    const ownerGrant = wrapVaultKeyFor(vkm.vk, this.hybridPub());
    const encName = name ? encryptVaultName(vkm.vk, name, 1) : undefined;
    const r = await this.http<{ id: string; currentKeyVersion: number }>("POST", "/vaults", {
      type,
      ownerGrant,
      ...(encName ? { encName } : {}),
    });
    this.vkCache.set(r.id, { vk: vkm.vk, keyVersion: r.currentKeyVersion });
    return { id: r.id, keyVersion: r.currentKeyVersion };
  }

  /**
   * Server-side metadata audit log for a vault. Newest-first. The server enforces
   * viewer-or-higher membership and the metadata-only invariant (docs/11) — no
   * ciphertext or key material is ever included.
   */
  async listAudit(
    vaultId: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<AuditEvent[]> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.before !== undefined) params.set("before", opts.before);
    const qs = params.toString();
    return this.http("GET", `/vaults/${vaultId}/audit${qs ? `?${qs}` : ""}`);
  }

  async listMembers(vaultId: string): Promise<VaultMember[]> {
    return this.http("GET", `/vaults/${vaultId}/members`);
  }

  async getUserIdentityKey(userId: number): Promise<{
    userId: number;
    identityPublicKey: string;
    identityPublicKeyMlkem: string;
    signingPublicKey: string;
    fingerprint: string;
  }> {
    return this.http("GET", `/vault/users/${userId}/identity-key`);
  }

  /** Grant a member access by wrapping the vault's VK to their hybrid identity (ADR-002). */
  async addMember(
    vaultId: string,
    userId: number,
    role: string,
    recipient: { identityPubB64: string; identityPubMlkemB64: string },
  ): Promise<void> {
    const vk = this.requireVk(vaultId);
    await this.http("POST", `/vaults/${vaultId}/members`, {
      userId,
      role,
      keyVersion: vk.keyVersion,
      wrappedVaultKey: wrapVaultKeyFor(vk.vk, {
        x25519Pub: fromB64u(recipient.identityPubB64),
        mlkemPub: fromB64u(recipient.identityPubMlkemB64),
      }),
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
    remainingMembers: Array<{
      userId: number;
      identityPubB64: string;
      identityPubMlkemB64: string;
    }>,
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
      wrappedVaultKey: wrapVaultKeyFor(newVk, {
        x25519Pub: fromB64u(m.identityPubB64),
        mlkemPub: fromB64u(m.identityPubMlkemB64),
      }),
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
      members.map(async (m) => {
        const k = await this.getUserIdentityKey(m.userId);
        return {
          userId: m.userId,
          identityPubB64: k.identityPublicKey,
          identityPubMlkemB64: k.identityPublicKeyMlkem,
        };
      }),
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

  /**
   * Trusted device: wrap every cached VK to the new device's public key and approve it.
   * Devices use the classical X25519 `seal` envelope (ADR-002 Phase 4 will add hybrid
   * device keys once the Rust core ships ML-KEM).
   */
  async approveDevice(deviceId: string, devicePublicKeyB64: string): Promise<void> {
    const devicePub = fromB64u(devicePublicKeyB64);
    const grants = [...this.vkCache.entries()].map(([vaultId, { vk, keyVersion }]) => ({
      vaultId,
      keyVersion,
      wrappedVaultKey: seal(devicePub, vk),
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

  // --- Passkey unlock (docs/13) ---

  /**
   * Register a passkey credential as an additive unlock path. Wraps all three identity
   * privs (X25519 + ML-KEM-768 + Ed25519 signing) under a PRF-derived KEK so a later
   * passkey unlock produces a *full-capability* session — decrypt VKs + sign vault heads.
   * Requires the vault to be unlocked first (the wrap inputs come from the current
   * session) so this is run from the user's "Add a passkey" flow after a master-password
   * unlock.
   *
   * `authenticator` is an injectable adapter around `navigator.credentials`. The default
   * (in a browser) delegates to the platform; tests pass a fake that returns canned
   * registration responses + PRF outputs.
   */
  async registerPasskey(
    authenticator: PasskeyAuthenticator,
    label?: string,
  ): Promise<{ credentialId: string }> {
    if (!this.session) throw new Error("not unlocked: call enroll/unlock first");
    if (!this.session.signingPriv) {
      throw new Error("passkey register requires a signing priv in the session");
    }
    const opts = await this.http<PasskeyRegistrationOptions>(
      "POST",
      "/vault/passkey/register-challenge",
    );
    const registered = await authenticator.create({
      ...opts,
      prfFirst: fromB64u(opts.prfSalt),
    });
    if (!registered.prfOutput) {
      throw new Error(
        "authenticator did not return a PRF output; passkey unlock requires PRF support",
      );
    }
    const prf = registered.prfOutput;
    const body: PasskeyRegisterRequest = {
      registration: registered.attestation as unknown as Record<string, unknown>,
      encIdentityPrivPasskey: wrapIdentityForPasskey(this.session.identityPriv, prf),
      encIdentityPrivMlkemPasskey: wrapIdentityMlkemForPasskey(this.session.identityPrivMlkem, prf),
      encSigningPrivPasskey: wrapSigningForPasskey(this.session.signingPriv, prf),
    };
    if (label !== undefined) body.label = label;
    return this.http<{ credentialId: string }>("POST", "/vault/passkey/register", body);
  }

  /**
   * Unlock the vault using a previously-registered passkey. The PRF output never leaves
   * the client; the server returns the wrapped envelopes which we unwrap locally to
   * populate the in-memory session. Same zero-knowledge posture as master-password
   * unlock.
   *
   * Throws if the user has no passkeys registered, the authenticator can't produce a PRF
   * output, or the wrapping AAD doesn't match (corrupted authenticator / cross-user
   * replay).
   */
  async unlockWithPasskey(authenticator: PasskeyAuthenticator): Promise<void> {
    const ks = await this.http<Keyset>("GET", "/vault/keyset");
    const opts = await this.http<PasskeyUnlockOptions>(
      "POST",
      "/vault/passkey/unlock-challenge",
    );
    const assertion = await authenticator.get({
      ...opts,
      prfFirst: fromB64u(opts.prfSalt),
    });
    if (!assertion.prfOutput) {
      throw new Error(
        "authenticator did not return a PRF output; passkey unlock requires PRF support",
      );
    }
    const prf = assertion.prfOutput;
    const wrapped = await this.http<{
      encIdentityPrivPasskey: Envelope;
      encIdentityPrivMlkemPasskey: Envelope;
      encSigningPrivPasskey: Envelope;
      credentialId: string;
    }>("POST", "/vault/passkey/unlock", {
      assertion: assertion.assertion as unknown as Record<string, unknown>,
    });
    const identityPriv = unwrapIdentityFromPasskey(wrapped.encIdentityPrivPasskey, prf);
    const identityPrivMlkem = unwrapIdentityMlkemFromPasskey(
      wrapped.encIdentityPrivMlkemPasskey,
      prf,
    );
    const signingPriv = unwrapSigningFromPasskey(wrapped.encSigningPrivPasskey, prf);
    // Public keys come from the unencrypted keyset endpoint — no need to recompute.
    this.session = {
      identityPriv,
      identityPub: fromB64u(ks.identityPublicKey),
      identityPrivMlkem,
      identityPubMlkem: fromB64u(ks.identityPublicKeyMlkem),
      signingPriv,
      signingPub: fromB64u(ks.signingPublicKey),
    };
    this.vkCache.clear();
  }

  /** List passkey credentials registered for the current account. */
  listPasskeys(): Promise<PasskeySummary[]> {
    return this.http<PasskeySummary[]>("GET", "/vault/passkeys");
  }

  /** Remove a registered passkey by its arc-internal id (the uuid from listPasskeys). */
  async removePasskey(id: string): Promise<void> {
    await this.http("DELETE", `/vault/passkeys/${encodeURIComponent(id)}`);
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

// --- Browser-default passkey authenticator -------------------------------------------

/**
 * Default {@link PasskeyAuthenticator} for browser environments. Drives
 * `navigator.credentials.create/get` directly, including the PRF extension that
 * `wrapIdentityForPasskey` depends on.
 *
 * In Node / test environments this throws on construction — callers there should pass a
 * fake authenticator instead. Keeping the default in-SDK means web callers can just do
 * `client.registerPasskey(browserPasskeyAuthenticator())` without thinking about it.
 */
export function browserPasskeyAuthenticator(): PasskeyAuthenticator {
  const creds = (globalThis as unknown as { navigator?: { credentials?: CredentialsContainerLike } })
    .navigator?.credentials;
  if (!creds) {
    throw new Error(
      "browserPasskeyAuthenticator requires `navigator.credentials` — only valid in a browser",
    );
  }
  return {
    async create(opts) {
      const credential = (await creds.create({
        publicKey: {
          challenge: b64urlToBytes(opts.challenge).buffer,
          rp: opts.rp,
          user: {
            id: new TextEncoder().encode(opts.user.id).buffer,
            name: opts.user.name,
            displayName: opts.user.displayName,
          },
          pubKeyCredParams: opts.pubKeyCredParams,
          timeout: opts.timeout,
          attestation: opts.attestation as AttestationConveyancePreference | undefined,
          authenticatorSelection: opts.authenticatorSelection,
          excludeCredentials: opts.excludeCredentials?.map((c) => ({
            id: b64urlToBytes(c.id).buffer,
            type: c.type,
            transports: c.transports as AuthenticatorTransport[] | undefined,
          })),
          extensions: { prf: { eval: { first: opts.prfFirst.buffer } } } as unknown as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredentialLike | null;
      if (!credential) throw new Error("passkey creation cancelled");
      const ext = credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
      return {
        attestation: serializeRegistrationResponse(credential),
        prfOutput: ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : undefined,
      };
    },
    async get(opts) {
      const credential = (await creds.get({
        publicKey: {
          challenge: b64urlToBytes(opts.challenge).buffer,
          rpId: opts.rpId,
          timeout: opts.timeout,
          userVerification: opts.userVerification as UserVerificationRequirement | undefined,
          allowCredentials: opts.allowCredentials?.map((c) => ({
            id: b64urlToBytes(c.id).buffer,
            type: c.type,
            transports: c.transports as AuthenticatorTransport[] | undefined,
          })),
          extensions: { prf: { eval: { first: opts.prfFirst.buffer } } } as unknown as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredentialLike | null;
      if (!credential) throw new Error("passkey assertion cancelled");
      const ext = credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
      return {
        assertion: serializeAuthenticationResponse(credential),
        prfOutput: ext.prf?.results?.first ? new Uint8Array(ext.prf.results.first) : undefined,
      };
    },
  };
}

interface CredentialsContainerLike {
  create(o: { publicKey: Record<string, unknown> }): Promise<unknown>;
  get(o: { publicKey: Record<string, unknown> }): Promise<unknown>;
}
interface PublicKeyCredentialLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  response: Record<string, ArrayBuffer | string>;
  getClientExtensionResults(): unknown;
}

function bytesToB64u(b: ArrayBuffer): string {
  return toB64u(new Uint8Array(b));
}
function b64urlToBytes(s: string): Uint8Array {
  return fromB64u(s);
}

function serializeRegistrationResponse(c: PublicKeyCredentialLike): Record<string, unknown> {
  const r = c.response as { attestationObject: ArrayBuffer; clientDataJSON: ArrayBuffer };
  return {
    id: c.id,
    rawId: bytesToB64u(c.rawId),
    type: c.type,
    response: {
      attestationObject: bytesToB64u(r.attestationObject),
      clientDataJSON: bytesToB64u(r.clientDataJSON),
    },
    clientExtensionResults: {},
  };
}

function serializeAuthenticationResponse(c: PublicKeyCredentialLike): Record<string, unknown> {
  const r = c.response as {
    authenticatorData: ArrayBuffer;
    clientDataJSON: ArrayBuffer;
    signature: ArrayBuffer;
    userHandle?: ArrayBuffer;
  };
  const out: Record<string, unknown> = {
    id: c.id,
    rawId: bytesToB64u(c.rawId),
    type: c.type,
    response: {
      authenticatorData: bytesToB64u(r.authenticatorData),
      clientDataJSON: bytesToB64u(r.clientDataJSON),
      signature: bytesToB64u(r.signature),
    },
    clientExtensionResults: {},
  };
  if (r.userHandle) {
    (out.response as Record<string, unknown>).userHandle = bytesToB64u(r.userHandle);
  }
  return out;
}
