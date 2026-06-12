import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { VaultAgentEntity } from "../database/entities";
import { JWT_SECRET } from "./jwt.constants";
import type { CurrentUserData } from "./current-user.decorator";

interface JwtPayload {
  sub: number;
  email: string;
  /** Engine-C agent token (ADR-005): the acting agent's id + RFC 8693 `act` claim. */
  agentId?: string;
  /**
   * HIGH-C (audit): the `vault_agents.tokenEpoch` value at the moment this JWT was
   * minted. `validate()` looks up the current row value and refuses the request with
   * `agent_token_revoked` on mismatch — that's how closing a task (or any future
   * revocation event) invalidates outstanding agent JWTs without waiting for the TTL.
   */
  agentTokenEpoch?: number;
  act?: { sub: string };
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(VaultAgentEntity)
    private readonly agents: Repository<VaultAgentEntity>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: JWT_SECRET,
    });
  }

  async validate(payload: JwtPayload): Promise<CurrentUserData> {
    // HIGH-C (audit): per-agent revocation. Only check when the JWT is actually an
    // agent token (`agentId` set). Tokens minted before this migration carry no
    // `agentTokenEpoch`; default both sides to 0 so they keep working until natural
    // TTL — the freshly-minted next token gets the post-migration epoch automatically.
    if (payload.agentId !== undefined) {
      const agent = await this.agents.findOne({
        where: { id: payload.agentId },
        select: ["id", "status", "tokenEpoch"],
      });
      if (!agent || agent.status !== "active") {
        throw new UnauthorizedException({ error: "agent_token_revoked", reason: "agent_inactive" });
      }
      const tokenEpoch = payload.agentTokenEpoch ?? 0;
      if (tokenEpoch !== agent.tokenEpoch) {
        throw new UnauthorizedException({
          error: "agent_token_revoked",
          reason: "epoch_mismatch",
          // The values are intentionally NOT echoed — telling the client which epoch the
          // server is on would help an attacker probe revocation state. The client just
          // needs to re-auth via /vault/agents/:id/auth/challenge to get a fresh token.
        });
      }
    }
    return {
      userId: payload.sub,
      email: payload.email,
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      ...(payload.agentTokenEpoch !== undefined ? { agentTokenEpoch: payload.agentTokenEpoch } : {}),
      ...(payload.act?.sub ? { actSub: payload.act.sub } : {}),
    };
  }
}
