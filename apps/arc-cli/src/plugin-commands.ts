/**
 * Operator-side plugin install/verify subcommands. The signing half lives in
 * `@arc/plugin-sign` (build-time tool); this module is the *consume* side — fetch a
 * release tarball + verify it against an operator-pinned publisher pub key, lay the
 * artifact + manifest down on disk in a layout arc-server can boot-mount, and print the
 * env-var snippet the operator should add to their server config.
 *
 * Scope (v1): HTTP fetch from a release URL prefix (the GitHub release asset URL works
 * directly), or a local directory containing `bin.cjs` + `manifest.json`. Tarball-only
 * releases land in a follow-up; the GitHub Release shape we publish today gives both the
 * raw files and a tarball, so operators can pick whichever fits their automation.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  derivePublisherPub,
  verifyArtifact,
  type VerifyResult,
} from "@arc/plugin-sign";
import type { SignedPluginManifest } from "@arc/types";

export interface PluginCliIO {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Override for tests: replace with a stub that returns canned bytes for known URLs. */
  fetch?: typeof fetch;
}

const USAGE = `usage: arc-vault plugin <command> [options]

commands:
  install     download + verify a signed plugin release, write to a local layout
  verify      verify a local bin + manifest against a pub key (no install)

run \`arc-vault plugin <command> --help\` for command-specific options
`;

export async function runPluginCli(argv: readonly string[], io: PluginCliIO): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "install":
        return await runInstall(rest, io);
      case "verify":
        return await runVerify(rest, io);
      case "--help":
      case "-h":
      case undefined:
        io.out(USAGE);
        return cmd === undefined ? 1 : 0;
      default:
        io.err(`unknown plugin command: ${cmd}`);
        io.err(USAGE);
        return 1;
    }
  } catch (err) {
    io.err(`error: ${(err as Error).message}`);
    return 1;
  }
}

