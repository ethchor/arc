import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  VaultAuditLogEntity,
  VaultMembershipEntity,
  VaultWorkflowEntity,
} from "../database/entities";
import { AuthModule } from "../auth/auth.module";
import { WorkflowsController } from "./workflows.controller";
import { WorkflowsService } from "./workflows.service";
import { WorkflowExecutorService } from "./workflow-executor.service";

/**
 * Vault-scoped workflow definitions + the read-only executor that runs them against
 * incoming requests. Exports `WorkflowExecutorService` so AgentsModule can inject it
 * into `AgentTasksService` (workflow decision short-circuits the elevated-intent
 * approval gate).
 *
 * `GrantsService` is `@Global` so no explicit import here; we receive it via
 * `@Optional()` in the executor to keep unit tests easy.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([VaultWorkflowEntity, VaultMembershipEntity, VaultAuditLogEntity]),
    AuthModule,
  ],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowExecutorService],
  exports: [WorkflowsService, WorkflowExecutorService],
})
export class WorkflowsModule {}
