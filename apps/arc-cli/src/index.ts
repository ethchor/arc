import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VaultClient } from "@arc/sdk";

export interface CliIO {
  argv: string[];
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  configDir: string;
}

interface CliConfig {
  baseUrl: string;
  token?: string;
  userId?: number;
}

function loadConfig(dir: string): CliConfig {
  const p = join(dir, "config.json");
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as CliConfig;
  return { baseUrl: "http://localhost:3001" };
}

function saveConfig(dir: string, cfg: CliConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2));
}

const USAGE =
  "commands:\n" +
  "  login <email>                 dev login (sync authorization)\n" +
  "  enroll                        create the vault (needs ARC_MASTER_PASSWORD)\n" +
  "  create-vault [team|personal]  create a vault, prints its id\n" +
  "  set <vaultId> <key> <value>   store/update a secret\n" +
  "  get <vaultId> <key>           print a secret value\n" +
  "  ls [vaultId]                  list vaults, or keys in a vault\n" +
  "  whoami                        show current login\n" +
  "\nsession: set ARC_MASTER_PASSWORD (consumer) or ARC_IDENTITY_KEY (service account).";

export async function runCli(io: CliIO): Promise<number> {
  const [cmd, ...args] = io.argv;
  const cfg = loadConfig(io.configDir);
  if (io.env.ARC_BASE_URL) cfg.baseUrl = io.env.ARC_BASE_URL;
  const profile = (io.env.ARC_ARGON_PROFILE as "desktop" | "mobile" | "test" | undefined) ?? "desktop";
  const client = new VaultClient({ baseUrl: cfg.baseUrl, profile });
  if (cfg.token) client.setToken(cfg.token);

  const ensureSession = async (): Promise<void> => {
    if (io.env.ARC_IDENTITY_KEY) {
      if (!io.env.ARC_IDENTITY_KEY_MLKEM) {
        throw new Error(
          "ARC_IDENTITY_KEY set without ARC_IDENTITY_KEY_MLKEM — hybrid identity requires both",
        );
      }
      client.setIdentity(
        {
          identityPrivB64: io.env.ARC_IDENTITY_KEY,
          identityPrivMlkemB64: io.env.ARC_IDENTITY_KEY_MLKEM,
        },
        io.env.ARC_SIGNING_KEY,
      );
    } else if (io.env.ARC_MASTER_PASSWORD) {
      await client.unlock(io.env.ARC_MASTER_PASSWORD);
    } else {
      throw new Error("no session: set ARC_MASTER_PASSWORD or ARC_IDENTITY_KEY");
    }
  };

  const findByKey = async (vaultId: string, key: string) => {
    await client.listVaults();
    const items = (await client.pull(vaultId, 0)).items;
    return items.find((i) => !i.deleted && (i.data as { key?: string } | null)?.key === key);
  };

  try {
    switch (cmd) {
      case "login": {
        const email = args[0];
        if (!email) throw new Error("usage: login <email>");
        const r = await client.devLogin(email);
        saveConfig(io.configDir, { ...cfg, token: r.token, userId: r.userId });
        io.out(`logged in as userId=${r.userId}`);
        return 0;
      }
      case "enroll": {
        if (!io.env.ARC_MASTER_PASSWORD) throw new Error("set ARC_MASTER_PASSWORD");
        const { recoveryKey } = await client.enroll(io.env.ARC_MASTER_PASSWORD);
        io.out("enrolled. RECOVERY KEY (store now, shown once):");
        io.out(recoveryKey);
        return 0;
      }
      case "create-vault": {
        await ensureSession();
        const v = await client.createVault((args[0] as "team" | "personal" | "org") ?? "team");
        io.out(v.id);
        return 0;
      }
      case "set": {
        const [vaultId, key] = args;
        const value = args.slice(2).join(" ");
        if (!vaultId || !key) throw new Error("usage: set <vaultId> <key> <value>");
        await ensureSession();
        const existing = await findByKey(vaultId, key);
        await client.putItem(
          vaultId,
          { type: "secret", key, value },
          existing
            ? { id: existing.id, baseVersion: existing.version, type: "secret" }
            : { type: "secret" },
        );
        io.out(`set ${key}`);
        return 0;
      }
      case "get": {
        const [vaultId, key] = args;
        if (!vaultId || !key) throw new Error("usage: get <vaultId> <key>");
        await ensureSession();
        const found = await findByKey(vaultId, key);
        if (!found) {
          io.err(`not found: ${key}`);
          return 1;
        }
        io.out(String((found.data as { value?: unknown }).value));
        return 0;
      }
      case "ls": {
        await ensureSession();
        if (!args[0]) {
          const vaults = await client.listVaults();
          for (const v of vaults) io.out(`${v.id}\t${v.type}\t${v.role}`);
          return 0;
        }
        await client.listVaults();
        const items = (await client.pull(args[0], 0)).items.filter((i) => !i.deleted);
        for (const i of items) io.out(String((i.data as { key?: string } | null)?.key ?? i.id));
        return 0;
      }
      case "whoami": {
        io.out(`baseUrl=${cfg.baseUrl} userId=${cfg.userId ?? "(not logged in)"}`);
        return 0;
      }
      default: {
        io.err(USAGE);
        return cmd ? 1 : 0;
      }
    }
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 1;
  }
}
