import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
  ValidationPipe,
} from "@nestjs/common";
import { IsOptional, IsString, Matches } from "class-validator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CapabilityGuard, RequireCapability } from "../grants/capability.guard";
import { buildRemoteProcessSpec, resolveMountFiles, type PluginMountSpec } from "./plugin-mounts";
import { PluginsService } from "./plugins.service";

/**
 * Mount one plugin at runtime. Shape mirrors `PluginMountSpec` so the same files an
 * operator stages for `ARC_PLUGIN_MOUNTS` can be re-used verbatim — no second
 * representation, no drift between boot-time and admin-API paths.
 */
class CreatePluginMountDto {
  /** Mount path the plugin's `/v1/<mount>/...` routes attach under. Must end with `/`. */
  @IsString()
  @Matches(/^[A-Za-z0-9._/-]+\/$/, {
    message: "mountPath must contain only [A-Za-z0-9._/-] and end with /",
  })
  mountPath!: string;

  /** Absolute path to the plugin executable (e.g. the OOP `bin.cjs`). */
  @IsString()
  @Matches(/^\//, { message: "binPath must be absolute" })
  binPath!: string;

  /** Optional absolute path to the signed manifest JSON. */
  @IsOptional()
  @IsString()
  @Matches(/^\//, { message: "manifestPath must be absolute" })
  manifestPath?: string;

  /** Optional absolute path to the plugin's `configure()` config JSON. */
  @IsOptional()
  @IsString()
  @Matches(/^\//, { message: "configPath must be absolute" })
  configPath?: string;
}

/**
 * Runtime admin API for plugin mount/unmount. The behaviour is the same as the
 * boot-time auto-mount path (`ARC_PLUGIN_MOUNTS` → {@link PluginsService.onApplicationBootstrap})
 * — manifest gate runs identically, refusal reasons surface verbatim — only the trigger
 * is HTTP instead of the boot lifecycle.
 *
 * Authorization: both endpoints sit under `sys/plugins/` and require `sudo` capability on
 * that prefix (see ADR-009 §2). The seeded `root` policy attached to `ARC_ROOT_USERS`
 * already grants this; non-root operators delegate the `plugin-admin` policy explicitly.
 *
 * Lifecycle: a plugin mounted via this API does **not** survive restart. The response
 * includes a copy-paste-ready `envSnippet` so the admin can add it to `ARC_PLUGIN_MOUNTS`
 * once a smoke-test confirms the mount is good.
 */
// LOW-E (audit): ADR-009 §2 specified `sudo` on `sys/plugins/`; before this the guard
// derived `create`/`delete` from the HTTP verb. Pinning it declaratively closes the gap
// between the doc and the policy decision (a subject granted `create` on `sys/plugins/`
// no longer accidentally satisfies "I have plugin admin rights").
@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapability("sudo")
@Controller("v1/sys/plugins/mounts")
export class PluginsAdminController {
  constructor(private readonly plugins: PluginsService) {}

  @Post()
  async mount(
    @Body(new ValidationPipe({ transform: true, whitelist: true })) dto: CreatePluginMountDto,
  ) {
    const spec: PluginMountSpec = {
      mountPath: dto.mountPath,
      artifactPath: dto.binPath,
      ...(dto.manifestPath ? { manifestPath: dto.manifestPath } : {}),
      ...(dto.configPath ? { configPath: dto.configPath } : {}),
    };

    // Resolve manifest + config from disk. ENOENT / bad JSON surface as 400 with the
    // upstream error string preserved — same posture the boot path takes.
    let manifest, config;
    try {
      ({ manifest, config } = await resolveMountFiles(spec));
    } catch (err) {
      throw new BadRequestException({ errors: [(err as Error).message], reason: "mount_files_unreadable" });
    }
    const remoteSpec = buildRemoteProcessSpec(spec);

    let mounted;
    try {
      mounted = await this.plugins.mountRemoteSecretsPlugin(remoteSpec, spec.mountPath, config, manifest);
    } catch (err) {
      // PluginsService surfaces conflicts (`plugin already registered`, mount-path in
      // use) and gate refusals with the same exception class. Distinguish by reason so
      // the HTTP status matches the operator's mental model:
      //   - conflict → 409 (the request itself is fine, the world isn't ready for it)
      //   - everything else (gate refusal, spawn failure, bad caps) → 400 (the request
      //     itself was rejected by the gate/host)
      const e = err as { response?: { reason?: string; errors?: string[] }; message?: string };
      const reason = e.response?.reason ?? "unknown";
      const conflict = reason === "plugin_already_registered" ||
        (e.response?.errors ?? []).some((s) => /already registered|already mounted/.test(s));
      const body = e.response ?? { errors: [e.message ?? String(err)], reason };
      throw conflict ? new ConflictException(body) : new BadRequestException(body);
    }

    return {
      data: {
        name: mounted.meta.name,
        version: mounted.meta.version,
        mountPath: mounted.mount,
        ...(mounted.meta.description ? { description: mounted.meta.description } : {}),
        // The manifest gate stores declared caps on enginesByMount; surface them on the
        // response so the admin can write a matching grants policy without a second call.
        declaredCapabilities: declaredCapsFor(this.plugins, mounted.mount),
        envSnippet: buildEnvSnippet(spec),
      },
    };
  }

  /**
   * Unmount the plugin at the given mount path. The path segment is URL-decoded by
   * Nest so a client sends `aws/` as `aws%2F`. 204 on success, 404 if nothing is
   * mounted at the supplied path.
   *
   * NB the `*splat` pattern is needed because path-to-regexp v8 (Express 5 / Nest 11)
   * won't accept a route parameter containing a literal `/` even after URL decoding —
   * we accept the whole tail of the URL and normalize it server-side.
   */
  @Delete("*splat")
  @HttpCode(204)
  async unmount(@Param("splat") splat: string[] | string): Promise<void> {
    const mountPath = normalizeMountPath(splat);
    const name = findPluginNameByMount(this.plugins, mountPath);
    if (!name) {
      throw new NotFoundException({ errors: [`no plugin mounted at ${mountPath}`], reason: "mount_not_found" });
    }
    await this.plugins.unmount(name);
  }
}

/** Normalize the captured path: ensure trailing `/`, strip any duplicate slashes. */
function normalizeMountPath(splat: string[] | string): string {
  const raw = Array.isArray(splat) ? splat.join("/") : splat;
  const cleaned = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return `${cleaned}/`;
}

/** Reverse-lookup helper using the public `list()` surface — no service edit. */
function findPluginNameByMount(plugins: PluginsService, mountPath: string): string | null {
  return plugins.list().find((m) => m.mount === mountPath)?.meta.name ?? null;
}

/** Pull the manifest-declared cap set for a mount path; undefined when none was pinned. */
function declaredCapsFor(plugins: PluginsService, mountPath: string): readonly string[] | undefined {
  const pinned = plugins.declaredCapabilitiesFor(mountPath);
  return pinned ? [...pinned].sort() : undefined;
}

/** Construct the `ARC_PLUGIN_MOUNTS` entry for an admin mount, for copy-paste persistence. */
function buildEnvSnippet(spec: PluginMountSpec): string {
  const params: string[] = [];
  if (spec.manifestPath) params.push(`manifest=${spec.manifestPath}`);
  if (spec.configPath) params.push(`config=${spec.configPath}`);
  return params.length === 0
    ? `${spec.mountPath}=${spec.artifactPath}`
    : `${spec.mountPath}=${spec.artifactPath}?${params.join("&")}`;
}