async function runInstall(rest: readonly string[], io: PluginCliIO): Promise<number> {
  const { values } = parseArgsSafe(rest, {
    options: {
      release: { type: "string" },
      "from-dir": { type: "string" },
      pub: { type: "string" },
      "out-dir": { type: "string" },
      name: { type: "string" },
      "mount-path": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    io.out(
      "usage: arc-vault plugin install (--release <url-prefix> | --from-dir <path>)\n" +
        "                              --pub <b64u-or-file> --out-dir <dir>\n" +
        "                              [--name <plugin-name>] [--mount-path <path>]\n" +
        "\n" +
        "Downloads `bin.cjs` + `manifest.json` from a release URL (or a local dir), verifies\n" +
        "them locally against the publisher pub key (same primitives arc-server uses), lays\n" +
        "them down under `<out-dir>/<name>/`, and prints the `ARC_PLUGIN_MOUNTS` snippet you\n" +
        "add to arc-server's env to auto-mount on boot.\n",
    );
    return 0;
  }
  const release = optionalString(values, "release");
  const fromDir = optionalString(values, "from-dir");
  if (release === undefined && fromDir === undefined) {
    throw new Error("either --release <url> or --from-dir <path> is required");
  }
  if (release !== undefined && fromDir !== undefined) {
    throw new Error("--release and --from-dir are mutually exclusive");
  }
  const pubRef = requireFlag(values, "pub");
  const outDir = resolvePath(requireFlag(values, "out-dir"));

  const bytes = await loadArtifactAndManifest(
    release !== undefined ? { kind: "url", base: release } : { kind: "dir", path: resolvePath(fromDir!) },
    io,
  );

  const parsedManifest = parseManifest(bytes.manifest);
  const name = optionalString(values, "name") ?? parsedManifest.claims.name;
  const mountPath = optionalString(values, "mount-path") ?? defaultMountPath(name);
  const pubB64u = await resolvePub(pubRef);

  // Write before verify so a tamper-mid-flight scenario still leaves the artifact on
  // disk for forensics. Verify then makes the final accept/reject call.
  const pluginDir = resolvePath(outDir, name);
  await mkdir(pluginDir, { recursive: true });
  const binPath = resolvePath(pluginDir, "bin.cjs");
  const manifestPath = resolvePath(pluginDir, "manifest.json");
  await writeFile(binPath, bytes.bin);
  await writeFile(manifestPath, bytes.manifest);

  const result = await verifyArtifact({
    manifest: parsedManifest,
    artifactPath: binPath,
    publisherPubB64u: pubB64u,
  });
  if (!result.ok) {
    io.err(`refused: ${result.reason}`);
    io.err(`the artifact + manifest were written to ${pluginDir} for inspection — delete them before retrying.`);
    return 2;
  }

  await chmod(binPath, 0o755); // executable, matches OOP plugin's spec.command expectation

  const mountSnippet = `ARC_PLUGIN_MOUNTS=${mountPath}=${binPath}?manifest=${manifestPath}`;
  io.out(`installed ${parsedManifest.claims.name}@${parsedManifest.claims.version} to ${pluginDir}`);
  io.out(`publisher: ${parsedManifest.claims.publisher}`);
  io.out(`capabilities: ${formatCaps(parsedManifest.claims.capabilities)}`);
  io.out("");
  io.out("add this to arc-server's env to auto-mount on boot:");
  io.out(`  ${mountSnippet}`);
  io.out("");
  io.out("and pin the publisher pub if you haven't already:");
  io.out(`  ARC_PLUGIN_TRUST_ANCHORS=${parsedManifest.claims.publisher}=${pubB64u}`);
  return 0;
}

async function runVerify(rest: readonly string[], io: PluginCliIO): Promise<number> {
  const { values } = parseArgsSafe(rest, {
    options: {
      artifact: { type: "string" },
      manifest: { type: "string" },
      pub: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    io.out(
      "usage: arc-vault plugin verify --artifact <bin> --manifest <json>\n" +
        "                              --pub <b64u-or-file>\n" +
        "\n" +
        "Re-hash the artifact + check the manifest's signature against the publisher pub\n" +
        "key (and the declared capabilities against the canonical vocabulary). Mirrors\n" +
        "arc-server's `PluginManifestService.verify` reason strings byte-for-byte. Exits 0\n" +
        "on success, 2 on refused (reason on stderr).\n",
    );
    return 0;
  }
  const artifactPath = resolvePath(requireFlag(values, "artifact"));
  const manifestPath = resolvePath(requireFlag(values, "manifest"));
  const pubB64u = await resolvePub(requireFlag(values, "pub"));

  const manifest = parseManifest(await readFile(manifestPath));
  const result: VerifyResult = await verifyArtifact({ manifest, artifactPath, publisherPubB64u: pubB64u });
  if (!result.ok) {
    io.err(`refused: ${result.reason}`);
    return 2;
  }
  io.out(`ok: ${manifest.claims.name}@${manifest.claims.version} signed by ${manifest.claims.publisher}`);
  return 0;
}

// --- helpers ---

interface FetchedBytes {
  bin: Uint8Array;
  manifest: Uint8Array;
}

async function loadArtifactAndManifest(
  source: { kind: "url"; base: string } | { kind: "dir"; path: string },
  io: PluginCliIO,
): Promise<FetchedBytes> {
  if (source.kind === "dir") {
    const bin = await readFile(resolvePath(source.path, "bin.cjs"));
    const manifest = await readFile(resolvePath(source.path, "manifest.json"));
    return { bin, manifest };
  }
  const base = source.base.endsWith("/") ? source.base : source.base + "/";
  const f = io.fetch ?? fetch;
  const [bin, manifest] = await Promise.all([
    fetchBinary(f, base + "bin.cjs"),
    fetchBinary(f, base + "manifest.json"),
  ]);
  return { bin, manifest };
}

async function fetchBinary(f: typeof fetch, url: string): Promise<Uint8Array> {
  const res = await f(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

function parseManifest(bytes: Uint8Array): SignedPluginManifest {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as SignedPluginManifest;
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${(err as Error).message}`);
  }
}

async function resolvePub(ref: string): Promise<string> {
  // Inline b64u looks like a b64u-ish string (no slashes from FS paths, length ≥ 32).
  // If it's a path that exists, read the file; otherwise treat as inline.
  // We deliberately accept any b64u-shaped string without filesystem-existence checks
  // here so the CLI works offline / in containers where the file might not exist yet.
  if (/^[A-Za-z0-9_-]+$/.test(ref) && ref.length >= 32 && !ref.includes("/")) return ref;
  const raw = (await readFile(ref, "utf8")).trim();
  // Accept either a bare b64u key or `publisher:<id>=<b64u>` (the ARC_PLUGIN_TRUST_ANCHORS
  // shape) — same convenience the server-side parser offers.
  const eq = raw.indexOf("=");
  if (eq > 0 && raw.startsWith("publisher:")) return raw.slice(eq + 1).trim();
  return raw;
}

function defaultMountPath(name: string): string {
  // `arc-plugin-aws` ⇒ `aws/`. Operators can override with --mount-path.
  const stripped = name.replace(/^arc-plugin-/, "");
  return stripped.endsWith("/") ? stripped : stripped + "/";
}

function formatCaps(caps?: readonly string[]): string {
  if (!caps) return "(none declared — gate disabled for this mount)";
  if (caps.length === 0) return "[] (strict zero-trust — every gated verb refused)";
  return `[${caps.join(", ")}]`;
}

function requireFlag(
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
  key: string,
): string {
  const v = values[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing required --${key}`);
  return v;
}

function optionalString(
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
  key: string,
): string | undefined {
  const v = values[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseArgsSafe(
  args: readonly string[],
  config: ParseArgsConfig,
): ReturnType<typeof parseArgs> {
  try {
    return parseArgs({ ...config, args: [...args] });
  } catch (err) {
    throw new Error(`bad arguments: ${(err as Error).message}`);
  }
}

/**
 * Derivation helper for the workflow's release notes — exposes the b64u pub for an
 * existing priv. Mirrors `arc-plugin-sign pubkey` so an operator who installed the CLI
 * doesn't need a second tool.
 */
export function derivePub(privB64u: string): string {
  return derivePublisherPub(privB64u);
}
