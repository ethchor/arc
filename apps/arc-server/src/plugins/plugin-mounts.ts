/**
 * Boot-time auto-mount for OOP secrets plugins (ADR-005 Phase 5b operator UX).
 *
 * Operators install signed plugins to disk (via `arc-vault plugin install` or by hand
 * from a GitHub release), then point arc-server at them via `ARC_PLUGIN_MOUNTS`. The
 * manifest gate (`ARC_PLUGIN_MANIFEST`/`ARC_PLUGIN_TRUST_ANCHORS`) still applies — this
 * module just **discovers** plugins to mount; refusal logic lives entirely in
 * `PluginManifestService` so we don't have two places to keep in sync.
 *
 * Env shape:
 *
 *   ARC_PLUGIN_MOUNTS=<mount-path>=<bin-path>[?manifest=<json>][&config=<json>][&args=<csv>],<more>...
 *
 * Example:
 *
 *   ARC_PLUGIN_MOUNTS=aws/=/opt/arc/plugins/aws/bin.cjs?manifest=/opt/arc/plugins/aws/manifest.json&config=/opt/arc/plugins/aws/config.json
 *
 * Semantics:
 *  - Mount path is normalized to a single trailing slash (matches `MountRegistry`).
 *  - `manifest=` is optional but recommended; without it the gate is bypassed for that
 *    mount, same posture as a programmatic `mountRemoteSecretsPlugin(spec, …, undefined)`.
 *  - `config=` points at a JSON file passed to the plugin's `configure()` via JSON-RPC.
 *    Absent ⇒ `{}`. Failure to read or parse is non-fatal for that entry — it logs and
 *    the other entries continue (one bad plugin shouldn't take the server down).
 *  - Each entry's failure is isolated; the others still mount. Operators see each
 *    failure in the structured boot log (and the gate's reason for any manifest refusal).
 *
 * Out of scope for v1: argv passthrough (`args=…`) — operators put per-plugin params in
 * the config file (read by the plugin's `configure()`), which keeps the env shape
 * comma-safe and the security surface narrow. Argv passthrough lands in a follow-up if
 * a real plugin needs it.
 */
import { readFile } from "node:fs/promises";
import type { SignedPluginManifest } from "@arc/types";
import type { RemoteProcessSpec } from "@arc/plugin-sdk";

export interface PluginMountSpec {
  mountPath: string;
  artifactPath: string;
  /** Optional path to a signed manifest JSON file; consumed by `PluginManifestService`. */
  manifestPath?: string;
  /** Optional path to a JSON file passed to the plugin's `configure()`. */
  configPath?: string;
  /**
   * Names of env vars to forward from arc-server's `process.env` into the plugin child
   * process. Empty/absent (the secure default) means the plugin child sees **no env vars
   * at all** — same posture as the WASM backend. Operators who run a plugin that needs
   * e.g. `AWS_REGION` declare it explicitly via `?env=AWS_REGION:AWS_DEFAULT_REGION` on
   * the mount entry (colon-separated — comma is the outer entry separator). Unknown
   * env-var names are silently dropped (the operator just doesn't have one set); the env
   * passthrough never invents values.
   */
  envPassthrough?: readonly string[];
}

/**
 * Parse `ARC_PLUGIN_MOUNTS` into structured specs. Returns empty when unset. Malformed
 * entries are skipped with the index recorded in `errors` so the boot path can warn
 * loudly without failing the whole startup.
 */
export function parsePluginMountsEnv(raw: string | undefined): {
  specs: PluginMountSpec[];
  errors: Array<{ index: number; entry: string; reason: string }>;
} {
  const specs: PluginMountSpec[] = [];
  const errors: Array<{ index: number; entry: string; reason: string }> = [];
  if (!raw) return { specs, errors };

  // Split on commas at the top level. The `args=` value MAY contain commas in theory,
  // but we treat them as quoted-CSV-only — operators with commas in plugin args should
  // pin them via the JSON config file instead. Documenting this in env-vars.md.
  const entries = raw.split(",").map((s) => s.trim()).filter(Boolean);
  entries.forEach((entry, index) => {
    try {
      specs.push(parseEntry(entry));
    } catch (err) {
      errors.push({ index, entry, reason: (err as Error).message });
    }
  });
  return { specs, errors };
}

