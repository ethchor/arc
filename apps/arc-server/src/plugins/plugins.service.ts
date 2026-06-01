import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { PluginError, PluginHost, type Plugin, type PluginMeta, type SecretsPlugin } from "@arc/plugin-sdk";
import { ENGINES_CONFIG, type EnginesConfig } from "../engines/engines.service";
import { PluginSecretsEngine } from "./plugin-secrets-engine";

/**
 * Where a plugin is mounted in the engine surface. The plugin's name is the global handle
 * inside {@link PluginHost}; the mount path is how requests at `/v1/<mount>/...` reach it.
 */
export interface MountedPlugin {
  meta: PluginMeta;
  mount: string;
}

/**
 * In-process plugin host runtime. Owns a {@link PluginHost} registry and exposes
 * `registerSecretsPlugin` / `mountSecretsPlugin` for runtime registration.
 *
 * Lifecycle: `register(plugin) → configure(input) → mount(path)`. After mount, the plugin
 * lives in the shared {@link MountRegistry} and any `GET /v1/<mount>/creds/<role>` flows
 * through the {@link PluginSecretsEngine} adapter into the plugin's own `issue/renew/revoke`.
 *
 * Out-of-process plugins (gRPC, WASM) will plug in here later via different SecretsPlugin
 * implementations — the host stays the same; only the transport between this class and the
 * plugin changes.
 */
@Injectable()
export class PluginsService {
  private readonly logger = new Logger(PluginsService.name);
  private readonly host = new PluginHost();
  private readonly mountByName = new Map<string, string>();

  constructor(@Inject(ENGINES_CONFIG) private readonly config: EnginesConfig) {}

  /** Register a plugin without mounting it. Useful when configure() must run first. */
  register(plugin: Plugin): void {
    this.host.register(plugin);
    this.logger.log(`registered plugin: ${plugin.meta.kind}/${plugin.meta.name}`);
  }

  has(name: string): boolean {
    return this.host.has(name);
  }

  /**
   * One-shot helper: register + configure + mount a secrets plugin. `mountPath` must be
   * unique across the {@link MountRegistry}. The plugin's `configure` is awaited before
   * the mount becomes visible so a failure in config doesn't leave an unconfigured plugin
   * answering requests.
   */
  async mountSecretsPlugin(
    plugin: SecretsPlugin,
    mountPath: string,
    config: unknown = {},
  ): Promise<MountedPlugin> {
    if (this.host.has(plugin.meta.name)) {
      throw new BadRequestException({
        errors: [`plugin already registered: ${plugin.meta.name}`],
      });
    }
    try {
      await plugin.configure(config);
    } catch (err) {
      throw new BadRequestException({
        errors: [`plugin ${plugin.meta.name} rejected configure: ${(err as Error).message}`],
      });
    }
    try {
      this.host.register(plugin);
      const engine = new PluginSecretsEngine(plugin, this.config.leases, mountPath);
      this.config.registry.mount({
        path: mountPath,
        type: engine.type,
        description: `${plugin.meta.kind} plugin ${plugin.meta.name}@${plugin.meta.version}`,
      });
      this.config.enginesByMount.set(engine.mount, engine);
      this.mountByName.set(plugin.meta.name, engine.mount);
      this.logger.log(`mounted plugin ${plugin.meta.name} at ${engine.mount}`);
      return { meta: plugin.meta, mount: engine.mount };
    } catch (err) {
      // Roll back the host registration if the mount step blew up — otherwise the plugin
      // is stuck registered but unreachable.
      this.host.unregister(plugin.meta.name);
      if (err instanceof PluginError) {
        throw new BadRequestException({ errors: [err.message] });
      }
      throw err;
    }
  }

  /** List every plugin currently in the host. Each item shows its mount path if mounted. */
  list(): MountedPlugin[] {
    return this.host.list().map((meta) => ({ meta, mount: this.mountByName.get(meta.name) ?? "" }));
  }

  /**
   * Tear down a mount: remove from the registry, drop the engine, revoke every active lease
   * issued by it, then unregister from the host. Idempotent — returns true if anything was
   * removed.
   */
  async unmount(name: string): Promise<boolean> {
    const mount = this.mountByName.get(name);
    if (!mount) return false;
    this.config.leases.revokePrefix(mount);
    this.config.registry.unmount(mount);
    this.config.enginesByMount.delete(mount);
    this.mountByName.delete(name);
    this.host.unregister(name);
    this.logger.log(`unmounted plugin ${name} from ${mount}`);
    return true;
  }
}
