import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

export interface CurrentUserData {
  userId: number;
  email: string;
  /**
   * Set when the bearer is an *agent* token (Engine-C, ADR-005): the acting agent's id.
   * `userId` then carries the agent's owner (the human authority behind it), and `actSub`
   * is the RFC 8693 `act` subject (`agent:<id>`). Absent for ordinary user sessions.
   */
  agentId?: string;
  /** RFC 8693 token-exchange `act.sub` — who is acting on the owner's behalf. */
  actSub?: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserData => {
    const req = ctx.switchToHttp().getRequest<{ user: CurrentUserData }>();
    return req.user;
  },
);
