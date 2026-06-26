import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import {
  buildWasmtimeSpec,
  PluginError,
  PluginHost,
  RemoteSecretsPlugin,
  type Plugin,
  type PluginMeta,
  type RemoteProcessSpec,
  type SecretsPlugin,
  type WasmPluginSpec,
} from "@arc/plugin-sdk";
import type { PluginArtifactKind, SignedPluginManifest } from "@arc/types";
import { ENGINES_CONFIG, type EnginesConfig } from "../engines/engines.service";
import { PluginManifestService } from "./plugin-manifest.service";
import {
  buildRemoteProcessSpec,
  parsePluginMountsEnv,
  resolveMountFiles,
} from "./plugin-mounts";
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
export class PluginsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PluginsService.name);
  private readonly host = new PluginHost();
  private readonly mountByName = new Map<string, string>();
  /** Remote process handles, keyed by plugin name; closed on unmount() for clean shutdown. */
  private readonly remoteByName = new Map<string, RemoteSecretsPlugin>();

  constructor(
    @Inject(ENGINES_CONFIG) private readonly config: EnginesConfig,
    private readonly manifests: PluginManifestService,
  ) {}

  /**
   * Nest lifecycle hook: after all providers are wired, read `ARC_PLUGIN_MOUNTS` and
   * auto-mount each entry through the standard manifest-gated path. One bad entry doesn't
   * sink the rest — each is mounted independently and failures land in the boot log with
   * the gate's structured reason (so an operator sees "untrusted_publisher at index 2"
   * rather than a server that silently refuses to start).
   */
  async onApplicationBootstrap(): Promise<void> {
    const raw = process.env.ARC_PLUGIN_MOUNTS;
    if (!raw) return;
    const { specs, errors } = parsePluginMountsEnv(raw);
    for (const e of errors) {
      this.logger.warn(`ARC_PLUGIN_MOUNTS[${e.index}] malformed (${e.reason}); skipped: ${e.entry}`);
    }
    for (const spec of specs) {
      try {
        const { manifest, config } = await resolveMountFiles(spec);
        const remoteSpec = buildRemoteProcessSpec(spec);
        const mounted = await this.mountRemoteSecretsPlugin(remoteSpec, spec.mountPath, config, manifest);
        this.logger.log(
          `auto-mounted ${mounted.meta.name}@${mounted.meta.version} at ${mounted.mount} (from ARC_PLUGIN_MOUNTS)`,
        );
      } catch (err) {
        // BadRequestException's response carries the structured reason (manifest gate
        // refusals, spawn failures, etc.). Log it verbatim so the operator can grep.
        const e = err as { response?: { reason?: string; errors?: string[] }; message?: string };
        const reason = e.response?.reason ?? "unknown";
        const msg = e.response?.errors?.join("; ") ?? e.message ?? String(err);
        this.logger.error(
          `ARC_PLUGIN_MOUNTS: failed to mount ${spec.mountPath} from ${spec.artifactPath}: ${reason} (${msg})`,
        );
      }
    }
  }

  /**
   * Verify a plugin manifest against the artifact at `artifactPath` before spawning. Refuses
   * to spawn on signature mismatch, hash mismatch, or untrusted publisher — and on a missing
   * manifest when `ARC_PLUGIN_MANIFEST=required`. The reason is surfaced verbatim so the
   * operator sees *why* (matters for trust-anchor misconfigs in production).
   *
   * Returns the verified manifest's declared capabilities (when present) so the caller can
   * pin them onto the mount for the runtime gate; `undefined` means "no manifest" or
   * "manifest didn't pin capabilities" — both map to "no enforcement" downstream, matching
   * the pre-gate posture.
   */
  private async verifyManifestOrThrow(
    manifest: SignedPluginManifest | undefined,
    artifactPath: string,
    kind: PluginArtifactKind,
  ): Promise<readonly string[] | undefined> {
    const result = await this.manifests.verify(manifest, artifactPath, kind);
    if (!result.ok) {
      throw new BadRequestException({
        errors: [`plugin manifest rejected: ${result.reason}`],
        reason: result.reason,
      });
    }
    if (result.publisher) {
      this.logger.log(
        `plugin manifest verified: publisher=${result.publisher} version=${result.version} ` +
          `sha256-ok caps=${result.capabilities ? `[${result.capabilities.join(",")}]` : "(any)"}`,
      );
    }
    return result.capabilities;
  }

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
    /**
     * Capabilities the plugin's verified manifest declared. `undefined` (or omitted) means
     * "no manifest" / "manifest didn't pin caps" → no runtime enforcement, identical to
     * the pre-gate behaviour. When present, every request against the mount is checked
     * against this set by {@link EnginesService.requirePluginCapability}.
     */
    capabilities?: readonly string[],
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
      // Pin the manifest's declared capability set (if any) onto the mount path. The
      // engine dispatcher reads this map on every request — null/absent ⇒ no gate, which
      // is the same path built-in engines take.
      this.config.manifestCapsByMount.set(
        engine.mount,
        capabilities ? new Set(capabilities) : null,
      );
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

  /**
   * Out-of-process variant of {@link mountSecretsPlugin}. Spawns the plugin in its own
   * child process and wires the same `SecretsPlugin` contract through JSON-RPC over stdio
   * — so the plugin runs sandboxed off the server process (no shared heap, no shared file
   * descriptors beyond stdio, only the env vars the spec lists, killable via SIGTERM).
   *
   * Lifecycle is the same as the in-process flavour: `register → configure → mount`.
   * `unmount(name)` additionally closes the child cleanly.
   */
  async mountRemoteSecretsPlugin(
    spec: RemoteProcessSpec,
    mountPath: string,
    config: unknown = {},
    /**
     * Optional signed manifest pinning the executable's SHA-256 + publisher (ADR-005
     * Phase 5b). When `ARC_PLUGIN_MANIFEST=required` an absent manifest is itself a
     * refusal; an attached manifest is always verified strictly.
     */
    manifest?: SignedPluginManifest,
  ): Promise<MountedPlugin> {
    const capabilities = await this.verifyManifestOrThrow(manifest, spec.command, "process");
    return this.spawnAndMount(spec, mountPath, config, capabilities);
  }

  /** Spawn + mount; assumes any manifest check has already been done by the caller. */
  private async spawnAndMount(
    spec: RemoteProcessSpec,
    mountPath: string,
    config: unknown,
    capabilities: readonly string[] | undefined,
  ): Promise<MountedPlugin> {
    let remote: RemoteSecretsPlugin;
    try {
      remote = await RemoteSecretsPlugin.spawn(spec);
    } catch (err) {
      throw new BadRequestException({
        errors: [`failed to spawn remote plugin: ${(err as Error).message}`],
      });
    }
    try {
      const mounted = await this.mountSecretsPlugin(remote, mountPath, config, capabilities);
      this.remoteByName.set(mounted.meta.name, remote);
      this.logger.log(`mounted remote plugin ${mounted.meta.name} (pid via child)`);
      return mounted;
    } catch (err) {
      // mountSecretsPlugin already rolled back the host side; just kill the child too.
      await remote.close().catch(() => undefined);
      throw err;
    }
  }

  /**
   * WASM/wasmtime variant of {@link mountRemoteSecretsPlugin}. Convenience wrapper that
   * builds a deny-by-default wasmtime spec via {@link buildWasmtimeSpec} and mounts the
   * resulting child the same way as any other remote plugin. The operator must have the
   * `wasmtime` binary on PATH in the deployment image (or pin `wasmtimePath` in `spec`).
   */
  async mountWasmSecretsPlugin(
    spec: WasmPluginSpec,
    mountPath: string,
    config: unknown = {},
    /** Optional signed manifest pinning the `.wasm` SHA-256 + publisher. */
    manifest?: SignedPluginManifest,
  ): Promise<MountedPlugin> {
    // Verify against the *.wasm* (kind: "wasm"), not the wasmtime CLI — that's what the
    // manifest pins. The wasmtime binary itself is an operator-supplied runtime, not a
    // plugin artifact, so it doesn't go through manifest verification.
    const capabilities = await this.verifyManifestOrThrow(manifest, spec.wasmPath, "wasm");
    return this.spawnAndMount(buildWasmtimeSpec(spec), mountPath, config, capabilities);
  }

  /** List every plugin currently in the host. Each item shows its mount path if mounted. */
  list(): MountedPlugin[] {
    return this.host.list().map((meta) => ({ meta, mount: this.mountByName.get(meta.name) ?? "" }));
  }

  /**
   * The manifest-declared capability set pinned to a mount path, or `undefined` when
   * none is pinned (either no manifest or manifest without `capabilities`). Read-only
   * accessor for the admin controller — the underlying map is private so callers can't
   * forge cap pins.
   */
  declaredCapabilitiesFor(mountPath: string): ReadonlySet<string> | undefined {
    return this.config.manifestCapsByMount.get(mountPath) ?? undefined;
  }

  /**
   * Tear down a mount: remove from the registry, drop the engine, revoke every active lease
   * issued by it, then unregister from the host. Idempotent — returns true if anything was
   * removed.
   */
  async unmount(name: string): Promise<boolean> {
    const mount = this.mountByName.get(name);
    if (!mount) return false;
    await this.config.leases.revokePrefix(mount);
    this.config.registry.unmount(mount);
    this.config.enginesByMount.delete(mount);
    this.config.manifestCapsByMount.delete(mount);
    this.mountByName.delete(name);
    this.host.unregister(name);
    // Close the remote child if this was a remote plugin. Closing is best-effort — if the
    // child was already dead we silently move on.
    const remote = this.remoteByName.get(name);
    if (remote) {
      this.remoteByName.delete(name);
      await remote.close().catch(() => undefined);
    }
    this.logger.log(`unmounted plugin ${name} from ${mount}`);
    return true;
  }
}
