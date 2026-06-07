import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser, type CurrentUserData } from "../auth/current-user.decorator";
import { AgentsService } from "./agents.service";
import { AgentTasksService } from "./agent-tasks.service";
import {
  AuthorizeAgentDto,
  CreateDelegationDto,
  OpenTaskDto,
  RegisterAgentDto,
  SubmitIntentDto,
  UpdateAgentDto,
} from "./dto";

/**
 * Engine-C agent + delegation management (ADR-005). Every route here is owner/delegator
 * authenticated with the normal user JWT — this is the *control plane* for agents, not the
 * agent's own data path. (The agent's authenticated action path arrives with signed intent
 * in Phase 3; v1 deliberately ships no bearer-token agent credential.)
 */
@UseGuards(JwtAuthGuard)
@Controller("vault/agents")
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly tasks: AgentTasksService,
  ) {}

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

  // --- Phase 3: tasks + signed intents (ADR-005) ---

  /** Open a task (the revocable unit + intent-chain anchor). Owner only. */
  @Post(":id/tasks")
  openTask(@CurrentUser() u: CurrentUserData, @Param("id") id: string, @Body() dto: OpenTaskDto) {
    return this.tasks.openTask(u.userId, id, dto);
  }

  @Get(":id/tasks/:taskId")
  getTask(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
    @Query("verify") verify?: string,
  ) {
    return this.tasks.getTask(u.userId, id, taskId, verify === "true" || verify === "1");
  }

  /**
   * Submit a signed intent (the agent's cryptographically-bound action). Authenticated with
   * the owner JWT in v1 (the agent's own credential path is a later pass); the *intent*
   * itself is signed by the agent's key, which is what's actually verified + chained.
   */
  @Post(":id/intents")
  submitIntent(@CurrentUser() _u: CurrentUserData, @Param("id") id: string, @Body() dto: SubmitIntentDto) {
    return this.tasks.submitIntent(id, dto);
  }

  /** Close a task → cascade-revoke its delegations + leases. Owner only. */
  @Post(":id/tasks/:taskId/close")
  closeTask(
    @CurrentUser() u: CurrentUserData,
    @Param("id") id: string,
    @Param("taskId") taskId: string,
  ) {
    return this.tasks.closeTask(u.userId, id, taskId);
  }
}
