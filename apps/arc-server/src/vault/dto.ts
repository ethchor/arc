import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from "class-validator";
import type { EnvelopeJson, MemberRole, VaultType } from "../database/entities";

const ROLES = ["owner", "admin", "editor", "viewer"] as const;
const VAULT_TYPES = ["personal", "team", "org"] as const;

export class EnrollDto {
  @IsString() saltMk!: string;
  @IsString() saltAuth!: string;
  @IsObject() argonParams!: Record<string, unknown>;
  @IsString() authHash!: string;
  @IsString() identityPublicKey!: string;
  @IsString() identityPublicKeyMlkem!: string;
  @IsString() signingPublicKey!: string;
  @IsString() identitySelfAttestation!: string;
  @IsObject() encIdentityPriv!: EnvelopeJson;
  @IsObject() encIdentityPrivMlkem!: EnvelopeJson;
  @IsObject() encSigningPriv!: EnvelopeJson;
  @IsObject() encIdentityPrivRecovery!: EnvelopeJson;
  @IsObject() encIdentityPrivMlkemRecovery!: EnvelopeJson;
  /** Signing key wrapped under the recovery KEK (ADR-006). Optional for pre-ADR-006 clients. */
  @IsOptional() @IsObject() encSigningPrivRecovery?: EnvelopeJson;
  /** Wrapped personal-vault VK for the enrolling user (seal to their own identity key). */
  @IsObject() ownerGrant!: EnvelopeJson;
  @IsOptional() @IsObject() personalVaultEncName?: EnvelopeJson | null;
  @IsOptional() @IsObject() device?: { publicKey: string; name: string; encVaultKey?: EnvelopeJson };
}

export class UnlockDto {
  @IsString() authHash!: string;
}

/**
 * Replace the *wrapping* layer of an existing keyset during master-password recovery
 * (ADR-006). Every public key + the key version MUST equal the stored values — the server
 * pins them, so recovery can never swap the account's cryptographic identity (anti-takeover).
 * Only the salts / authHash / wrapped-priv envelopes / self-attestation change.
 */
/**
 * Item-level share (ADR-007). The granter computes `wrappedIK = pqSeal(IK, recipient
 * hybrid pub)` client-side and sends it. The server checks the granter is a viewer-or-
 * higher member of the source vault, then snapshots the item's *current* ciphertext +
 * versions and persists everything together. Server never sees the IK.
 *
 * `permission` is `view` for v1; the column exists so the wire shape doesn't break when
 * edit-shares land.
 */
export class CreateItemShareDto {
  @IsUUID() itemId!: string;
  @IsInt() granteeUserId!: number;
  @IsObject() wrappedIK!: EnvelopeJson;
  @IsOptional() @IsIn(["view"]) permission?: "view";
}

export class RecoverKeysetDto {
  @IsString() saltMk!: string;
  @IsString() saltAuth!: string;
  @IsObject() argonParams!: Record<string, unknown>;
  @IsString() authHash!: string;
  /** Pinned — must match the stored value. */
  @IsString() identityPublicKey!: string;
  @IsString() identityPublicKeyMlkem!: string;
  @IsString() signingPublicKey!: string;
  @IsString() identitySelfAttestation!: string;
  @IsObject() encIdentityPriv!: EnvelopeJson;
  @IsObject() encIdentityPrivMlkem!: EnvelopeJson;
  @IsObject() encSigningPriv!: EnvelopeJson;
  @IsObject() encIdentityPrivRecovery!: EnvelopeJson;
  @IsObject() encIdentityPrivMlkemRecovery!: EnvelopeJson;
  @IsObject() encSigningPrivRecovery!: EnvelopeJson;
}

export class CreateVaultDto {
  @IsIn(VAULT_TYPES) type!: VaultType;
  @IsObject() ownerGrant!: EnvelopeJson;
  @IsOptional() @IsObject() encName?: EnvelopeJson | null;
  /**
   * Optional UI affordance. Validated against the closed `VAULT_ICONS` allowlist in
   * `@arc/types`; reject 400 on anything outside it so the column can never store
   * arbitrary content rendered by the picker.
   */
  @IsOptional() @IsString() icon?: string;
  /** Same story as `icon`, validated against `VAULT_COLORS`. */
  @IsOptional() @IsString() color?: string;
}

/**
 * Partial update for the UI affordance columns. Both fields are optional — if a caller
 * sends only `icon` we leave `color` alone, and vice versa. Sending `null` is the explicit
 * "clear it" signal (versus `undefined` which means "don't touch").
 */
