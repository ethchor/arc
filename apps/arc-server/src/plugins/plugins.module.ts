import { Global, Module } from "@nestjs/common";
import { EnginesModule } from "../engines/engines.module";
import { PluginManifestService } from "./plugin-manifest.service";
import { PluginsController } from "./plugins.controller";
import { PluginsService } from "./plugins.service";

/**
 * Plugin host module. Reuses {@link EnginesModule}'s ENGINES_CONFIG so plugin mounts
 * land in the same `MountRegistry` + `enginesByMount` map that drives `/v1/*` dispatch
 * — no parallel routing layer.
 *
 * `@Global()` so {@link PluginsService} is reachable from `PluginsAdminModule` without
 * that module needing to import `PluginsModule` (which would transitively pull
 * `EnginesModule` and demote `PluginsAdminController`'s routes behind the engines
 * wildcard — see ADR-009 §2 / the comment in `plugins-admin.module.ts`).
 */
@Global()
@Module({
  imports: [EnginesModule],
  controllers: [PluginsController],
  providers: [PluginsService, PluginManifestService],
  exports: [PluginsService],
})
export class PluginsModule {}
