import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { JWT_SECRET } from "./jwt.constants";
import type { CurrentUserData } from "./current-user.decorator";

interface JwtPayload {
  sub: number;
  email: string;
  /** Engine-C agent token (ADR-005): the acting agent's id + RFC 8693 `act` claim. */
  agentId?: string;
  act?: { sub: string };
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: JWT_SECRET,
    });
  }

  validate(payload: JwtPayload): CurrentUserData {
    return {
      userId: payload.sub,
      email: payload.email,
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      ...(payload.act?.sub ? { actSub: payload.act.sub } : {}),
    };
  }
}
