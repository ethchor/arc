import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser, type CurrentUserData } from "../auth/current-user.decorator";
import { WorkflowsService } from "./workflows.service";
import { WorkflowExecutorService } from "./workflow-executor.service";
import { SimulateWorkflowDto, UpsertWorkflowDto } from "./dto";
import type { EvaluationContext, WorkflowDefinition } from "@arc/workflows";

/**
 * REST surface for vault-scoped workflow definitions. All endpoints require an
 * authenticated user; the service layer enforces admin+ role per vault.
 *
 * Routes
 *  - GET    /vaults/:vaultId/workflows                     list
 *  - GET    /vaults/:vaultId/workflows/:id                 detail
 *  - POST   /vaults/:vaultId/workflows                     create
 *  - PUT    /vaults/:vaultId/workflows/:id                 update (optimistic concurrency)
 *  - DELETE /vaults/:vaultId/workflows/:id                 delete
 *  - POST   /vaults/:vaultId/workflows/validate            validate without persisting
 *  - POST   /vaults/:vaultId/workflows/:id/simulate        simulate against synthetic context
 */
@UseGuards(JwtAuthGuard)
@Controller("vaults/:vaultId/workflows")
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly executor: WorkflowExecutorService,
  ) {}

  @Get()
  list(@CurrentUser() u: CurrentUserData, @Param("vaultId", ParseUUIDPipe) vaultId: string) {
    return this.workflows.list(u.userId, vaultId);
  }

  @Get(":id")
  get(
    @CurrentUser() u: CurrentUserData,
    @Param("vaultId", ParseUUIDPipe) vaultId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.workflows.get(u.userId, vaultId, id);
  }

  @Post()
  create(
    @CurrentUser() u: CurrentUserData,
    @Param("vaultId", ParseUUIDPipe) vaultId: string,
    @Body() dto: UpsertWorkflowDto,
  ) {
    return this.workflows.create(u.userId, vaultId, dto);
  }

  @Put(":id")
  update(
    @CurrentUser() u: CurrentUserData,
    @Param("vaultId", ParseUUIDPipe) vaultId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpsertWorkflowDto,
  ) {
    return this.workflows.update(u.userId, vaultId, id, dto);
  }

  @Delete(":id")
  remove(
    @CurrentUser() u: CurrentUserData,
    @Param("vaultId", ParseUUIDPipe) vaultId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.workflows.remove(u.userId, vaultId, id);
  }

  /** Validate without persisting. No auth check beyond the JWT guard — pure pure pure. */
  @Post("validate")
  validate(@Body() body: { definition: unknown }) {
    return this.workflows.validate(body?.definition);
  }

  /**
   * Simulate the saved workflow against an editor-supplied synthetic context. Returns the
   * full decision + trace so the editor can highlight which path the evaluator walked.
   */
  @Post(":id/simulate")
  async simulate(
    @CurrentUser() u: CurrentUserData,
    @Param("vaultId", ParseUUIDPipe) vaultId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SimulateWorkflowDto,
  ) {
    const row = await this.workflows.get(u.userId, vaultId, id);
    const def = row.definition as unknown as WorkflowDefinition;
    const ctx: EvaluationContext = {
      trigger: { kind: "request_access" },
      mountPath: dto.mountPath,
      capability: dto.capability ?? "read",
      requesterRole: dto.requesterRole ?? null,
      requesterGroups: dto.requesterGroups ?? [],
      mfaAgeSeconds: dto.mfaAgeSeconds ?? null,
      now: new Date(),
    };
    return { decision: this.executor.simulate(def, ctx) };
  }
}
