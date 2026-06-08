#!/usr/bin/env node
/**
 * `arc-plugin-sign` — operator-facing CLI for the arc plugin-manifest gate (ADR-005 Phase 5b).
 *
 * Three subcommands:
 *
 *   arc-plugin-sign keygen [--out-priv <path>] [--out-pub <path>]
 *     Generate an Ed25519 publisher keypair. Prints b64url pub on stdout; writes priv to a
 *     mode-0600 file (default `./publisher.key`) so it isn't world-readable on shared CI
 *     runners. Pub goes to stdout or `--out-pub <path>` as a one-liner.
 *
 *   arc-plugin-sign sign --artifact <path> --priv <key-file-or-env:VAR> --publisher <id>
 *                        --name <name> --version <ver> --kind <wasm|process>
 *                        [--capabilities <csv>] [--out <manifest.json>]
 *     Hash + sign the artifact; emit `SignedPluginManifest` JSON. `--priv env:VAR` reads
 *     from an env var so CI secrets don't have to land on disk.
 *
 *   arc-plugin-sign verify --artifact <path> --manifest <manifest.json> --pub <b64u-or-file>
 *     Re-hash the artifact, verify the signature, validate caps. Exits 0 ok / 2 reject.
 *
 * Exit codes: 0 success · 1 usage/IO error · 2 verification refused.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { SignedPluginManifest } from "@arc/types";
import {
  generatePublisherKey,
  signArtifact,
  verifyArtifact,
  KNOWN_PLUGIN_CAPABILITIES,
} from "./lib";

const USAGE = `usage: arc-plugin-sign <command> [options]

commands:
  keygen      generate an Ed25519 publisher keypair
  sign        sign a manifest pinning an artifact + its declared capabilities
  verify      verify a manifest against an artifact + the published pub key

run \`arc-plugin-sign <command> --help\` for command-specific options
`;

export interface CliIO {
  argv: readonly string[];
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
}

export async function runCli(io: CliIO): Promise<number> {
  const [cmd, ...rest] = io.argv;
  try {
    switch (cmd) {
      case "keygen":
        return await runKeygen(rest, io);
      case "sign":
        return await runSign(rest, io);
      case "verify":
        return await runVerify(rest, io);
      case "--help":
      case "-h":
      case undefined:
        io.out(USAGE);
        return cmd === undefined ? 1 : 0;
      default:
        io.err(`unknown command: ${cmd}`);
        io.err(USAGE);
        return 1;
    }
  } catch (err) {
    io.err(`error: ${(err as Error).message}`);
    return 1;
  }
}

async function runKeygen(rest: readonly string[], io: CliIO): Promise<number> {
  const { values } = parseArgsSafe(rest, {
    options: {
      "out-priv": { type: "string" },
      "out-pub": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    io.out(
      "usage: arc-plugin-sign keygen [--out-priv <path>] [--out-pub <path>]\n" +
        "\n" +
        "Generates a fresh Ed25519 publisher keypair.\n" +
        " --out-priv  where to write the private key (b64url, mode 0600). Default: ./publisher.key\n" +
        " --out-pub   where to write the public key (b64url one-liner). Default: stdout.\n",
    );
    return 0;
  }
  const key = generatePublisherKey();
  const privPath = (values["out-priv"] as string | undefined) ?? "publisher.key";
  await writeAtomic600(privPath, `${key.privB64u}\n`);
  io.err(`wrote private key to ${privPath} (mode 0600)`);

  const pubPath = values["out-pub"] as string | undefined;
  if (pubPath) {
    await writeAtomic(pubPath, `${key.pubB64u}\n`);
    io.err(`wrote public key to ${pubPath}`);
  } else {
    io.out(key.pubB64u);
  }
  return 0;
}

async function runSign(rest: readonly string[], io: CliIO): Promise<number> {
  const { values } = parseArgsSafe(rest, {
    options: {
      artifact: { type: "string" },
      priv: { type: "string" },
      publisher: { type: "string" },
      name: { type: "string" },
      version: { type: "string" },
      kind: { type: "string" },
      capabilities: { type: "string" },
      "issued-at": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    io.out(
      "usage: arc-plugin-sign sign --artifact <path> --priv <file|env:VAR> --publisher <id>\n" +
        "                          --name <name> --version <ver> --kind <wasm|process>\n" +
        "                          [--capabilities <csv>] [--issued-at <iso>] [--out <path>]\n" +
        "\n" +
        `known capabilities: ${[...KNOWN_PLUGIN_CAPABILITIES].sort().join(", ")}\n`,
    );
    return 0;
  }
  const artifact = requireFlag(values, "artifact");
  const privRef = requireFlag(values, "priv");
  const publisher = requireFlag(values, "publisher");
  const name = requireFlag(values, "name");
  const version = requireFlag(values, "version");
  const kindRaw = requireFlag(values, "kind");
  if (kindRaw !== "wasm" && kindRaw !== "process") {
    throw new Error(`--kind must be "wasm" or "process" (got ${kindRaw})`);
  }
  const capabilities = parseCapabilities(values.capabilities as string | undefined);

  const priv = await readPrivKey(privRef, io.env);
  const manifest = await signArtifact({
    artifactPath: artifact,
    publisherPrivB64u: priv,
    publisher,
    name,
    version,
    kind: kindRaw,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(values["issued-at"] !== undefined ? { issuedAt: values["issued-at"] as string } : {}),
  });

  const json = JSON.stringify(manifest, null, 2) + "\n";
  const out = values.out as string | undefined;
  if (out) {
    await writeAtomic(out, json);
    io.err(`wrote signed manifest to ${out}`);
  } else {
    io.out(json.trimEnd());
  }
  return 0;
}

async function runVerify(rest: readonly string[], io: CliIO): Promise<number> {
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
      "usage: arc-plugin-sign verify --artifact <path> --manifest <manifest.json>\n" +
        "                            --pub <b64u-or-file>\n" +
        "\n" +
        "Exits 0 on success, 2 if verification fails (with a structured reason on stderr).\n",
    );
    return 0;
  }
  const artifact = requireFlag(values, "artifact");
  const manifestPath = requireFlag(values, "manifest");
  const pubRef = requireFlag(values, "pub");

  const manifestBytes = await readFile(manifestPath, "utf8");
  let parsed: SignedPluginManifest;
  try {
    parsed = JSON.parse(manifestBytes) as SignedPluginManifest;
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${(err as Error).message}`);
  }
  const pub = await readPubKey(pubRef);

  const result = await verifyArtifact({
    manifest: parsed,
    artifactPath: artifact,
    publisherPubB64u: pub,
  });
  if (result.ok) {
    io.out(`ok: manifest verified for ${parsed.claims.name}@${parsed.claims.version} by ${parsed.claims.publisher}`);
    return 0;
  }
  io.err(`refused: ${result.reason}`);
  return 2;
}

// --- helpers ---

type ParsedValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

/**
 * Lookup a required flag value. Throws a usage error rather than returning undefined so a
 * missing flag fails loud. The value type matches `node:util.parseArgs`'s return — none of
 * our flags use the multi-value (`multiple: true`) shape so a non-string is always an error.
 */
