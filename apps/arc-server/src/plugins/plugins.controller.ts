import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CapabilityGuard } from "../grants/capability.guard";
import { PluginsService } from "./plugins.service";

/**
 * Read-only listing of the registered plugins. Out-of-band registration (POST/DELETE)
 * lives in `PluginsService.mountSecretsPlugin` for now — programmatic from arc-server's
 * own boot path. An admin-facing HTTP API for runtime mount/unmount lands when we wire
 * the @arc/grants ACL so we know who's allowed to do that.
 */
@UseGuards(JwtAuthGuard, CapabilityGuard)
@Controller("v1/sys/plugins")
export class PluginsController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  list() {
    return {
      data: this.plugins.list().map(({ meta, mount }) => ({
        name: meta.name,
        version: meta.version,
        kind: meta.kind,
        description: meta.description,
        mount,
      })),
    };
  }
}
