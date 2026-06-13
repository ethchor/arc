import { Callout } from "../../components/callout";
import { CodeBlock } from "../../components/code-block";
import { DocsPrevNext } from "../../components/docs-prev-next";
import { highlightAll } from "../../components/highlight";

export const metadata = { title: "API surface · arc docs" };

interface Endpoint {
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  auth: string;
  description: string;
}

const surfaces: { group: string; endpoints: Endpoint[]; notes?: string }[] = [
  {
    group: "Auth",
    endpoints: [
      { method: "POST", path: "/auth/dev-login", auth: "open", description: "Dev-only login (requires ARC_ENABLE_DEV_LOGIN=true; 403 in prod)." },
    ],
  },
  {
    group: "Vault (Engine B)",
    endpoints: [
      { method: "POST", path: "/vault/enroll", auth: "user", description: "Upload keyset on first sign-in." },
      { method: "GET", path: "/vault/keyset", auth: "user", description: "Fetch wrapped keyset for unlock." },
      { method: "POST", path: "/vault/unlock", auth: "user", description: "Server-side restretch + authHash compare." },
      { method: "POST", path: "/vault/keyset/recover", auth: "user", description: "Re-enroll under a new master pw via recovery key (ADR-006)." },
      { method: "GET", path: "/vaults", auth: "user", description: "List vaults the caller is a member of." },
      { method: "POST", path: "/vaults", auth: "user", description: "Create a vault." },
      { method: "GET", path: "/vaults/:id/items", auth: "viewer", description: "Pull items; sync via `?since=<seq>`." },
      { method: "POST", path: "/vaults/:id/items", auth: "editor", description: "Create or update an item (envelope-versioned)." },
      { method: "POST", path: "/vaults/:id/items/:itemId/share", auth: "editor", description: "ADR-007 item-level share — pqSeal-wrap to recipient." },
      { method: "POST", path: "/vault/passkey/register", auth: "user", description: "Discoverable passkey registration (ADR-008)." },
      { method: "POST", path: "/vault/passkey/discover-unlock", auth: "open", description: "Username-less discoverable unlock." },
    ],
  },
  {
    group: "Engine A (`/v1/*` — Vault-compatible)",
    endpoints: [
      { method: "GET", path: "/v1/sys/health", auth: "user", description: "Backend health (proxies through OpenBao)." },
      { method: "GET", path: "/v1/sys/mounts", auth: "user", description: "List active mounts." },
      { method: "GET", path: "/v1/sys/policy", auth: "user", description: "List policies (gated by @arc/grants)." },
      { method: "POST", path: "/v1/<mount>/data/<path>", auth: "ACL", description: "KV v2 write." },
      { method: "GET", path: "/v1/<mount>/data/<path>", auth: "ACL", description: "KV v2 read." },
      { method: "POST", path: "/v1/transit/encrypt/<key>", auth: "ACL", description: "Transit encrypt." },
      { method: "GET", path: "/v1/<plugin>/creds/<role>", auth: "ACL", description: "Dynamic credential issuance." },
      { method: "POST", path: "/v1/sys/plugins/mounts", auth: "sudo on sys/plugins/", description: "Mount a signed plugin (LOW-E enforces @RequireCapability(sudo))." },
    ],
    notes: "Every /v1/* request is canonicalised (HIGH-A path-traversal guard) and ACL-decided by the CapabilityGuard.",
  },
  {
    group: "Engine C — Agents (ADR-005)",
    endpoints: [
      { method: "POST", path: "/vault/agents", auth: "owner", description: "Register an agent." },
      { method: "POST", path: "/vault/agents/:id/delegations", auth: "owner", description: "Record a signed delegation (narrow-only)." },
      { method: "POST", path: "/vault/agents/:id/auth/challenge", auth: "open", description: "Mint a nonce the agent signs." },
      { method: "POST", path: "/vault/agents/:id/auth/token", auth: "open", description: "Exchange signature → 10-minute JWT pinned to tokenEpoch (HIGH-C)." },
      { method: "POST", path: "/vault/agents/:id/tasks", auth: "owner", description: "Open a task." },
      { method: "POST", path: "/vault/agents/:id/intents", auth: "agent token", description: "Submit a signed intent (MED-E prevChainHead-required, HIGH-D replay-blocked)." },
      { method: "POST", path: "/vault/agents/:id/tasks/:taskId/close", auth: "owner", description: "Cascades revoke (delegations + leases + bumps tokenEpoch)." },
      { method: "POST", path: "/vault/approvals/:id/challenge", auth: "owner", description: "MED-F: challenge = SHA-256(\"arc-approval/v1\\n\" || intentDigest)." },
      { method: "POST", path: "/vault/approvals/:id/approve", auth: "owner", description: "Grant the approval with a WebAuthn assertion." },
    ],
  },
];

