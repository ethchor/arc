import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { GrantsModule } from "../grants/grants.module";
import { PluginsAdminController } from "./plugins-admin.controller";

/**
 * Hosts the runtime plugin mount/unmount admin API (ADR-009). Lives in its own module —
 * **without** importing `PluginsModule` or `EnginesModule` — so its controller's routes
 * register ahead of `EnginesController`'s `/v1/*` wildcard catch-all (the same trick
 * `AuthMethodsModule` uses for `/v1/auth/<mount>/login`).
 *
 * `PluginsService` is reachable here because `PluginsModule` is marked `@Global()`. The
 * `AuthModule` + `GrantsModule` imports give `JwtAuthGuard` + `CapabilityGuard` their
 * own providers. The controller still must be listed in `AppModule.imports` **before**
 * `EnginesModule` for the route precedence to hold.
 */
@Module({
  imports: [AuthModule, GrantsModule],
  controllers: [PluginsAdminController],
})
export class PluginsAdminModule {}
