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
  @IsString() signingPublicKey!: string;
  @IsString() identitySelfAttestation!: string;
  @IsObject() encIdentityPriv!: EnvelopeJson;
  @IsObject() encSigningPriv!: EnvelopeJson;
  @IsObject() encIdentityPrivRecovery!: EnvelopeJson;
  /** Wrapped personal-vault VK for the enrolling user (seal to their own identity key). */
  @IsObject() ownerGrant!: EnvelopeJson;
  @IsOptional() @IsObject() personalVaultEncName?: EnvelopeJson | null;
  @IsOptional() @IsObject() device?: { publicKey: string; name: string; encVaultKey?: EnvelopeJson };
}

export class UnlockDto {
  @IsString() authHash!: string;
}

export class CreateVaultDto {
  @IsIn(VAULT_TYPES) type!: VaultType;
  @IsObject() ownerGrant!: EnvelopeJson;
  @IsOptional() @IsObject() encName?: EnvelopeJson | null;
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
  @IsString() name!: string;
}

export class ApproveDeviceDto {
  @IsArray() grants!: Array<{ keyVersion: number; wrappedVaultKey: EnvelopeJson; vaultId: string }>;
}

export class RotateKeyDto {
  @IsInt() @Min(1) newKeyVersion!: number;
  @IsArray() grants!: Array<{ granteeUserId: number; wrappedVaultKey: EnvelopeJson; signature?: EnvelopeJson }>;
  @IsArray() rewrappedItemKeys!: Array<{ itemId: string; wrappedItemKey: EnvelopeJson }>;
}
