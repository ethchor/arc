import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { Repository } from "typeorm";
import { UserEntity } from "../database/entities";
import { buildOidcAccountConfig, type OidcAccountConfig } from "./oidc.config";

/**
 * Verifies an OIDC ID token's signature against the issuer's JWKS and its standard
 * time/issuer/audience claims, returning the decoded claims. Structurally identical to
 * `@arc/plugin-oidc`'s `JwtVerifier` — {@link AuthModule} injects that package's Node
 * implementation, and tests inject a fake. Deliberately reused rather than reimplemented:
 * a second hand-rolled JWKS path is a second place to get signature checking wrong.
 */
export interface IdTokenVerifier {
  verify(
    token: string,
    expected: { issuer: string; audiences: string[]; clockSkewSeconds: number },
  ): Promise<Record<string, unknown>>;
}

export const ID_TOKEN_VERIFIER = Symbol("ID_TOKEN_VERIFIER");

/**
 * MED-C (supply-chain audit): `dev-login` mints a real `JWT_SECRET`-signed bearer
 * for any email the caller supplies — no password, no signature, no challenge. The
 * old guard was `NODE_ENV === "production"`, which is exclusive: anything other
 * than the literal string `"production"` (undefined, `"prod"`, `"Production"`,
 * `"staging"`, `"preview"`, a typo) **enabled** the endpoint. Container images and
 * Helm charts that forgot to set NODE_ENV — a common mis-config — silently shipped
 * a takeover-any-account RPC bound to the same JWT secret the real auth uses.
 *
 * The new gate requires BOTH:
 *  1. `NODE_ENV !== "production"` (defense in depth; the previous safety),
 *  2. `ARC_ENABLE_DEV_LOGIN === "true"` (explicit opt-in by the operator).
 *
 * Result: production stays disabled regardless of opt-in; every non-production
 * env is also disabled unless the operator deliberately turned it on. Tests set
 * `ARC_ENABLE_DEV_LOGIN=true` globally in `test/setup.ts`.
 */
function isDevLoginEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.ARC_ENABLE_DEV_LOGIN === "true";
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly oidc: OidcAccountConfig = buildOidcAccountConfig();

  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
    @Inject(ID_TOKEN_VERIFIER) private readonly verifier: IdTokenVerifier,
  ) {}

  /**
   * Dev-only stand-in for OAuth (which authorizes *sync*, not vault unlock — docs/06 §6.1).
   * In production this is replaced by Google OAuth. See `isDevLoginEnabled()` above for
   * the MED-C-hardened gate: opt-in via `ARC_ENABLE_DEV_LOGIN=true` AND non-production.
   */
  async devLogin(email: string): Promise<{ accessToken: string; userId: number }> {
    if (!isDevLoginEnabled()) {
      throw new ForbiddenException(
        "dev-login is disabled. Set ARC_ENABLE_DEV_LOGIN=true (and ensure NODE_ENV is not 'production') to enable in development.",
      );
    }
    let user = await this.users.findOne({ where: { email } });
    if (!user) {
      user = await this.users.save(this.users.create({ email }));
    }
    const accessToken = await this.jwt.signAsync({ sub: user.id, email: user.email });
    return { accessToken, userId: user.id };
  }

  /**
   * Production account login (issue #144 / BL-C4). The caller presents an OIDC **ID token**
   * it already obtained from an allowlisted identity provider; arc verifies it and mints its
   * own JWT.
   *
   * This is the *sync* gate only. Doc 06 §6.1 keeps account login and vault unlock separate:
   * a stolen arc JWT yields ciphertext, and the master password alone yields nothing to sync
   * against. So this deliberately proves something the master password does not — which is
   * also why login must never be derived from `authHash`, however convenient that would be.
   *
   * It doubles as the email-verification path: arc sends no mail, it relies on the IdP's
   * `email_verified` claim, and refuses the login without it.
   */
  async oidcLogin(idToken: string): Promise<{ accessToken: string; userId: number; email: string }> {
    if (this.oidc.issuers.length === 0) {
      throw new ServiceUnavailableException({
        error: "oidc_not_configured",
        message: "Account login is not configured. Set ARC_OIDC_ISSUERS + ARC_OIDC_AUDIENCES.",
      });
    }

    // Read `iss` from the *unverified* payload only to pick which allowlisted issuer to
    // verify against; the verifier re-checks it against that choice and throws on mismatch,
    // so an attacker cannot steer us to a issuer we do not trust.
    const issuer = unverifiedIssuer(idToken);
    if (issuer === null || !this.oidc.issuers.includes(issuer)) {
      throw new UnauthorizedException({ error: "issuer_not_allowed" });
    }

    let claims: Record<string, unknown>;
    try {
      claims = await this.verifier.verify(idToken, {
        issuer,
        audiences: [...this.oidc.audiences],
        clockSkewSeconds: this.oidc.clockSkewSeconds,
      });
    } catch (err) {
      this.logger.warn(`oidc login rejected for issuer ${issuer}: ${(err as Error).message}`);
      throw new UnauthorizedException({ error: "invalid_id_token" });
    }

    const subject = claims.sub;
    if (typeof subject !== "string" || subject.length === 0) {
      throw new UnauthorizedException({ error: "id_token_missing_sub" });
    }
    const email = claims.email;
    if (typeof email !== "string" || email.length === 0) {
      throw new UnauthorizedException({ error: "id_token_missing_email" });
    }
    // Without this an IdP that lets users set an arbitrary unverified address would let an
    // attacker present someone else's email and be handed their invites and item shares.
    if (claims.email_verified !== true) {
      throw new UnauthorizedException({ error: "email_not_verified" });
    }

    const user = await this.resolveAccount(issuer, subject, email.toLowerCase());
    const accessToken = await this.jwt.signAsync({ sub: user.id, email: user.email });
    return { accessToken, userId: user.id, email: user.email };
  }

  /**
   * Map a verified `(issuer, subject)` onto an account, creating one if needed.
   *
   * The identity is the pair — never the email (doc 06 §6.7: keys bind to `userId`, not
   * email). So an address changing at the IdP follows the same account, and two issuers
   * asserting one address stay two accounts.
   */
  private async resolveAccount(issuer: string, subject: string, email: string): Promise<UserEntity> {
    const bound = await this.users.findOne({ where: { oidcIssuer: issuer, oidcSubject: subject } });
    if (bound) {
      // The IdP is authoritative for the address; follow a change without touching keys.
      if (bound.email !== email || !bound.emailVerified) {
        bound.email = email;
        bound.emailVerified = true;
        await this.users.save(bound);
      }
      return bound;
    }

    const byEmail = await this.users.findOne({ where: { email } });
    if (byEmail) {
      if (byEmail.oidcIssuer !== null) {
        // Same address, a different verified identity — two people, or an IdP that recycles
        // addresses. Never silently merge: that hands one the other's vaults.
        throw new ConflictException({ error: "email_bound_to_other_identity" });
      }
      if (!this.oidc.adoptUnbound) {
        // An unbound row is what the gated dev-login creates. Adopting it by default would
        // re-open the takeover this endpoint exists to close.
        throw new ConflictException({ error: "email_exists_unbound" });
      }
      byEmail.oidcIssuer = issuer;
      byEmail.oidcSubject = subject;
      byEmail.emailVerified = true;
      return this.users.save(byEmail);
    }

    return this.users.save(
      this.users.create({ email, oidcIssuer: issuer, oidcSubject: subject, emailVerified: true }),
    );
  }
}

/** Decode a compact JWS payload's `iss` without verifying. Selection only — never trust. */
function unverifiedIssuer(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")) as {
      iss?: unknown;
    };
    return typeof payload.iss === "string" && payload.iss.length > 0 ? payload.iss : null;
  } catch {
    return null;
  }
}
