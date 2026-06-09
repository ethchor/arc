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
 * Build the `RemoteProcessSpec` that `PluginsService.mountRemoteSecretsPlugin` consumes
 * for a given mount spec. The OOP bin is `spec.command` directly (operators chmod +x'd
 * the file at install time), so arc-server's manifest gate hashes the actual executable
 * bytes that will run.
 */
export function buildRemoteProcessSpec(spec: PluginMountSpec): RemoteProcessSpec {
  return {
    command: spec.artifactPath,
    args: [],
    // No env passthrough by default — plugins inherit only the env they need from the
    // operator's deploy config (e.g. AWS_REGION, AWS_PROFILE for the AWS plugin) when
    // operators explicitly add it to the spec. Today the bin reads from process.env
    // since RemoteSecretsPlugin.spawn inherits the parent's env by default.
  };
}