export class UpdateVaultUiDto {
  @IsOptional() @IsString() icon?: string | null;
  @IsOptional() @IsString() color?: string | null;
}

export class UpsertItemDto {
  @IsOptional() @IsUUID() id?: string;
  @IsObject() ciphertext!: EnvelopeJson;
  @IsObject() wrappedItemKey!: EnvelopeJson;
  @IsInt() @Min(1) vaultKeyVersion!: number;
  @IsOptional() @IsInt() @Min(0) baseVersion?: number;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsUUID() folderId?: string;
  @IsOptional() @IsObject() signature?: EnvelopeJson;
}

export class AddMemberDto {
  @IsInt() userId!: number;
  @IsIn(ROLES) role!: MemberRole;
  @IsInt() @Min(1) keyVersion!: number;
  @IsObject() wrappedVaultKey!: EnvelopeJson;
  @IsOptional() @IsObject() signature?: EnvelopeJson;
}

export class PutHeadDto {
  @IsInt() @Min(0) seq!: number;
  @IsString() chainHash!: string;
  @IsString() ts!: string;
  @IsObject() signature!: EnvelopeJson;
}

export class RegisterDeviceDto {
  @IsString() publicKey!: string;
  /**
   * Optional device ML-KEM-768 public key (b64url) — ADR-003. Present when the client is
   * the hybrid-aware desktop / SDK; absent for legacy X25519-only devices. The trusted
   * approver picks `seal` vs `pqSeal` based on its presence.
   */
  @IsOptional() @IsString() publicKeyMlkem?: string;
  @IsString() name!: string;
}

export class CreateFolderDto {
  @IsObject() encName!: EnvelopeJson;
}

export class ApproveDeviceDto {
  @IsArray() grants!: Array<{ keyVersion: number; wrappedVaultKey: EnvelopeJson; vaultId: string }>;
}

export class TouchDeviceDto {
  @IsUUID() deviceId!: string;
}

/**
 * Upload an encrypted attachment. The client encrypts the file under a one-shot attachment
 * key, wraps that key to the vault key, and POSTs the base64 ciphertext bytes here. The
 * server stays zero-knowledge — `ciphertextB64` is opaque and lands directly in the
 * configured BlobStore (memory / fs / S3) keyed by the row's `blobKey`.
 */
export class UploadAttachmentDto {
  /** Base64-encoded encrypted bytes. Body limit raised in `main.ts` to allow ≤ 25 MiB. */
  @IsString() ciphertextB64!: string;
  @IsObject() wrappedKey!: EnvelopeJson;
  @IsObject() encMetadata!: EnvelopeJson;
  @IsInt() @Min(1) vaultKeyVersion!: number;
}

export class RotateKeyDto {
  @IsInt() @Min(1) newKeyVersion!: number;
  @IsArray() grants!: Array<{ granteeUserId: number; wrappedVaultKey: EnvelopeJson; signature?: EnvelopeJson }>;
  @IsArray() rewrappedItemKeys!: Array<{ itemId: string; wrappedItemKey: EnvelopeJson }>;
}

// --- Passkey unlock (docs/13) ---

export class PasskeyRegisterDto {
  /** WebAuthn attestation response JSON, exactly as `navigator.credentials.create` returns it. */
  @IsObject() registration!: Record<string, unknown>;
  /** Optional human-readable label, e.g. "MacBook Touch ID". */
  @IsOptional() @IsString() label?: string;
  /** Identity X25519 private key wrapped under the PRF-derived KEK (client-side). */
  @IsObject() encIdentityPrivPasskey!: EnvelopeJson;
  /** Identity ML-KEM-768 private key wrapped under the same KEK. */
  @IsObject() encIdentityPrivMlkemPasskey!: EnvelopeJson;
  /** Signing Ed25519 private key wrapped under the same KEK — enables write ops on unlock. */
  @IsObject() encSigningPrivPasskey!: EnvelopeJson;
}

export class PasskeyUnlockDto {
  /** WebAuthn assertion response JSON, exactly as `navigator.credentials.get` returns it. */
  @IsObject() assertion!: Record<string, unknown>;
}

/**
 * Username-less / discoverable unlock (ADR-008). Body carries only the WebAuthn assertion;
 * the server resolves the user from `assertion.response.userHandle` (set at registration as
 * `encode(String(userId))`). No userId on the wire — that's the whole point.
 */
export class PasskeyDiscoverUnlockDto {
  @IsObject() assertion!: Record<string, unknown>;
}