function requireFlag(values: ParsedValues, key: string): string {
  const v = values[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required --${key}`);
  }
  return v;
}

function parseCapabilities(csv: string | undefined): string[] | undefined {
  if (csv === undefined) return undefined;
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Read a private key reference. `env:VAR` reads from `process.env[VAR]` (CI secrets path);
 * any other value is treated as a file path. The leading/trailing whitespace is stripped so
 * a trailing newline from `keygen` doesn't poison the b64url decode.
 */
async function readPrivKey(
  ref: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length);
    const v = env[name];
    if (!v) throw new Error(`env var ${name} is unset/empty`);
    return v.trim();
  }
  const bytes = await readFile(ref, "utf8");
  return bytes.trim();
}

/**
 * Read a public key reference. A raw b64url string (44 chars, no `=` padding) is passed
 * through; anything else is treated as a file path containing the key. Mirrors `--priv`
 * semantics for symmetry, except `env:` isn't needed (pub keys aren't secrets).
 */
async function readPubKey(ref: string): Promise<string> {
  if (looksLikeB64u(ref)) return ref;
  const bytes = await readFile(ref, "utf8");
  return bytes.trim();
}

function looksLikeB64u(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s) && s.length >= 32 && !existsSync(s);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeAtomic600(path: string, content: string): Promise<void> {
  await writeAtomic(path, content);
  await chmod(path, 0o600);
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

if (process.argv[1] && process.argv[1].endsWith("bin.js")) {
  void runCli({
    argv: process.argv.slice(2),
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    env: process.env,
  }).then((code) => process.exit(code));
}
