import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { AGENT_TOKEN_ALLOWED_KEY } from "./agent-token-allowed.decorator";

/**
 * JWT auth guard with one extra step beyond the stock passport-jwt: after Passport
 * resolves the bearer to a `req.user`, if the token is an **agent** token (carries
 * `agentId` per ADR-005) the guard requires the route to be explicitly marked
 * {@link AgentTokenAllowed}. Without that marker, the request is refused 403.
 *
 * The CRIT this closes (audit: human→agent→action trust chain): agent tokens are minted
 * with `sub = ownerUserId`, so before this fix they carried the owner's authority on
 * every endpoint. A holder of the agent's signing key could mint a token and then call
 * `POST /vaults`, `POST /v1/secret/data/*`, `POST /v1/sys/plugins/mounts`, even register
 * a second backdoor agent — bypassing the whole Engine-C delegation / intent / CIBA /
 * budget machinery (which lives inside `submitIntent`, the only path designed for an
 * agent to act). The guard now enforces "agent tokens only reach paths designed for
 * agent self-action"; everything else is the owner's job.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // 1. Standard Passport-JWT validation. Throws if missing/expired/invalid bearer.
    const ok = (await super.canActivate(ctx)) as boolean;
    if (!ok) return false;

    // 2. If the token authenticated an *agent*, enforce the route allowlist.
    const req = ctx.switchToHttp().getRequest<{ user?: { agentId?: string } }>();
    if (req.user?.agentId === undefined) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(AGENT_TOKEN_ALLOWED_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (allowed) return true;

    throw new ForbiddenException({
      error: "agent_token_off_intent_path",
      message:
        "agent tokens may only reach routes explicitly annotated @AgentTokenAllowed() " +
        "(today: POST /vault/agents/:id/intents). Use the owner's session to drive any " +
        "other action.",
    });
  }
}
