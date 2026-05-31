import type {
  AuthPlugin,
  Capability,
  Plugin,
  PluginKind,
  PluginMeta,
  Scope,
  SecretsPlugin,
  StoragePlugin,
} from "./types";

export class PluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginError";
  }
}

/**
 * In-process registry of plugins. arc-server loads plugins (as sandboxed modules, or
 * out-of-process over gRPC) and registers them here.
 *
 * Security invariant: the host NEVER hands a plugin the Engine-B master key. A plugin only ever
 * sees its own configuration plus the scoped capabilities the caller grants it.
 */
export class PluginHost {
  private readonly plugins = new Map<string, Plugin>();

  register(plugin: Plugin): void {
    const { name } = plugin.meta;
    if (this.plugins.has(name)) throw new PluginError(`plugin already registered: ${name}`);
    this.plugins.set(name, plugin);
  }

  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  list(kind?: PluginKind): PluginMeta[] {
    const metas: PluginMeta[] = [];
    for (const plugin of this.plugins.values()) {
      if (!kind || plugin.meta.kind === kind) metas.push(plugin.meta);
    }
    return metas;
  }

  getSecrets(name: string): SecretsPlugin {
    return this.expect(name, "secrets") as SecretsPlugin;
  }

  getAuth(name: string): AuthPlugin {
    return this.expect(name, "auth") as AuthPlugin;
  }

  getStorage(name: string): StoragePlugin {
    return this.expect(name, "storage") as StoragePlugin;
  }

  private expect(name: string, kind: PluginKind): Plugin {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new PluginError(`no plugin registered: ${name}`);
    if (plugin.meta.kind !== kind) {
      throw new PluginError(`plugin ${name} is "${plugin.meta.kind}", expected "${kind}"`);
    }
    return plugin;
  }
}

/**
 * True if `scopes` permit `capability` on `path`. A scope matches when its (trailing-slash)
 * prefix covers the path; `sudo` implies every capability.
 */
export function scopeAllows(
  scopes: readonly Scope[],
  path: string,
  capability: Capability,
): boolean {
  const probe = `${path.replace(/^\/+/, "")}/`;
  return scopes.some(
    (scope) =>
      probe.startsWith(scope.pathPrefix) &&
      (scope.capabilities.includes(capability) || scope.capabilities.includes("sudo")),
  );
}
