import { ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { Repository } from "typeorm";
import { UserEntity } from "../database/entities";

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
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly jwt: JwtService,
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
}
