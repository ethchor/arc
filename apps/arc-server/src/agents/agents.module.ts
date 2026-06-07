import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  VaultAgentEntity,
  VaultAuditLogEntity,
  VaultDelegationEntity,
  VaultUserKeysEntity,
} from "../database/entities";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";

/**
 * Engine-C — agentic identity (ADR-005). Owns the agent principal + signed delegation
 * control plane. `GrantsService` (the policy engine) is `@Global`, so the effective-scope
 * intersection resolves an agent's and a delegator's ceilings without re-importing
 * `GrantsModule` here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      VaultAgentEntity,
      VaultDelegationEntity,
      VaultUserKeysEntity,
      VaultAuditLogEntity,
    ]),
  ],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
