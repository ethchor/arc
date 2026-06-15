import {
  computeAuthHash,
  createVaultKey,
  decryptFolderName,
  decryptItem,
  decryptItemWithIK,
  decryptVaultName,
  deviceSas,
  edPubFromPriv,
  encryptFolderName,
  encryptItem,
  encryptVaultName,
  enroll as cryptoEnroll,
  extractItemKey,
  type Envelope,
  fingerprint,
  fromB64u,
  generateHybridDeviceKeyPair,
  generateHybridIdentityKeyPair,
  generateIdentityKeyPair,
  generateSigningKeyPair,
  type JsonValue,
  type Keyset,
  mlkemPubFromPriv,
  openItemKeyShare,
  openVaultKeyGrant,
  pqSeal,
  pqSealOpen,
  randomBytes,
  intentArgsDigest,
  recover as cryptoRecover,
  rewrapItemKey,
  seal,
  sealOpen,
  signDelegation,
  signIntent,
  signObject,
  toB64u,
  unlock as cryptoUnlock,
  unwrapIdentityFromPasskey,
  unwrapIdentityMlkemFromPasskey,
  unwrapSigningFromPasskey,
  wrapIdentityForPasskey,
  wrapIdentityMlkemForPasskey,
  wrapItemKeyForShare,
  encryptShareWriteBack,
  openShareWriteBack,
  wrapSigningForPasskey,
  wrapVaultKeyFor,
  x25519PubFromPriv,
} from "@arc/crypto";

import {
  agentSubject,
  userSubject,
  type AgentIdentity,
  type AgentStatus,
  type AgentTaskBudget,
  type DelegationClaims,
  type DelegationScope,
  type IntentClaims,
} from "@arc/types";

export type VaultType = "personal" | "team" | "org";

/**
 * Re-exports of the closed UI-affordance allowlists from `@arc/types`. Callers building a
 * vault picker can iterate `VAULT_ICONS` / `VAULT_COLORS` to render the options without
 * pulling in `@arc/types` separately.
 */
export {
  VAULT_ICONS,
  VAULT_COLORS,
  type VaultIcon,
  type VaultColor,
  isVaultIcon,
  isVaultColor,
} from "@arc/types";

/** Engine-C (ADR-005) agent identity + delegation wire shapes, re-exported for convenience. */
export {
  agentSubject,
  userSubject,
  type AgentIdentity,
  type AgentStatus,
  type DelegationClaims,
  type DelegationScope,
  type SignedDelegation,
} from "@arc/types";

/**
 * A freshly generated agent keyset. The **private** keys are the agent's own secret
 * material — the caller persists them in the agent's secure storage (they sign intents in
 * Phase 3); only `publicKeys` is sent to the server at registration.
 */
export interface AgentKeyset {
  signing: { priv: Uint8Array; pub: Uint8Array };
  identity: { priv: Uint8Array; pub: Uint8Array };
  identityMlkem: { publicKey: Uint8Array; secretKey: Uint8Array };
  publicKeys: {
    signingPublicKey: string;
    identityPublicKey: string;
    identityPublicKeyMlkem: string;
  };
}

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
  /**
   * Optional UI affordances (`@arc/types` `VaultIcon` / `VaultColor`). Plaintext on the
   * wire — picker chrome, not secret material. `null` when the owner never picked one.
   */
  icon?: string | null;
  color?: string | null;
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

/**
 * Item-level share (ADR-007). The recipient's view of the wire shape: enough to decrypt
 * (`wrappedIK` + `ciphertext` + AAD context) plus metadata for an inbox-style UI.
 */
