import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from "class-validator";
import type { AgentStatusCol } from "../database/entities";

const AGENT_STATUSES = ["active", "suspended", "retired"] as const;

/** Owner registers an agent by publishing its public keys (the agent generated them out-of-band). */
export class RegisterAgentDto {
  @IsString() displayName!: string;
  /** Ed25519 verifying key (b64url). */
  @IsString() signingPublicKey!: string;
  /** X25519 identity public key (b64url). */
  @IsString() identityPublicKey!: string;
  /** ML-KEM-768 identity public key (b64url). */
  @IsString() identityPublicKeyMlkem!: string;
  /** Optional attestation `{ kind, doc, trustAnchor? }` recorded at enrollment. */
  @IsOptional() @IsObject() attestation?: Record<string, unknown>;
}

/** Patch an agent's lifecycle / autonomy / label. Admin-or-owner only; each field optional. */
export class UpdateAgentDto {
  @IsOptional() @IsIn(AGENT_STATUSES) status?: AgentStatusCol;
  /**
   * Enable/disable autonomous mode. Deny-by-default (ADR-005): an agent can only act under
   * its own authority (no delegation) once this is explicitly set true by an admin.
   */
  @IsOptional() @IsBoolean() autonomousAllowed?: boolean;
  @IsOptional() @IsString() displayName?: string;
}

/**
 * Create a signed delegation. `claims` is the canonical {@link DelegationClaims} the
 * delegating user signed; `signature` is their Ed25519 envelope over it. The server
 * verifies the signature against the delegator's published signing key before storing.
 */
export class CreateDelegationDto {
  @IsObject() claims!: Record<string, unknown>;
  @IsObject() signature!: Record<string, unknown>;
}

/**
 * Introspect whether an agent would be allowed `capability` on `path`, optionally under a
 * specific `delegationId`. This is the effective-authority decision (delegation ∩ delegator
 * ∩ agent ceilings) made callable for testing + UI without minting an agent credential.
 */
export class AuthorizeAgentDto {
  @IsString() path!: string;
  @IsIn(["create", "read", "update", "delete", "list", "sudo"]) capability!:
    | "create"
    | "read"
    | "update"
    | "delete"
    | "list"
    | "sudo";
  @IsOptional() @IsString() delegationId?: string;
}
