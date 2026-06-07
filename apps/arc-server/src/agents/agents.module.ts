import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  VaultAgentEntity,
  VaultAgentIntentEntity,
  VaultAgentTaskEntity,
  VaultAuditLogEntity,
  VaultDelegationEntity,
  VaultUserKeysEntity,
} from "../database/entities";
import { EnginesModule } from "../engines/engines.module";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { AgentTasksService } from "./agent-tasks.service";

/**
 * Engine-C — agentic identity (ADR-005). Owns the agent principal + signed delegation
 * control plane (Phase 1+2) and the signed-intent task chain (Phase 3). `GrantsService`
 * (the policy engine) is `@Global`, so the effective-scope intersection resolves agent and
 * delegator ceilings without re-importing `GrantsModule`. `EnginesModule` is imported for
 * its shared `ENGINES_CONFIG.leases` registry — closing a task cascade-revokes the leases
 * tagged with its id.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      VaultAgentEntity,
      VaultDelegationEntity,
      VaultAgentTaskEntity,
      VaultAgentIntentEntity,
      VaultUserKeysEntity,
      VaultAuditLogEntity,
    ]),
    EnginesModule,
  ],
  controllers: [AgentsController],
  providers: [AgentsService, AgentTasksService],
  exports: [AgentsService, AgentTasksService],
})
export class AgentsModule {}