export interface ItemShare {
  id: string;
  vaultId: string;
  itemId: string;
  granterUserId: number;
  granteeUserId: number;
  permission: "view" | "edit";
  wrappedIK: Envelope;
  ciphertext: Envelope;
  vaultKeyVersion: number;
  itemVersion: number;
  itemType: string | null;
  /** TTL (ISO). Past = the share behaves as revoked. Null = no expiry. */
  expiresAt: string | null;
  /** Pending edit-back proposal from the grantee (ADR-007 extension); null when none. */
  pending: {
    ciphertext: Envelope;
    wrappedIKForGranter: Envelope;
    baseVersion: number;
    keyVersion: number;
    at: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface VaultFolder {
  id: string;
  name: string;
}

export interface PendingDevice {
  id: string;
  name: string;
  publicKey: string;
  /** Optional ML-KEM-768 public key (b64url) — present on ADR-003 hybrid-device enrollments. */
  publicKeyMlkem?: string | null;
  verificationCode: string;
}

/** An already-enrolled device on the calling user's account. Returned by `listDevices()`. */
export interface EnrolledDevice {
  id: string;
  name: string;
  publicKey: string;
  /** Optional ML-KEM-768 public key (b64url). Present on ADR-003 devices; `null` on legacy. */
  publicKeyMlkem?: string | null;
  /** `true` exempts this device from the auto-revoke inactivity policy. */
  trusted: boolean;
  /** ISO 8601 timestamp of the last touch, or null if never seen since enrollment. */
  lastSeenAt: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  actorUserId: number | null;
  targetId: string | null;
  /** ISO 8601 server timestamp. */
  ts: string;
}

/** A configured workflow row. `definition` is the canonical workflow JSON. */
export interface WorkflowRow {
  id: string;
  vaultId: string;
  name: string;
  /** Canonical `WorkflowDefinition` JSON. Cast through `@arc/workflows` to the typed shape. */
  definition: Record<string, unknown>;
  enabled: boolean;
  /** Optimistic-concurrency token. Pass back in `expectedVersion` on update. */
  version: number;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertWorkflowBody {
  name: string;
  definition: Record<string, unknown>;
  enabled?: boolean;
  /** Required on update; ignored on create. */
  expectedVersion?: number;
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
  private userId?: number;
  private session?: ClientSession;
  private devicePriv?: Uint8Array;
  private devicePub?: Uint8Array;
  /** Device ML-KEM-768 secret + public (ADR-003). Set alongside `devicePriv`/`devicePub`. */
  private deviceMlkemPriv?: Uint8Array;
  private deviceMlkemPub?: Uint8Array;
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
    this.userId = r.userId;
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
      encSigningPrivRecovery: e.keyset.encSigningPrivRecovery,
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

  /**
   * Master-password recovery (ADR-006). Using the recovery key, re-enroll under a new master
   * password — the cryptographic identity is unchanged, so all vault access is restored.
   * Requires {@link devLogin} first (the recover endpoint is account-authenticated); the user
   * does *not* need to remember the old password. Returns the **new** recovery key (the old
   * one is now stale — show it and have the user save it). Leaves the client unlocked.
   */
  async recoverWithKey(
    recoveryKey: string,
    newMasterPassword: string,
  ): Promise<{ recoveryKey: string }> {
    const ks = await this.http<Keyset>("GET", "/vault/keyset");
    if (!ks.encSigningPrivRecovery) {
      throw new Error("this account was enrolled before recovery support; cannot recover");
    }
    const r = cryptoRecover(recoveryKey, ks, newMasterPassword, { profile: this.opts.profile });
    await this.http("POST", "/vault/keyset/recover", {
      saltMk: r.keyset.saltMk,
      saltAuth: r.keyset.saltAuth,
      argonParams: r.keyset.argonParams,
      authHash: r.keyset.authHash,
      identityPublicKey: r.keyset.identityPublicKey,
      identityPublicKeyMlkem: r.keyset.identityPublicKeyMlkem,
      signingPublicKey: r.keyset.signingPublicKey,
      identitySelfAttestation: r.keyset.identitySelfAttestation,
      encIdentityPriv: r.keyset.encIdentityPriv,
      encIdentityPrivMlkem: r.keyset.encIdentityPrivMlkem,
      encSigningPriv: r.keyset.encSigningPriv,
      encIdentityPrivRecovery: r.keyset.encIdentityPrivRecovery,
      encIdentityPrivMlkemRecovery: r.keyset.encIdentityPrivMlkemRecovery,
      encSigningPrivRecovery: r.keyset.encSigningPrivRecovery,
    });
    this.session = {
      identityPriv: r.session.identityPriv,
      identityPub: r.session.identityPub,
      identityPrivMlkem: r.session.identityPrivMlkem,
      identityPubMlkem: r.session.identityPubMlkem,
      signingPriv: r.session.signingPriv,
      signingPub: r.session.signingPub,
    };
    this.vkCache.clear();
    return { recoveryKey: r.recoveryKey };
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
        icon?: string | null;
        color?: string | null;
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
      out.push({
        id: v.id,
        type: v.type,
        role: v.role,
        keyVersion: v.currentKeyVersion,
        name,
        icon: v.icon ?? null,
        color: v.color ?? null,
      });
    }
    return out;
  }

  /**
   * Create a vault. `ui` is optional — pass `{ icon, color }` from the closed allowlists
   * exported by `@arc/types` (`VAULT_ICONS`, `VAULT_COLORS`) to render a coloured icon
   * chip in the picker. The server validates both against the same allowlists and rejects
   * 400 on anything else, so the SDK keeps this loosely typed and lets the server be the
   * source of truth.
   */
  async createVault(
    type: VaultType = "team",
    name?: string,
    ui?: { icon?: string; color?: string },
  ): Promise<{ id: string; keyVersion: number; icon: string | null; color: string | null }> {
    if (!this.session) throw new Error("not unlocked");
    const vkm = createVaultKey(1);
    const ownerGrant = wrapVaultKeyFor(vkm.vk, this.hybridPub());
    const encName = name ? encryptVaultName(vkm.vk, name, 1) : undefined;
    const r = await this.http<{
      id: string;
      currentKeyVersion: number;
      icon: string | null;
      color: string | null;
    }>("POST", "/vaults", {
      type,
      ownerGrant,
      ...(encName ? { encName } : {}),
      ...(ui?.icon !== undefined ? { icon: ui.icon } : {}),
      ...(ui?.color !== undefined ? { color: ui.color } : {}),
    });
    this.vkCache.set(r.id, { vk: vkm.vk, keyVersion: r.currentKeyVersion });
    return { id: r.id, keyVersion: r.currentKeyVersion, icon: r.icon, color: r.color };
  }

  /**
   * Patch the per-vault UI affordance. `undefined` leaves a field alone, `null` clears
   * it. Server enforces admin-or-higher membership and validates both fields against the
   * `@arc/types` allowlists.
   */
  async updateVaultUi(
    vaultId: string,
    ui: { icon?: string | null; color?: string | null },
  ): Promise<{ id: string; icon: string | null; color: string | null }> {
    return this.http<{ id: string; icon: string | null; color: string | null }>(
      "PATCH",
      `/vaults/${vaultId}/ui`,
      {
        ...(ui.icon !== undefined ? { icon: ui.icon } : {}),
        ...(ui.color !== undefined ? { color: ui.color } : {}),
      },
    );
  }

  // ----- Engine-C: agent identity + delegation (ADR-005) -----

  /**
   * Authenticate **as an agent**: prove control of the agent's signing key via
   * challenge-response and obtain a short-lived agent token (carries the owner as `sub` +
   * the agent id + the RFC 8693 `act` claim). Pass the token to {@link useBearerToken} to
   * have this client submit the agent's own intents.
   */
  async agentToken(
    agentId: string,
    agentSigningPriv: Uint8Array,
  ): Promise<{ accessToken: string; expiresIn: string }> {
    const ch = await this.http<{ nonce: string }>("POST", `/vault/agents/${agentId}/auth/challenge`, {});
    const signature = signObject(agentSigningPriv, {
      v: 1,
      purpose: "agent-auth",
      agent: agentSubject(agentId),
      nonce: ch.nonce,
    });
    return this.http("POST", `/vault/agents/${agentId}/auth/token`, { signature });
  }

  /** Swap the bearer token this client sends (e.g. to an agent token from {@link agentToken}). */
  useBearerToken(token: string): void {
    this.token = token;
  }

  /**
   * Generate a fresh agent keyset (Ed25519 signing + X25519/ML-KEM-768 hybrid identity).
   * The private halves are the agent's secret material — persist them in the agent's secure
   * storage; only `publicKeys` goes to the server at {@link registerAgent}.
   */
  static generateAgentKeyset(): AgentKeyset {
    const signing = generateSigningKeyPair();
    const identity = generateIdentityKeyPair();
    const hybrid = generateHybridIdentityKeyPair();
    return {
      signing,
      identity,
      identityMlkem: hybrid.mlkem,
      publicKeys: {
        signingPublicKey: toB64u(signing.pub),
        identityPublicKey: toB64u(identity.pub),
        identityPublicKeyMlkem: toB64u(hybrid.mlkem.publicKey),
      },
    };
  }

  /** Register an agent the caller owns. Returns the public agent record (autonomy off by default). */
  async registerAgent(input: {
    displayName: string;
    publicKeys: AgentKeyset["publicKeys"];
    attestation?: { kind: string; doc: string; trustAnchor?: string };
  }): Promise<AgentIdentity> {
    return this.http<AgentIdentity>("POST", "/vault/agents", {
      displayName: input.displayName,
      ...input.publicKeys,
      ...(input.attestation ? { attestation: input.attestation } : {}),
    });
  }

  async listAgents(): Promise<AgentIdentity[]> {
    return this.http<AgentIdentity[]>("GET", "/vault/agents");
  }

  async getAgent(agentId: string): Promise<AgentIdentity> {
    return this.http<AgentIdentity>("GET", `/vault/agents/${agentId}`);
  }

  /** Patch an agent's lifecycle / autonomy / label (owner only). */
  async updateAgent(
    agentId: string,
    patch: { status?: AgentStatus; autonomousAllowed?: boolean; displayName?: string },
  ): Promise<AgentIdentity> {
    return this.http<AgentIdentity>("PATCH", `/vault/agents/${agentId}`, patch);
  }

  /**
   * Sign and record a delegation: lend the agent scoped, time-boxed authority on your
   * behalf. Signed with the caller's identity key (requires {@link devLogin} + an unlocked
   * session). Effective authority is the intersection of these scopes with your own policy
   * and the agent's policy — a delegation can only narrow.
   */
  async createDelegation(
    agentId: string,
    opts: {
      scopes: DelegationScope[];
      /** Validity window length from now, in ms. */
      ttlMs: number;
      maxCalls?: number | null;
      elevated?: boolean;
    },
  ): Promise<{ id: string; taskId: string; notAfter: string; elevated: boolean }> {
    if (this.userId === undefined) throw new Error("not logged in: call devLogin first");
    if (!this.session?.signingPriv) throw new Error("not unlocked: no identity signing key");
    const now = Date.now();
    const claims: DelegationClaims = {
      v: 1,
      delegator: userSubject(this.userId),
      agent: agentSubject(agentId),
      scopes: opts.scopes,
      taskId: globalThis.crypto.randomUUID(),
      // Small backdate absorbs benign client/server clock skew at the window's start.
      notBefore: new Date(now - 5_000).toISOString(),
      notAfter: new Date(now + opts.ttlMs).toISOString(),
      maxCalls: opts.maxCalls ?? null,
      elevated: opts.elevated ?? false,
      nonce: toB64u(randomBytes(16)),
    };
    const signature = signDelegation(this.session.signingPriv, claims);
    return this.http("POST", `/vault/agents/${agentId}/delegations`, { claims, signature });
  }

  async listDelegations(agentId: string): Promise<
    Array<{
      id: string;
      taskId: string;
      delegatorUserId: number;
      scopes: DelegationScope[];
      notBefore: string;
      notAfter: string;
      maxCalls: number | null;
      callsUsed: number;
      elevated: boolean;
      revoked: boolean;
    }>
  > {
    return this.http("GET", `/vault/agents/${agentId}/delegations`);
  }

  async revokeDelegation(agentId: string, delegationId: string): Promise<{ ok: boolean }> {
    return this.http("DELETE", `/vault/agents/${agentId}/delegations/${delegationId}`);
  }

  /**
   * Introspect the effective-authority decision for an agent (delegation ∩ delegator ∩
   * agent ceilings). Read-only; does not consume a delegation's call budget.
   */
  async authorizeAgent(
    agentId: string,
    input: {
      path: string;
      capability: "create" | "read" | "update" | "delete" | "list" | "sudo";
      delegationId?: string;
    },
  ): Promise<{
    decision: "allow" | "deny";
    mode: "delegated" | "autonomous";
    reason: string;
    elevated: boolean;
  }> {
    return this.http("POST", `/vault/agents/${agentId}/authorize`, input);
  }

  // ----- Phase 3: tasks + signed intents (ADR-005) -----

  /**
   * Open a task — the revocable unit that meters an agent's actions and anchors its
   * signed-intent chain. Bind it to a delegation (the task id becomes the delegation's
   * `taskId`) or open a standalone task for an autonomous agent.
   */
  async openTask(
    agentId: string,
    opts: { taskId?: string; delegationId?: string; budget?: Partial<AgentTaskBudget> } = {},
  ): Promise<{ taskId: string; status: string; budget: AgentTaskBudget; deadlineAt: string }> {
    return this.http("POST", `/vault/agents/${agentId}/tasks`, opts);
  }

  /**
   * Sign and submit an intent — the agent's cryptographically-bound action. Signed with the
   * **agent's** Ed25519 key (`agentSigningPriv`, from its {@link AgentKeyset}); the server
   * verifies the signature + that `args` matches `argsDigest`, authorizes the declared
   * op/path, and folds the intent into the task's hash chain.
   */
  async submitIntent(
    agentId: string,
    agentSigningPriv: Uint8Array,
    input: {
      taskId: string;
      op: string;
      path: string;
      args?: JsonValue;
      delegationId?: string | null;
      /**
       * MED-E: the chain head the agent observed for this task *before* signing — pass
       * `ZERO_CHAIN` for the very first intent on a fresh task, or the `chainHead` from
       * the prior `submitIntent` response. The signature binds this value so the server
       * cannot accept an intent at any other chain position; mismatch → 409
       * `intent_chain_mismatch`.
       */
      prevChainHead: string;
    },
  ): Promise<{
    decision: "allow" | "deny";
    reason: string;
    mode: string;
    elevated: boolean;
    seq: number;
    chainHead: string;
    callsRemaining: number;
    /** Present when `reason === "approval-required"` — the push-consent request to satisfy. */
    approvalId?: string;
  }> {
    const args = (input.args ?? null) as JsonValue;
    const claims: IntentClaims = {
      v: 1,
      agent: agentSubject(agentId),
      delegation: input.delegationId ?? null,
      taskId: input.taskId,
      op: input.op,
      path: input.path,
      argsDigest: intentArgsDigest(args),
      ts: new Date().toISOString(),
      nonce: toB64u(randomBytes(16)),
      prevChainHead: input.prevChainHead,
    };
    const signature = signIntent(agentSigningPriv, claims);
    return this.http("POST", `/vault/agents/${agentId}/intents`, { claims, signature, args });
  }

  /** Read a task; pass `verify: true` to recompute + check the intent chain (tamper-evidence). */
  async getTask(
    agentId: string,
    taskId: string,
    opts: { verify?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const qs = opts.verify ? "?verify=true" : "";
    return this.http("GET", `/vault/agents/${agentId}/tasks/${taskId}${qs}`);
  }

  /** Close a task → cascade-revoke its delegations + Engine-A leases. */
  async closeTask(
    agentId: string,
    taskId: string,
  ): Promise<{ ok: boolean; revokedDelegations: number; revokedLeases: number }> {
    return this.http("POST", `/vault/agents/${agentId}/tasks/${taskId}/close`, {});
  }

  // ----- Phase 4: push-consent approvals (ADR-005) -----

  /** The owner's actionable (pending, unexpired) push-consent requests. */
  async listApprovals(): Promise<
    Array<{ id: string; agentId: string; taskId: string; op: string; path: string; expiresAt: string; createdAt: string }>
  > {
    return this.http("GET", "/vault/approvals");
  }

  /** Begin the WebAuthn ceremony for an approval — returns the assertion options (challenge). */
  async beginApproval(approvalId: string): Promise<Record<string, unknown>> {
    return this.http("POST", `/vault/approvals/${approvalId}/challenge`, {});
  }

  /** Grant an approval by proving control with a WebAuthn assertion (proof of control). */
  async approve(
    approvalId: string,
    assertion: Record<string, unknown>,
  ): Promise<{ ok: boolean; approvalId: string; status: string }> {
    return this.http("POST", `/vault/approvals/${approvalId}/approve`, { assertion });
  }

  /** Deny an approval outright. */
  async denyApproval(approvalId: string): Promise<{ ok: boolean; approvalId: string; status: string }> {
    return this.http("POST", `/vault/approvals/${approvalId}/deny`, {});
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

  // -- Workflows (Phase 1: JIT-access / approval workflows) -------------------

  /** List workflows configured on a vault. Admin+ only on the server side. */
  async listWorkflows(vaultId: string): Promise<WorkflowRow[]> {
    return this.http("GET", `/vaults/${vaultId}/workflows`);
  }

  async getWorkflow(vaultId: string, id: string): Promise<WorkflowRow> {
    return this.http("GET", `/vaults/${vaultId}/workflows/${id}`);
  }

  async createWorkflow(vaultId: string, body: UpsertWorkflowBody): Promise<WorkflowRow & {
    validation: { ok: boolean; issues: ReadonlyArray<{ level: "error" | "warning"; code: string; message: string; nodeId?: string; edgeId?: string }> };
  }> {
    return this.http("POST", `/vaults/${vaultId}/workflows`, body);
  }

  async updateWorkflow(
    vaultId: string,
    id: string,
    body: UpsertWorkflowBody,
  ): Promise<WorkflowRow & {
    validation: { ok: boolean; issues: ReadonlyArray<{ level: "error" | "warning"; code: string; message: string; nodeId?: string; edgeId?: string }> };
  }> {
    return this.http("PUT", `/vaults/${vaultId}/workflows/${id}`, body);
  }

  async deleteWorkflow(vaultId: string, id: string): Promise<{ ok: true }> {
    return this.http("DELETE", `/vaults/${vaultId}/workflows/${id}`);
  }

  /** Validate a workflow definition without persisting. Useful for live editor feedback. */
  async validateWorkflow(
    vaultId: string,
    definition: unknown,
  ): Promise<{ ok: boolean; issues: ReadonlyArray<{ level: "error" | "warning"; code: string; message: string; nodeId?: string; edgeId?: string }> }> {
    return this.http("POST", `/vaults/${vaultId}/workflows/validate`, { definition });
  }

  /** Simulate a saved workflow against a synthetic request context. */
  async simulateWorkflow(
    vaultId: string,
    id: string,
    ctx: {
      mountPath: string;
      capability?: string;
      requesterRole?: "owner" | "admin" | "editor" | "viewer";
      requesterGroups?: string[];
      mfaAgeSeconds?: number | null;
    },
  ): Promise<{
    decision: {
      terminal: "auto_approve" | "require_approval" | "deny";
      reason: string;
      notifications: readonly string[];
      trace: readonly string[];
    };
  }> {
    return this.http("POST", `/vaults/${vaultId}/workflows/${id}/simulate`, ctx);
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

  /** Email→identity lookup. Used by the share dialog so users find members by address. */
  async getUserIdentityKeyByEmail(email: string): Promise<{
    userId: number;
    identityPublicKey: string;
    identityPublicKeyMlkem: string;
    signingPublicKey: string;
    fingerprint: string;
  }> {
    return this.http("GET", `/vault/users/by-email/${encodeURIComponent(email)}`);
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

  // ----- Item-level shares (ADR-007) -----

  /**
   * Share **one** item with **one** user — they decrypt only that item, never become a
   * vault member, and don't receive the vault key. Looks up the recipient's hybrid identity
   * public key, derives the item's IK from the local VK cache, `pqSeal`s the IK to the
   * recipient, and uploads it; the server snapshots the ciphertext alongside.
   *
   * Re-sharing the same item to the same user upserts to the latest version (snapshot
   * semantics — recipients see the version that was shared, edits don't propagate).
   */
  async shareItem(
    vaultId: string,
    itemId: string,
    granteeUserId: number,
    opts: {
      /** "edit" lets the grantee propose write-backs (ADR-007 extension). Default "view". */
      permission?: "view" | "edit";
      /** TTL (epoch ms, must be in the future). Past the TTL the share behaves as revoked. */
      expiresAtMs?: number;
    } = {},
  ): Promise<ItemShare> {
    const vk = this.requireVk(vaultId);
    // Fetch the *current* item to grab its wrappedItemKey + version (so the IK we derive
    // matches the ciphertext the server will snapshot).
    const rows = await this.rawItems(vaultId);
    const row = rows.find((r) => r.id === itemId);
    if (!row || row.deletedAt) throw new Error(`item ${itemId} not found in vault`);

    const ik = extractItemKey(
      vk.vk,
      { vaultId, itemId, version: row.version, keyVersion: row.vaultKeyVersion },
      row.wrappedItemKey,
    );

    const recipient = await this.getUserIdentityKey(granteeUserId);
    const wrappedIK = wrapItemKeyForShare(ik, {
      x25519Pub: fromB64u(recipient.identityPublicKey),
      mlkemPub: fromB64u(recipient.identityPublicKeyMlkem),
    });

    return this.http<ItemShare>("POST", `/vaults/${vaultId}/items/${itemId}/share`, {
      itemId,
      granteeUserId,
      wrappedIK,
      ...(opts.permission ? { permission: opts.permission } : {}),
      ...(opts.expiresAtMs !== undefined ? { expiresAtMs: opts.expiresAtMs } : {}),
    });
  }

  /** Every share where this user is the grantee — items others have shared with them. */
  async listIncomingShares(): Promise<ItemShare[]> {
    return this.http<ItemShare[]>("GET", "/vault/shares/incoming");
  }

  /** Every share this user has granted (across any vault they can read). */
  async listOutgoingShares(): Promise<ItemShare[]> {
    return this.http<ItemShare[]>("GET", "/vault/shares/outgoing");
  }

  /**
   * Decrypt one incoming share. The recipient `pqSealOpen`s the IK with their hybrid
   * identity private key, then `aeadOpen`s the snapshot ciphertext — no VK needed.
   */
  decryptIncomingShare(share: ItemShare): JsonValue {
    if (!this.session) throw new Error("not unlocked");
    const ik = openItemKeyShare(share.wrappedIK, this.hybridPriv());
    return decryptItemWithIK(
      ik,
      { vaultId: share.vaultId, itemId: share.itemId, version: share.itemVersion, keyVersion: share.vaultKeyVersion },
      share.ciphertext,
    );
  }

  /** Revoke a share. Granter and grantee both have authority. */
  async revokeShare(shareId: string): Promise<{ ok: boolean }> {
    return this.http("DELETE", `/vault/shares/${shareId}`);
  }

  /**
   * Grantee proposes a new version of an edit-share (ADR-007 extension). Encrypts the
   * payload under a fresh IK, wraps that IK to the **granter's** hybrid identity (the
   * grantee has no vault key), and parks the proposal on the share row. The granter
   * reviews via {@link applyShareWriteBack}. 409 from the server when the source item
   * moved since this share's snapshot — re-fetch and re-propose.
   */
  async writeBackShare(share: ItemShare, newPayload: JsonValue): Promise<ItemShare> {
    if (!this.session) throw new Error("not unlocked");
    if (share.permission !== "edit") throw new Error("share is view-only");
    const granter = await this.getUserIdentityKey(share.granterUserId);
    const ref = {
      vaultId: share.vaultId,
      itemId: share.itemId,
      // AAD binds the proposal to the version it would BECOME (base + 1).
      version: share.itemVersion + 1,
      keyVersion: share.vaultKeyVersion,
    };
    const pending = encryptShareWriteBack(
      {
        x25519Pub: fromB64u(granter.identityPublicKey),
        mlkemPub: fromB64u(granter.identityPublicKeyMlkem),
      },
      ref,
      newPayload,
    );
    return this.http<ItemShare>("POST", `/vault/shares/${share.id}/write-back`, {
      ciphertext: pending.ciphertext,
      wrappedIKForGranter: pending.wrappedIKForGranter,
      baseItemVersion: share.itemVersion,
    });
  }

  /**
   * Granter applies a pending write-back: opens the grantee's proposal with the granter's
   * identity priv, re-encrypts under the vault key through the normal {@link putItem}
   * path (fresh IK + VK wrap + version bump), then clears the pending proposal. Returns
   * the decrypted payload that was applied so the caller can render a confirmation.
   */
  async applyShareWriteBack(share: ItemShare): Promise<{ applied: JsonValue; version: number }> {
    if (!this.session) throw new Error("not unlocked");
    if (!share.pending) throw new Error("share has no pending write-back");
    const ref = {
      vaultId: share.vaultId,
      itemId: share.itemId,
      version: share.pending.baseVersion + 1,
      keyVersion: share.pending.keyVersion,
    };
    const applied = openShareWriteBack(this.hybridPriv(), ref, {
      ciphertext: share.pending.ciphertext,
      wrappedIKForGranter: share.pending.wrappedIKForGranter,
    });
    const res = await this.putItem(share.vaultId, applied, {
      id: share.itemId,
      baseVersion: share.pending.baseVersion,
      ...(share.itemType ? { type: share.itemType } : {}),
    });
    await this.clearSharePending(share.id);
    return { applied, version: res.version };
  }

  /** Granter clears a pending write-back without applying it (reject). Idempotent. */
  async clearSharePending(shareId: string): Promise<{ ok: boolean }> {
    return this.http("DELETE", `/vault/shares/${shareId}/pending`);
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

  /**
   * New device: generate a **hybrid** device keypair (X25519 + ML-KEM-768) and register
   * both public keys (ADR-003). The trusted approver picks `pqSeal` to wrap VKs for this
   * device so device-grant material is HNDL-resistant.
   */
  async registerDevice(name: string): Promise<{ deviceId: string; verificationCode: string }> {
    const kp = generateHybridDeviceKeyPair();
    this.devicePriv = kp.x25519.priv;
    this.devicePub = kp.x25519.pub;
    this.deviceMlkemPriv = kp.mlkem.secretKey;
    this.deviceMlkemPub = kp.mlkem.publicKey;
    const r = await this.http<{ id: string; approved: boolean }>("POST", "/vault/devices", {
      publicKey: toB64u(kp.x25519.pub),
      publicKeyMlkem: toB64u(kp.mlkem.publicKey),
      name,
    });
    // LOW-D (audit): SAS now binds BOTH halves of the hybrid pair (docs/06 §6.3.1). A
    // MITM that swapped only the ML-KEM pub would no longer slip past the human compare.
    // Legacy X25519-only devices fall through to the old `fingerprint(x25519, 3)` shape
    // (see `deviceSas` in @arc/crypto), so display chrome doesn't need a version flag.
    return { deviceId: r.id, verificationCode: deviceSas(kp.x25519.pub, kp.mlkem.publicKey) };
  }

  /** Trusted device: list devices awaiting approval (with their verification codes). */
  async listPendingDevices(): Promise<PendingDevice[]> {
    return this.http("GET", "/vault/devices?pending=true");
  }

  /**
   * List this user's currently-enrolled (approved) devices. Includes `lastSeenAt` and
   * `trusted`, so a "My devices" UI can warn about devices that haven't checked in for a
   * while or surface which devices are exempt from the inactivity policy.
   */
  async listDevices(): Promise<EnrolledDevice[]> {
    return this.http("GET", "/vault/devices?approved=true&pending=false");
  }

  /**
   * Update a device's `lastSeenAt` to now. Call this on unlock + periodically thereafter
   * so the device doesn't get auto-revoked by the inactivity policy. Server validates the
   * device belongs to the authenticated user (404 otherwise).
   */
  async touchDevice(deviceId: string): Promise<{ ok: true; lastSeenAt: string }> {
    return this.http("POST", "/vault/devices/me/touch", { deviceId });
  }

  /**
   * Revoke a device. Deletes the device row + its vault-key grants, writes a
   * `device_revoked` audit event. Use this for explicit retirement; the inactivity policy
   * is a separate path that writes `device_auto_revoked` instead.
   */
  async revokeDevice(deviceId: string): Promise<{ ok: true }> {
    return this.http("DELETE", `/vault/devices/${encodeURIComponent(deviceId)}`);
  }

  /**
   * Trusted device: wrap every cached VK to the new device's public key(s) and approve it.
   * When `devicePublicKeyMlkemB64` is provided (ADR-003 hybrid device), the VKs are wrapped
   * with `pqSeal` so the resulting device grant is HNDL-resistant. Legacy callers that omit
   * it fall back to the classical `seal` envelope.
   */
  async approveDevice(
    deviceId: string,
    devicePublicKeyB64: string,
    devicePublicKeyMlkemB64?: string | null,
  ): Promise<void> {
    const devicePub = fromB64u(devicePublicKeyB64);
    const useHybrid = !!devicePublicKeyMlkemB64;
    const recipient = useHybrid
      ? { x25519Pub: devicePub, mlkemPub: fromB64u(devicePublicKeyMlkemB64 as string) }
      : null;
    const grants = [...this.vkCache.entries()].map(([vaultId, { vk, keyVersion }]) => ({
      vaultId,
      keyVersion,
      wrappedVaultKey: recipient ? pqSeal(recipient, vk) : seal(devicePub, vk),
    }));
    await this.http("POST", `/vault/devices/${deviceId}/approve`, { grants });
  }

  /**
   * New device: fetch and open this device's VK grants. Picks `pqSealOpen` when the
   * envelope's `alg` is the hybrid one and the device has its ML-KEM private; falls back
   * to the classical `sealOpen` otherwise. Mixed-envelope keysets (some pq-hybrid, some
   * legacy) work transparently.
   */
  async loadDeviceGrants(deviceId: string): Promise<Array<{ id: string; keyVersion: number }>> {
    if (!this.devicePriv) throw new Error("no device key; call registerDevice first");
    const grants = await this.http<
      Array<{ vaultId: string; keyVersion: number; wrappedVaultKey: Envelope }>
    >("GET", `/vault/devices/me/keyset?deviceId=${deviceId}`);
    const out: Array<{ id: string; keyVersion: number }> = [];
    for (const g of grants) {
      const alg = g.wrappedVaultKey.alg;
      // The hybrid envelope alg is `pq-seal-x25519-mlkem768-hkdf-xc20p` (see ALG.PQ_SEAL
      // in @arc/crypto). Classical seal is `seal-x25519-hkdf-xc20p`. Disambiguate by the
      // `pq-` prefix so future PQ algs flow into this branch automatically.
      const isHybrid = typeof alg === "string" && alg.startsWith("pq-");
      let vk: Uint8Array;
      if (isHybrid) {
        if (!this.deviceMlkemPriv) throw new Error("device grant is hybrid but device has no ML-KEM private key");
        vk = pqSealOpen(g.wrappedVaultKey, {
          x25519Priv: this.devicePriv,
          mlkemPriv: this.deviceMlkemPriv,
        });
      } else {
        vk = sealOpen(this.devicePriv, g.wrappedVaultKey);
      }
      this.vkCache.set(g.vaultId, { vk, keyVersion: g.keyVersion });
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

  /**
   * Username-less / discoverable **sign-in** via passkey (ADR-008). The user doesn't type
   * an email — the authenticator picks one of its resident credentials and the server
   * resolves the account from `userHandle`. After this returns, the client is
   * **signed in** (accessToken set) but not yet unlocked.
   *
   * The natural follow-on is {@link unlockWithPasskey} which performs the PRF unwrap with
   * the now-known per-user salt — two biometric gestures in total on first cold launch
   * (modern browsers may coalesce them into one prompt). On a previously signed-in
   * session, `unlockWithPasskey` alone is one tap. The atomic helper
   * {@link signInAndUnlockWithPasskey} sequences both steps if you don't need them apart.
   */
  async signInWithDiscoverablePasskey(
    authenticator: PasskeyAuthenticator,
  ): Promise<{ userId: number; email: string }> {
    const opts = await this.http<PasskeyUnlockOptions>(
      "POST",
      "/vault/passkey/discover-challenge",
    );
    const assertion = await authenticator.get({
      ...opts,
      // PRF eval at this step is intentionally throw-away — we don't have the per-user
      // salt yet, so we pass an empty input. The authenticator will compute *some* PRF
      // output; we discard it. The follow-up `unlockWithPasskey` does the real PRF eval
      // with the correct salt.
      prfFirst: new Uint8Array(0),
    });
    const result = await this.http<{
      accessToken: string;
      userId: number;
      email: string;
      credentialId: string;
    }>("POST", "/vault/passkey/discover-unlock", {
      assertion: assertion.assertion as unknown as Record<string, unknown>,
    });
    this.token = result.accessToken;
    this.userId = result.userId;
    return { userId: result.userId, email: result.email };
  }

  /**
   * Sign in *and* unlock with one method call. Runs the discoverable sign-in then the
   * PRF-based unlock back-to-back. On platforms where the browser coalesces consecutive
   * WebAuthn prompts this is one biometric gesture; in the worst case it's two — both
   * fingerprint/face taps and **zero typing**.
   */
  async signInAndUnlockWithPasskey(
    authenticator: PasskeyAuthenticator,
  ): Promise<{ userId: number; email: string }> {
    const who = await this.signInWithDiscoverablePasskey(authenticator);
    await this.unlockWithPasskey(authenticator);
    return who;
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