function parseEntry(entry: string): PluginMountSpec {
  const eq = entry.indexOf("=");
  if (eq <= 0) throw new Error(`expected "<mount-path>=<bin-path>[?key=val&...]"`);
  const mountPath = normalizeMountPath(entry.slice(0, eq).trim());
  const rest = entry.slice(eq + 1).trim();
  if (!rest) throw new Error("missing bin path");
  const queryAt = rest.indexOf("?");
  const artifactPath = (queryAt < 0 ? rest : rest.slice(0, queryAt)).trim();
  if (!artifactPath) throw new Error("missing bin path");
  const params = queryAt < 0 ? new URLSearchParams() : new URLSearchParams(rest.slice(queryAt + 1));
  const out: PluginMountSpec = { mountPath, artifactPath };
  const manifest = params.get("manifest");
  if (manifest) out.manifestPath = manifest.trim();
  const config = params.get("config");
  if (config) out.configPath = config.trim();
  const env = params.get("env");
  if (env) {
    // Colon-separated, not comma — the top-level entry splitter already consumes commas
    // (`ARC_PLUGIN_MOUNTS=aws/=…,github/=…`), so a comma inside `env=` would smuggle one
    // env name into the next mount entry. Colon isn't a valid POSIX env-name char, so it
    // is unambiguous as a name separator. Example:
    //   ARC_PLUGIN_MOUNTS=aws/=/x/bin?env=AWS_REGION:AWS_PROFILE
    const names = env.split(":").map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) {
        throw new Error(`invalid env-var name "${n}" — expected POSIX identifier`);
      }
    }
    if (names.length > 0) out.envPassthrough = names;
  }
  return out;
}

function normalizeMountPath(p: string): string {
  const trimmed = p.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) throw new Error("mount path must be non-empty");
  return trimmed + "/";
}

/**
 * Load the optional manifest + config files referenced by a spec. Either-or absence is
 * fine; a *referenced-but-unreadable* file is an error.
 */
export async function resolveMountFiles(spec: PluginMountSpec): Promise<{
  manifest?: SignedPluginManifest;
  config: unknown;
}> {
  let manifest: SignedPluginManifest | undefined;
  if (spec.manifestPath) {
    let raw: string;
    try {
      raw = await readFile(spec.manifestPath, "utf8");
    } catch (err) {
      throw new Error(`manifest at ${spec.manifestPath} unreadable: ${(err as Error).message}`);
    }
    try {
      manifest = JSON.parse(raw) as SignedPluginManifest;
    } catch (err) {
      throw new Error(`manifest at ${spec.manifestPath} is not valid JSON: ${(err as Error).message}`);
    }
  }

  let config: unknown = {};
  if (spec.configPath) {
    let raw: string;
    try {
      raw = await readFile(spec.configPath, "utf8");
    } catch (err) {
      throw new Error(`config at ${spec.configPath} unreadable: ${(err as Error).message}`);
    }
    try {
      config = JSON.parse(raw);
    } catch (err) {
      throw new Error(`config at ${spec.configPath} is not valid JSON: ${(err as Error).message}`);
    }
  }

  return manifest !== undefined ? { manifest, config } : { config };
}

/**
 * Names always forwarded from arc-server's `process.env` to a plugin child. These are
 * **not** secrets in any threat model arc cares about — `PATH` is required for the
 * kernel to resolve `#!/usr/bin/env node` shebangs and for the child to find any sub-
 * binaries; nothing about it lets a plugin read arc-server's keys, tokens, or DB
 * connection. Kept tight on purpose: anything operationally useful but secret-shaped
 * (AWS_*, GCP_*, KUBECONFIG, …) must still be listed explicitly via `envPassthrough`.
 */
export const ALWAYS_PASSTHROUGH_ENV: ReadonlySet<string> = new Set(["PATH"]);

/**
 * Build the `RemoteProcessSpec` that `PluginsService.mountRemoteSecretsPlugin` consumes
 * for a given mount spec. The OOP bin is `spec.command` directly (operators chmod +x'd
 * the file at install time), so arc-server's manifest gate hashes the actual executable
 * bytes that will run.
 *
 * SECURITY: `env` is **always set explicitly** — never left undefined. Node's
 * `child_process.spawn` treats undefined env as "inherit `process.env`", which would
 * hand the plugin arc-server's JWT_SECRET / BAO_TOKEN / DATABASE_URL / ARC_PUBLISHER_PRIV
 * — full server-equivalent compromise. By default the only key forwarded is `PATH`
 * (see `ALWAYS_PASSTHROUGH_ENV`); operators add more via `envPassthrough` on the spec
 * (set by the `?env=K1:K2` query param on `ARC_PLUGIN_MOUNTS`).
 */
export function buildRemoteProcessSpec(
  spec: PluginMountSpec,
  hostEnv: NodeJS.ProcessEnv = process.env,
): RemoteProcessSpec {
  const env: Record<string, string> = {};
  for (const name of ALWAYS_PASSTHROUGH_ENV) {
    const value = hostEnv[name];
    if (typeof value === "string") env[name] = value;
  }
  for (const name of spec.envPassthrough ?? []) {
    const value = hostEnv[name];
    if (typeof value === "string") env[name] = value;
  }
  return {
    command: spec.artifactPath,
    args: [],
    env,
  };
}
