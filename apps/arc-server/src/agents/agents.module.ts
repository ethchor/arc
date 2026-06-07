import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  VaultAgentEntity,
  VaultAgentIntentEntity,
  VaultAgentTaskEntity,
  VaultAuditLogEntity,
  VaultDelegationEntity,
  VaultPendingApprovalEntity,
  VaultUserKeysEntity,
} from "../database/entities";
import { EnginesModule } from "../engines/engines.module";
import { VaultModule } from "../vault/vault.module";
import { AgentsController, ApprovalsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { AgentTasksService } from "./agent-tasks.service";
import { ApprovalsService } from "./approvals.service";
import { AttestationService } from "./attestation";

/**
 * Engine-C — agentic identity (ADR-005). Owns the agent principal + signed delegation
 * (Phase 1+2), the signed-intent task chain (Phase 3), and push-consent approvals (Phase 4).
 * `GrantsService` is `@Global` (effective-scope intersection). `EnginesModule` is imported
 * for the shared `ENGINES_CONFIG.leases` registry (task-close lease cascade); `VaultModule`
 * for `PasskeyService` (reused as the WebAuthn proof-of-control for approvals).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      VaultAgentEntity,
      VaultDelegationEntity,
      VaultAgentTaskEntity,
      VaultAgentIntentEntity,
      VaultPendingApprovalEntity,
      VaultUserKeysEntity,
      VaultAuditLogEntity,
    ]),
    EnginesModule,
    VaultModule,
  ],
  controllers: [AgentsController, ApprovalsController],
  providers: [AgentsService, AgentTasksService, ApprovalsService, AttestationService],
  exports: [AgentsService, AgentTasksService, ApprovalsService],
})
export class AgentsModule {}
