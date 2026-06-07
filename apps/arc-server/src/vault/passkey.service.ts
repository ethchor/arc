import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { randomBytes } from "node:crypto";
import { Repository } from "typeorm";
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/types";
import {
  UserEntity,
  VaultUserKeysEntity,
  VaultUserPasskeyEntity,
  type EnvelopeJson,
} from "../database/entities";

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes — WebAuthn UX-friendly without lingering forever
const PRF_SALT_LEN = 32; // arc/passkey/v1 expects 32 bytes; HKDF inside `derivePasskeyWrapKey`

interface PendingChallenge {
  challenge: string;
  expiresAt: number;
  /**
   * PRF salt sent with the WebAuthn extension. Per-user-stable (looked up from / persisted
   * onto the user's credentials), so register-time wrap and unlock-time unwrap derive the
   * same wrap key from the authenticator's PRF.
   */
  prfSalt: string;
}

/**
 * Server side of the passkey unlock flow (docs/13). Server holds the credential public key
 * + signature counter (anti-clone) + the identity-private envelopes wrapped under a
 * per-credential PRF-derived KEK. Zero-knowledge property preserved: the PRF output never
 * leaves the client, the identity key is never revealed to the server, master key remains
 * untouched.
 *
 * Flow:
 *  1. `beginRegistration` → server hands the client a WebAuthn create-options blob with a
 *     fresh challenge + PRF eval salt; client runs `navigator.credentials.create`, derives
 *     the PRF output, wraps the identity priv (X25519 + ML-KEM), and sends both + the
 *     attestation back to `finishRegistration`.
 *  2. `beginUnlock` → server picks a fresh challenge + the same PRF salt used at
 *     registration time (looked up from the stored credential id), returns assertion
 *     options. Client signs with the authenticator, runs PRF, sends the assertion back to
 *     `finishUnlock`.
 *  3. `finishUnlock` verifies the assertion, advances the counter, and returns the wrapped
 *     identity envelopes. Client unwraps with the PRF output.
 *
 * Configuration: `ARC_PASSKEY_RP_ID` (default `localhost`) + `ARC_PASSKEY_RP_NAME` (default
 * `arc`) + `ARC_PASSKEY_ORIGIN` (default `http://localhost:5173`). In production these MUST
 * be set or WebAuthn will refuse the registration / unlock.
 *
 * Challenge state is in-memory keyed by userId, with a 5-minute TTL. Matches the existing
 * unlock-attempts map's posture; a Redis-backed store is the multi-instance follow-up.
 */
@Injectable()
export class PasskeyService {
  private readonly logger = new Logger(PasskeyService.name);
  private readonly registrations = new Map<number, PendingChallenge>();
  private readonly unlocks = new Map<number, PendingChallenge>();

  constructor(
    @InjectRepository(VaultUserPasskeyEntity)
    private readonly passkeys: Repository<VaultUserPasskeyEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(VaultUserKeysEntity)
    private readonly userKeys: Repository<VaultUserKeysEntity>,
  ) {}

  private rpId(): string {
    return process.env.ARC_PASSKEY_RP_ID ?? "localhost";
  }
  private rpName(): string {
    return process.env.ARC_PASSKEY_RP_NAME ?? "arc";
  }
  private origin(): string {
    return process.env.ARC_PASSKEY_ORIGIN ?? "http://localhost:5173";
  }

  // --- registration ---

  async beginRegistration(
    userId: number,
  ): Promise<PublicKeyCredentialCreationOptionsJSON & { prfSalt: string }> {
    const user = await this.users.findOneOrFail({ where: { id: userId } });
    // Tie this enrollment to the existing vault keyset — passkey unlock is additive, not
    // a replacement for master-password.
    const enrolled = await this.userKeys.findOne({ where: { userId } });
    if (!enrolled) throw new NotFoundException("not enrolled");

    const existing = await this.passkeys.find({ where: { userId } });
    // Reuse the user's existing PRF salt across credentials so they all unwrap the same
    // identity. Only the first-ever passkey for the user mints a fresh salt.
    const prfSalt = existing[0]?.prfSalt ?? randomBytes(PRF_SALT_LEN).toString("base64url");
    const options = await generateRegistrationOptions({
      rpID: this.rpId(),
      rpName: this.rpName(),
      userID: new TextEncoder().encode(String(userId)),
      userName: user.email,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
      excludeCredentials: existing.map((p) => ({
        id: p.credentialId,
        transports: (p.transports ?? undefined) as AuthenticatorTransportLike[] | undefined,
      })),
      // Per-user PRF salt: stable across this credential's lifetime so register + unlock
      // produce the same wrap key. The salt itself is non-secret and stored alongside the
      // credential lookup; rotation requires re-enrolling.
    });

    this.registrations.set(userId, {
      challenge: options.challenge,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      prfSalt,
    });

    return { ...options, prfSalt };
  }