const errors = [
  { status: "400", err: "invalid_engine_path", when: "/v1/* received `..` or double-encoded traversal (HIGH-A)" },
  { status: "400", err: "argon_below_floor", when: "client uploaded argonParams below the configured floor (LOW-B)" },
  { status: "401", err: "agent_token_revoked", when: "agent JWT's `agentTokenEpoch` doesn't match the agent's row (HIGH-C)" },
  { status: "403", err: "agent_token_off_intent_path", when: "agent token tried to reach a route other than POST /vault/agents/:id/intents (CRIT-1)" },
  { status: "403", err: "dev_login_disabled", when: "/auth/dev-login invoked without ARC_ENABLE_DEV_LOGIN=true (MED-C)" },
  { status: "403", err: "forbidden", when: "role check failed on the target vault" },
  { status: "404", err: "—", when: "resource not found (or not visible to the caller — 404 not 403, to avoid leaking existence)" },
  { status: "409", err: "intent_replay", when: "the same signed intent submitted twice (HIGH-D)" },
  { status: "409", err: "intent_chain_mismatch", when: "claims.prevChainHead disagrees with task.chainHead (MED-E)" },
  { status: "409", err: "conflict", when: "optimistic-concurrency conflict on item write (doc 10 §10.3)" },
  { status: "410", err: "upgrade_required", when: "client envelope version below minimum (doc 04 §4.8)" },
  { status: "423", err: "locked", when: "vault/account locked after too many unlock failures" },
  { status: "429", err: "—", when: "rate-limited (unlock, directory lookups)" },
];

const ts = {
  fetch: {
    code: `// Minimal fetch wrapper — every endpoint below uses this shape.
const r = await fetch("http://localhost:3001/vault/keyset", {
  headers: { Authorization: \`Bearer \${jwt}\` },
});
if (!r.ok) throw new Error(\`\${r.status}: \${await r.text()}\`);
const keyset = await r.json();`,
    lang: "typescript",
  },
};

export default async function ApiPage() {
  const h = await highlightAll(ts);
  return (
    <>
      <h1>API surface</h1>
      <p>
        Every REST endpoint accepts and returns JSON. Authentication is{" "}
        <strong>HTTP Bearer JWT</strong> for human users (via <code>/auth/dev-login</code> in
        dev or a real OIDC IdP in production), and a separate <strong>agent JWT</strong>{" "}
        minted via challenge-response for agents. The CapabilityGuard runs after the JWT
        guard on every <code>/v1/*</code> route.
      </p>

      <CodeBlock html={h.fetch} raw={ts.fetch.code} language="typescript" />

      {surfaces.map((s) => (
        <section key={s.group}>
          <h2>{s.group}</h2>
          {s.notes ? (
            <p className="text-sm text-muted-foreground">{s.notes}</p>
          ) : null}
          <div className="not-prose my-4 overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 w-20">Method</th>
                  <th className="px-3 py-2">Path</th>
                  <th className="px-3 py-2 w-32">Auth</th>
                  <th className="px-3 py-2">Description</th>
                </tr>
              </thead>
              <tbody>
                {s.endpoints.map((e) => (
                  <tr key={`${s.group}-${e.method}-${e.path}`} className="border-t">
                    <td className="px-3 py-2 font-mono text-[12px] text-primary">{e.method}</td>
                    <td className="px-3 py-2 font-mono text-[12px]">{e.path}</td>
                    <td className="px-3 py-2 text-[12px] text-muted-foreground">{e.auth}</td>
                    <td className="px-3 py-2 text-[12px]">{e.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <h2>Error codes</h2>
      <Callout kind="info">
        Error responses use the body shape <code>{`{ "error": "<code>", ... }`}</code>. The
        codes below are stable contracts — the SDK switches on them and so should you.
      </Callout>
      <div className="not-prose my-4 overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 w-20">Status</th>
              <th className="px-3 py-2 w-64">Body.error</th>
              <th className="px-3 py-2">When</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => (
              <tr key={`${e.status}-${e.err}`} className="border-t">
                <td className="px-3 py-2 font-mono text-[12px]">{e.status}</td>
                <td className="px-3 py-2 font-mono text-[12px]">{e.err}</td>
                <td className="px-3 py-2 text-[12px]">{e.when}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DocsPrevNext href="/docs/reference/api" />
    </>
  );
}
