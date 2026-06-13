import { Callout } from "../../components/callout";
import { DocsPrevNext } from "../../components/docs-prev-next";

export const metadata = { title: "Environment variables · arc docs" };

interface Row {
  name: string;
  dev: string;
  prod: string;
  used: string;
  note?: string;
}

const server: Row[] = [
  { name: "DATABASE_URL", dev: "in-memory sql.js", prod: "required (server refuses to boot)", used: "arc-server" },
  { name: "NODE_ENV", dev: "development", prod: "production (strict path — migrations only, no synchronize)", used: "many" },
  { name: "JWT_SECRET", dev: "per-boot random", prod: "required", used: "auth" },
  { name: "LOG_LEVEL", dev: "debug (dev) / info (prod)", prod: "optional", used: "logger" },
  { name: "ARC_ENABLE_DEV_LOGIN", dev: "unset (disabled)", prod: "force-disabled by NODE_ENV=production", used: "auth", note: "Set to `true` in dev to use /auth/dev-login. MED-C." },
  { name: "ARC_DEFAULT_POLICY", dev: "allow", prod: "deny (env-aware default)", used: "grants engine", note: "CRIT-B made the default env-aware." },
  { name: "ARC_ROOT_USERS", dev: "unset", prod: "required if ARC_DEFAULT_POLICY=deny (bootstrap sudo subjects)", used: "grants engine" },
  { name: "ARC_POLICY_CACHE_TTL_MS", dev: "30000", prod: "tune", used: "grants engine" },
  { name: "ARC_PLUGIN_MANIFEST", dev: "optional", prod: "required (env-aware default)", used: "plugin host", note: "MED-D — production refuses unsigned plugins by default." },
  { name: "ARC_PLUGIN_TRUST_ANCHORS", dev: "unset", prod: "required if ARC_PLUGIN_MANIFEST=required", used: "plugin host" },
  { name: "ARC_ARGON_MIN_M", dev: "128 KiB", prod: "65536 KiB (64 MiB) — mobile profile floor", used: "enroll / recover", note: "LOW-B. Override to allow tighter staging KDF without flipping NODE_ENV." },
  { name: "ARC_ARGON_MIN_T", dev: "1", prod: "2", used: "enroll / recover", note: "LOW-B." },
  { name: "ARC_DEVICE_INACTIVE_DAYS", dev: "unset (disabled)", prod: "optional", used: "devices", note: "Auto-revoke approved-but-untrusted devices idle for N days." },
  { name: "BAO_ADDR / BAO_TOKEN / BAO_NAMESPACE", dev: "unset → Engine A disabled", prod: "required to enable Engine A", used: "server, adapter" },
  { name: "OTEL_EXPORTER_OTLP_ENDPOINT", dev: "unset (no traces)", prod: "optional — point at OTLP/HTTP collector", used: "observability" },
  { name: "ARC_PASSKEY_RP_ID", dev: "localhost", prod: "your public hostname", used: "passkey service" },
  { name: "ARC_PASSKEY_RP_NAME", dev: "arc", prod: "display name in OS dialogs", used: "passkey service" },
  { name: "ARC_PASSKEY_ORIGIN", dev: "http://localhost:5173", prod: "your public https origin", used: "passkey service" },
];

const web: Row[] = [
  { name: "NEXT_PUBLIC_API_URL", dev: "http://localhost:3001", prod: "your arc-server URL", used: "vault-web" },
  { name: "NEXT_OUTPUT", dev: "unset", prod: "set to `export` for the desktop static build", used: "vault-web" },
];

function Table({ rows }: { rows: Row[] }) {
  return (
    <div className="not-prose my-4 overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Variable</th>
            <th className="px-3 py-2">Dev default</th>
            <th className="px-3 py-2">Prod default / requirement</th>
            <th className="px-3 py-2">Used by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t align-top">
              <td className="px-3 py-2 font-mono text-[12px] text-foreground">{r.name}</td>
              <td className="px-3 py-2 font-mono text-[12px] text-muted-foreground">{r.dev}</td>
              <td className="px-3 py-2 text-[12px]">{r.prod}</td>
              <td className="px-3 py-2 text-[12px] text-muted-foreground">
                <div>{r.used}</div>
                {r.note ? <div className="mt-1 text-foreground/70">{r.note}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function EnvVarsPage() {
  return (
    <>
      <h1>Environment variables</h1>
      <p>
        Every variable defaults to a sane dev value. Several defaults are <strong>env-aware</strong>{" "}
        — they flip behaviour when <code>NODE_ENV=production</code> so a forgotten env var
        fails closed in production but stays permissive in dev.
      </p>

      <h2>Server</h2>
      <Table rows={server} />

      <h2>Web console</h2>
      <Table rows={web} />

      <Callout kind="tip" title="Adapter / integration tests">
        <p>
          <code>BAO_ADDR</code> + <code>BAO_TOKEN</code> are also read by{" "}
          <code>pnpm --filter @arc/openbao-adapter test</code> — when unset, the live
          integration tests skip cleanly, so the default <code>pnpm test</code> stays green
          without Docker.
        </p>
      </Callout>

      <DocsPrevNext href="/docs/reference/env-vars" />
    </>
  );
}
