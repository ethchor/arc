import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { type AuthPlugin, PluginHost, type PluginMeta } from "@arc/plugin-sdk";

export interface MountedAuthMethod {
  meta: PluginMeta;
  /** `auth/<segment>/` — the path `POST /v1/auth/<segment>/login` targets. */
  mount: string;
}

/**
 * Registry + runtime for auth-method plugins (OIDC, Kubernetes, …). Deliberately independent
 * of the secrets-engine `PluginsService`/`EnginesModule`: auth methods don't join the
 * `MountRegistry` (`/v1/*` dispatch) — they answer `POST /v1/auth/<mount>/login`. Keeping this
 * service free of the engine config also lets {@link AuthMethodsModule} be registered *before*
 * `EnginesModule`, so its login route is matched ahead of the engines `/v1/*` catch-all.
 *
 * Security invariant (inherited from {@link PluginHost}): a plugin only ever sees its own
 * config + the scoped capabilities a login grants — never the Engine-B master key.
 */
@Injectable()
export class AuthMethodsService {
  private readonly logger = new Logger(AuthMethodsService.name);
  private readonly host = new PluginHost();
  /** mount segment (e.g. "oidc") → plugin. */
  private readonly byMount = new Map<string, AuthPlugin>();
  /** plugin name → mount segment, for unmount/list. */
  private readonly mountByName = new Map<string, string>();

  /**
   * Register + configure + mount an auth method at `mount` (path segment, e.g. "oidc"; a
   * leading `auth/` is tolerated). `configure` is awaited before the mount becomes resolvable
   * so a bad config never leaves a half-mounted method answering logins.
   */
  async mount(plugin: AuthPlugin, mount: string, config: unknown = {}): Promise<MountedAuthMethod> {
    const segment = normalizeSegment(mount);
    if (segment.length === 0) throw new BadRequestException({ errors: ["auth mount path is empty"] });
    if (this.host.has(plugin.meta.name)) {
      throw new BadRequestException({ errors: [`auth method already registered: ${plugin.meta.name}`] });
    }
    if (this.byMount.has(segment)) {
      throw new BadRequestException({ errors: [`auth method already mounted at "auth/${segment}/"`] });
    }
    try {
      await plugin.configure(config);
    } catch (err) {
      throw new BadRequestException({
        errors: [`auth method ${plugin.meta.name} rejected configure: ${(err as Error).message}`],
      });
    }
    this.host.register(plugin);
    this.byMount.set(segment, plugin);
    this.mountByName.set(plugin.meta.name, segment);
    this.logger.log(`mounted auth method ${plugin.meta.name} at auth/${segment}/`);
    return { meta: plugin.meta, mount: `auth/${segment}/` };
  }

  /** Resolve the auth method mounted at `mount` (path segment), if any. */
  resolve(mount: string): AuthPlugin | undefined {
    return this.byMount.get(normalizeSegment(mount));
  }

  list(): MountedAuthMethod[] {
    return this.host.list("auth").map((meta) => ({
      meta,
      mount: `auth/${this.mountByName.get(meta.name) ?? ""}/`,
    }));
  }

  /** Tear down a mounted auth method. Idempotent — true if anything was removed. */
  async unmount(name: string): Promise<boolean> {
    const segment = this.mountByName.get(name);
    if (segment === undefined) return false;
    this.byMount.delete(segment);
    this.mountByName.delete(name);
    this.host.unregister(name);
    this.logger.log(`unmounted auth method ${name} from auth/${segment}/`);
    return true;
  }
}

/** Bare mount segment: strips surrounding slashes + an `auth/` prefix. */
function normalizeSegment(mount: string): string {
  return mount.replace(/^\/+|\/+$/g, "").replace(/^auth\//, "");
}
