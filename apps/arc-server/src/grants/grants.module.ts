import { Global, Logger, Module } from "@nestjs/common";
import type { DefaultMode } from "@arc/grants";
import { CapabilityGuard } from "./capability.guard";
import { GRANTS_DEFAULT_MODE, GrantsService } from "./grants.service";

/**
 * Read `ARC_DEFAULT_POLICY` once at boot. `"allow"` (the default) keeps dev/test working
 * while ACL admin tooling lands; production deployments should set `"deny"` once they have
 * the policy bootstrap they need.
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
 * right level — global APP_GUARD runs *before* controller-level JwtAuthGuard, so the
 * capability guard wouldn't see `req.user` if it ran globally. Per-controller `@UseGuards`
 * respects the listed order, so JwtAuthGuard populates `req.user` before CapabilityGuard
 * looks for it.
 */
@Global()
@Module({
  providers: [
    { provide: GRANTS_DEFAULT_MODE, useFactory: buildDefaultMode },
    GrantsService,
    CapabilityGuard,
  ],
  exports: [GrantsService, CapabilityGuard],
})
export class GrantsModule {}