  async finishRegistration(
    userId: number,
    registration: RegistrationResponseJSON,
    encIdentityPrivPasskey: EnvelopeJson,
    encIdentityPrivMlkemPasskey: EnvelopeJson,
    encSigningPrivPasskey: EnvelopeJson,
    label?: string,
  ): Promise<{ credentialId: string }> {
    const pending = this.registrations.get(userId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.registrations.delete(userId);
      throw new UnauthorizedException("no pending passkey registration");
    }
    this.registrations.delete(userId);

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: registration,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpId(),
        requireUserVerification: true,
      });
    } catch (err) {
      this.logger.warn(`passkey registration verify failed: ${(err as Error).message}`);
      throw new UnauthorizedException("passkey registration verification failed");
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException("passkey registration not verified");
    }
    const reg = verification.registrationInfo;
    const credentialId = reg.credential.id;
    const publicKey = Buffer.from(reg.credential.publicKey).toString("base64url");
    const counter = String(reg.credential.counter);
    const transports = (reg.credential.transports ?? null) as string[] | null;

    const row = this.passkeys.create({
      userId,
      credentialId,
      publicKey,
      counter,
      label: label ?? null,
      encIdentityPrivPasskey,
      encIdentityPrivMlkemPasskey,
      encSigningPrivPasskey,
      transports,
      prfSalt: pending.prfSalt,
    });
    await this.passkeys.save(row);
    return { credentialId };
  }

  async list(userId: number): Promise<
    Array<{ id: string; credentialId: string; label: string | null; createdAt: string }>
  > {
    const rows = await this.passkeys.find({ where: { userId }, order: { createdAt: "DESC" } });
    return rows.map((r) => ({
      id: r.id,
      credentialId: r.credentialId,
      label: r.label,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async remove(userId: number, id: string): Promise<void> {
    const res = await this.passkeys.delete({ id, userId });
    if ((res.affected ?? 0) === 0) throw new NotFoundException("passkey not found");
  }

  // --- unlock ---

  async beginUnlock(
    userId: number,
  ): Promise<PublicKeyCredentialRequestOptionsJSON & { prfSalt: string }> {
    const credentials = await this.passkeys.find({ where: { userId } });
    if (credentials.length === 0) throw new NotFoundException("no passkeys registered");
    const options = await generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: "required",
      allowCredentials: credentials.map((c) => ({
        id: c.credentialId,
        transports: (c.transports ?? undefined) as AuthenticatorTransportLike[] | undefined,
      })),
    });
    // All of this user's credentials share the same PRF salt (persisted at first-ever
    // register; reused at subsequent registers). One identity → one salt; different PRF
    // outputs per credential then yield different wraps but unwrap to the same identity.
    const prfSalt = credentials[0]!.prfSalt;
    this.unlocks.set(userId, {
      challenge: options.challenge,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      prfSalt,
    });
    return { ...options, prfSalt };
  }

  async finishUnlock(
    userId: number,
    assertion: AuthenticationResponseJSON,
  ): Promise<{
    encIdentityPrivPasskey: EnvelopeJson;
    encIdentityPrivMlkemPasskey: EnvelopeJson;
    encSigningPrivPasskey: EnvelopeJson;
    credentialId: string;
  }> {
    const pending = this.unlocks.get(userId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.unlocks.delete(userId);
      throw new UnauthorizedException("no pending passkey unlock");
    }
    this.unlocks.delete(userId);

    const credentialId = assertion.id;
    const stored = await this.passkeys.findOne({ where: { userId, credentialId } });
    if (!stored) throw new UnauthorizedException("passkey not registered for this user");

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpId(),
        credential: {
          id: stored.credentialId,
          publicKey: Buffer.from(stored.publicKey, "base64url"),
          counter: Number(stored.counter),
          transports: (stored.transports ?? undefined) as AuthenticatorTransportLike[] | undefined,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      this.logger.warn(`passkey unlock verify failed: ${(err as Error).message}`);
      throw new UnauthorizedException("passkey unlock verification failed");
    }
    if (!verification.verified) {
      throw new UnauthorizedException("passkey assertion not verified");
    }

    // Anti-clone: counter must strictly increase. Authenticators that always report 0
    // (some platform authenticators) skip the bump but stay at 0 — the > check below
    // tolerates that case.
    const newCounter = String(verification.authenticationInfo.newCounter);
    if (Number(newCounter) > Number(stored.counter)) {
      stored.counter = newCounter;
      await this.passkeys.save(stored);
    } else if (Number(newCounter) < Number(stored.counter)) {
      this.logger.warn(
        `passkey counter regression for user=${userId} cred=${credentialId}: ${stored.counter} → ${newCounter}`,
      );
      throw new UnauthorizedException("passkey counter regression (possible clone)");
    }

    return {
      encIdentityPrivPasskey: stored.encIdentityPrivPasskey,
      encIdentityPrivMlkemPasskey: stored.encIdentityPrivMlkemPasskey,
      encSigningPrivPasskey: stored.encSigningPrivPasskey,
      credentialId,
    };
  }

  // --- generic proof-of-control (reused by Engine-C push-consent, ADR-005 Phase 4) ---

  /**
   * Generate a WebAuthn assertion challenge for a *generic* proof-of-control ceremony (not
   * tied to vault unlock). The caller persists the returned `challenge` against whatever it
   * is gating (e.g. a pending approval) and later passes it to
   * {@link verifyAssertionWithChallenge}. Throws if the user has no registered passkeys.
   */
  async beginAssertionChallenge(userId: number): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const credentials = await this.passkeys.find({ where: { userId } });
    if (credentials.length === 0) throw new NotFoundException("no passkeys registered");
    return generateAuthenticationOptions({
      rpID: this.rpId(),
      userVerification: "required",
      allowCredentials: credentials.map((c) => ({
        id: c.credentialId,
        transports: (c.transports ?? undefined) as AuthenticatorTransportLike[] | undefined,
      })),
    });
  }

  /**
   * Verify a WebAuthn assertion against a caller-supplied `expectedChallenge` (the reusable
   * core of {@link finishUnlock}, minus the unlock-specific key return). Bumps the anti-clone
   * counter. Returns the verified credential id. Throws on any verification failure.
   */
  async verifyAssertionWithChallenge(
    userId: number,
    assertion: AuthenticationResponseJSON,
    expectedChallenge: string,
  ): Promise<{ credentialId: string }> {
    const stored = await this.passkeys.findOne({ where: { userId, credentialId: assertion.id } });
    if (!stored) throw new UnauthorizedException("passkey not registered for this user");

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge,
        expectedOrigin: this.origin(),
        expectedRPID: this.rpId(),
        credential: {
          id: stored.credentialId,
          publicKey: Buffer.from(stored.publicKey, "base64url"),
          counter: Number(stored.counter),
          transports: (stored.transports ?? undefined) as AuthenticatorTransportLike[] | undefined,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      this.logger.warn(`passkey assertion verify failed: ${(err as Error).message}`);
      throw new UnauthorizedException("passkey assertion verification failed");
    }
    if (!verification.verified) throw new UnauthorizedException("passkey assertion not verified");

    const newCounter = String(verification.authenticationInfo.newCounter);
    if (Number(newCounter) > Number(stored.counter)) {
      stored.counter = newCounter;
      await this.passkeys.save(stored);
    } else if (Number(newCounter) < Number(stored.counter)) {
      this.logger.warn(
        `passkey counter regression for user=${userId} cred=${assertion.id}: ${stored.counter} → ${newCounter}`,
      );
      throw new UnauthorizedException("passkey counter regression (possible clone)");
    }
    return { credentialId: assertion.id };
  }
}

/** AuthenticatorTransport from the WebAuthn spec, narrowed loosely for our pass-through use. */
type AuthenticatorTransportLike = "usb" | "nfc" | "ble" | "internal" | "hybrid" | "smart-card";
