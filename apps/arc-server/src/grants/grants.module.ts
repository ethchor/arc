import { Global, Logger, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import type { DefaultMode } from "@arc/grants";
import { PolicyAttachmentEntity, PolicyEntity } from "../database/entities";
import { CapabilityGuard } from "./capability.guard";
import { GrantsController } from "./grants.controller";
import { GRANTS_DEFAULT_MODE, GrantsService, POLICY_STORE } from "./grants.service";
import { TypeOrmPolicyStore } from "./typeorm-policy-store";

/**
 * Read `ARC_DEFAULT_POLICY` once at boot. `"allow"` (the default) keeps dev/test working
 * while ACL admin tooling lands; production deployments should set `"deny"` once they have
 * the policy bootstrap they need (see `ARC_ROOT_USERS`).
 */
export function buildDefaultMode(): DefaultMode {
  const raw = (process.env.ARC_DEFAULT_POLICY ?? "allow").toLowerCase();
  if (raw === "deny") return "deny";
  if (raw !== "allow") {
    new Logger("GrantsModule").warn(
      `ARC_DEFAULT_POLICY=${raw} is not 'allow' or 'deny'; defaulting to 'allow'`,
    );
  }
  return "allow";
}

/**
 * `@Global` so the engines + plugins controllers can `@UseGuards(JwtAuthGuard,
 * CapabilityGuard)` without re-importing this module. Per-controller registration is the
 * right level — a global `APP_GUARD` would run *before* the controller-level `JwtAuthGuard`,
 * so the capability guard wouldn't see `req.user`. `@UseGuards` respects the listed order,
 * so `JwtAuthGuard` populates `req.user` before `CapabilityGuard` reads it.
 *
 * `POLICY_STORE` resolves to the Postgres-backed {@link TypeOrmPolicyStore}; swapping in a
 * different store (or a caching decorator) is a one-line change here.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PolicyEntity, PolicyAttachmentEntity])],
  controllers: [GrantsController],
  providers: [
    { provide: GRANTS_DEFAULT_MODE, useFactory: buildDefaultMode },
    { provide: POLICY_STORE, useClass: TypeOrmPolicyStore },
    GrantsService,
    CapabilityGuard,
  ],
  exports: [GrantsService, CapabilityGuard],
})
export class GrantsModule {}
