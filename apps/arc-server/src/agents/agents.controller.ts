import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser, type CurrentUserData } from "../auth/current-user.decorator";
import { AgentsService } from "./agents.service";
import { AuthorizeAgentDto, CreateDelegationDto, RegisterAgentDto, UpdateAgentDto } from "./dto";

/**
 * Engine-C agent + delegation management (ADR-005). Every route here is owner/delegator
 * authenticated with the normal user JWT — this is the *control plane* for agents, not the
 * agent's own data path. (The agent's authenticated action path arrives with signed intent
 * in Phase 3; v1 deliberately ships no bearer-token agent credential.)
 */
@UseGuards(JwtAuthGuard)
@Controller("vault/agents")
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  register(@CurrentUser() u: CurrentUserData, @Body() dto: RegisterAgentDto) {
    return this.agents.register(u.userId, dto);
  }

  @Get()
  list(@CurrentUser() u: CurrentUserData) {
    return this.agents.list(u.userId);
  }

  @Get(":id")
  get(@CurrentUser() u: CurrentUserData, @Param("id") id: string) {
    return this.agents.get(u.userId, id);
  }

  @Patch(":id")
  update(@CurrentUser() u: CurrentUserData, @Param("id") id: string, @Body() dto: UpdateAgentDto) {
    return this.agents.update(u.userId, id, dto);
  }

  @Post(":id/delegations")
  createDelegation(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Body() dto: CreateDelegationDto,
  ) {
    return this.agents.createDelegation(u.userId, id, dto);
  }

  @Get(":id/delegations")
  listDelegations(@CurrentUser() u: CurrentUserData, @Param("id") id: string) {
    return this.agents.listDelegations(u.userId, id);
  }

  @Delete(":id/delegations/:delegationId")
  revokeDelegation(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Param("delegationId") delegationId: string,
  ) {
    return this.agents.revokeDelegation(u.userId, id, delegationId);
  }

  /**
   * Introspect the effective-authority decision for this agent (delegation ∩ delegator ∩
   * agent ceilings). Owner-only — it reveals what the agent could do. Read-only; does not
   * consume the delegation's call budget.
   */
  @Post(":id/authorize")
  async authorize(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Body() dto: AuthorizeAgentDto,
  ) {
    // Ownership check (throws 404 to non-owners) before exposing any decision.
    await this.agents.get(u.userId, id);
    return this.agents.authorize(id, {
      path: dto.path,
      capability: dto.capability,
      ...(dto.delegationId !== undefined ? { delegationId: dto.delegationId } : {}),
    });
  }
}
