/**
 * MCP tool surface exposed by the arc MCP server. Every tool is a thin adapter onto an
 * existing arc-server route — the agent's bearer token rides through verbatim, so the
 * authorization decision is made by `CapabilityGuard` against `@arc/grants`, not here.
 *
 * Scope:
 *  - KV v2 (`secret/`): get / put / list
 *  - Transit (`transit/`): encrypt / decrypt
 *  - Dynamic credentials (any plugin mount): issue
 *  - Sys: list_mounts
 *  - Engine C (agent identity, ADR-005): inspect the agent fleet, introspect effective
 *    authority, and revoke — delegations individually, or a whole task at once.
 *
 * Two deliberate exclusions, both load-bearing:
 *
 * 1. **Engine B (the E2E vault) is NOT exposed.** The server stores ciphertext only and the
 *    master key never leaves the human client. Exposing Engine B over MCP would
 *    fundamentally break that property.
 *
 * 2. **Engine C operations that require a private key are NOT exposed** — registering an
 *    agent (client-side keygen), creating a delegation (delegator-signed), submitting an
 *    intent (agent-signed), and approving (WebAuthn ceremony). The MCP server holds no
 *    signing key, so it could only ever forward an unsigned request the server would
 *    rightly reject. The surface here is therefore *read + revoke*: it can tell you what an
 *    agent may do and take that authority away, but it cannot grant authority.
 */
import type { ArcClient, ArcHttpError } from "./arc-client";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  client: ArcClient;
  /** Bearer token extracted from the MCP request's Authorization header. */
  bearer: string;
}

export interface ToolResult {
  /** MCP `content` array — text-only responses for the first cut. */
  content: { type: "text"; text: string }[];
  /** Set `true` to surface as an MCP tool error (e.g. arc-server 4xx). */
  isError?: boolean;
  // The SDK's CallToolResult type carries an index signature for forward-compatible MCP
  // result fields; mirror it here so this struct is assignable without a cast.
  [key: string]: unknown;
}

export type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;

export interface Tool {
  def: ToolDefinition;
  handler: ToolHandler;
}

/** Wrap a tool handler so validation throws surface as a structured `isError: true` result. */
function guarded(def: ToolDefinition, body: ToolHandler): Tool {
  return {
    def,
    handler: async (input, ctx) => {
      try {
        return await body(input, ctx);
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    },
  };
}

/** ----- shared helpers ------------------------------------------------------ */

function str(input: Record<string, unknown>, key: string, opts: { required?: boolean } = {}): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new Error(`missing required argument "${key}"`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`argument "${key}" must be a string`);
  return v;
}

function int(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) throw new Error(`argument "${key}" must be an integer`);
  return n;
}

function normalizeMount(mount: string): string {
  return mount.replace(/^\/+|\/+$/g, "");
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function callArc(
  fn: () => Promise<unknown>,
): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: asText(result) }] };
  } catch (err) {
    const e = err as ArcHttpError;
    const msg = `arc-server error${typeof e.status === "number" ? ` (${e.status})` : ""}: ${e.message}` +
      (e.body !== undefined ? `\n${asText(e.body)}` : "");
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

/** ----- tools -------------------------------------------------------------- */

const kvGet: Tool = guarded(
  {
    name: "arc_kv_get",
    description:
      "Read a versioned KV v2 secret from arc. Requires the `read` capability on the mount path. Returns the secret's `data` (key/value map) and `metadata` (version, created_time, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        mount: { type: "string", description: 'KV v2 mount, e.g. "secret" (default).', default: "secret" },
        path: { type: "string", description: "Path within the mount, e.g. \"app/prod/db\"." },
        version: { type: "integer", description: "Optional specific version to read; omit for latest." },
      },
      required: ["path"],
    },
  },
  async (input, ctx) => {
    const mount = normalizeMount(str(input, "mount") ?? "secret");
    const path = str(input, "path", { required: true }) as string;
    const version = int(input, "version");
    const query = version !== undefined ? { version: String(version) } : undefined;
    return callArc(() => ctx.client.get(ctx.bearer, `${mount}/data/${path}`, query));
  },
);

const kvPut: Tool = guarded(
  {
    name: "arc_kv_put",
    description:
      "Write a versioned KV v2 secret. The previous version is preserved (KV v2 keeps history). Requires `create` or `update` on the mount path.",
    inputSchema: {
      type: "object",
      properties: {
        mount: { type: "string", description: 'KV v2 mount, e.g. "secret" (default).', default: "secret" },
        path: { type: "string", description: "Path within the mount." },
        data: { type: "object", description: "Key/value map to store." },
        cas: {
          type: "integer",
          description: "Optional check-and-set version; reject the write if the current version differs.",
        },
      },
      required: ["path", "data"],
    },
  },
  async (input, ctx) => {
    const mount = normalizeMount(str(input, "mount") ?? "secret");
    const path = str(input, "path", { required: true }) as string;
    const data = input.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error('argument "data" must be an object');
    }
    const cas = int(input, "cas");
    const body: Record<string, unknown> = { data };
    if (cas !== undefined) body.options = { cas };
    return callArc(() => ctx.client.post(ctx.bearer, `${mount}/data/${path}`, body));
  },
);

const kvList: Tool = guarded(
  {
    name: "arc_kv_list",
    description: "List the immediate children of a KV v2 path. Requires `list` on the prefix.",
    inputSchema: {
      type: "object",
      properties: {
        mount: { type: "string", default: "secret" },
        prefix: { type: "string", description: 'Prefix to list, e.g. "app/prod" (no trailing slash).' },
      },
      required: ["prefix"],
    },
  },
  async (input, ctx) => {
    const mount = normalizeMount(str(input, "mount") ?? "secret");
    const prefix = str(input, "prefix", { required: true }) as string;
    return callArc(() => ctx.client.get(ctx.bearer, `${mount}/metadata/${prefix}`, { list: "true" }));
  },
);

const transitEncrypt: Tool = guarded(
  {
    name: "arc_transit_encrypt",
    description:
      "Encrypt plaintext with a transit key the agent never sees. The key stays inside arc; only ciphertext crosses the boundary. Requires `update` on the key path.",
    inputSchema: {
      type: "object",
      properties: {
        mount: { type: "string", default: "transit" },
        key: { type: "string", description: "Transit key name." },
        plaintext: { type: "string", description: "Base64-encoded plaintext." },
        context: { type: "string", description: "Optional base64 context for derived/convergent keys." },
      },
      required: ["key", "plaintext"],
    },
  },
  async (input, ctx) => {
    const mount = normalizeMount(str(input, "mount") ?? "transit");
    const key = str(input, "key", { required: true }) as string;
    const plaintext = str(input, "plaintext", { required: true }) as string;
    const context = str(input, "context");
    const body: Record<string, unknown> = { plaintext };
    if (context !== undefined) body.context = context;
    return callArc(() => ctx.client.post(ctx.bearer, `${mount}/encrypt/${key}`, body));
  },
);

const transitDecrypt: Tool = guarded(
  {
    name: "arc_transit_decrypt",
    description: "Decrypt a transit ciphertext. Requires `update` on the key path.",
    inputSchema: {
      type: "object",
      properties: {
        mount: { type: "string", default: "transit" },
        key: { type: "string" },
        ciphertext: { type: "string", description: 'arc/Vault ciphertext envelope ("vault:v1:...").' },
        context: { type: "string", description: "Optional base64 context." },
      },
      required: ["key", "ciphertext"],
    },
  },
  async (input, ctx) => {
    const mount = normalizeMount(str(input, "mount") ?? "transit");
    const key = str(input, "key", { required: true }) as string;
    const ciphertext = str(input, "ciphertext", { required: true }) as string;
    const context = str(input, "context");
    const body: Record<string, unknown> = { ciphertext };
    if (context !== undefined) body.context = context;
    return callArc(() => ctx.client.post(ctx.bearer, `${mount}/decrypt/${key}`, body));
  },
);

const dynamicCredsIssue: Tool = guarded(
  {
    name: "arc_dynamic_creds_issue",
    description:
      "Mint short-lived dynamic credentials from a plugin-backed mount (AWS STS, GCP IAM, GitHub App, GitLab, Bitbucket, Azure AD, database, …). Returns the credential payload + `lease_id`, `lease_duration`, and `renewable`. Subsequent renew / revoke uses /v1/sys/leases.",
    inputSchema: {
      type: "object",
      properties: {
        mount: { type: "string", description: 'Mount path (e.g. "aws", "github-app").' },
        role: { type: "string", description: "Role name configured on the plugin." },
        ttl: { type: "integer", description: "Optional TTL hint in seconds (engines clamp to their own max)." },
      },
      required: ["mount", "role"],
    },
  },
  async (input, ctx) => {
    const mount = normalizeMount(str(input, "mount", { required: true }) as string);
    const role = str(input, "role", { required: true }) as string;
    const ttl = int(input, "ttl");
    const path = `${mount}/creds/${role}`;
    return callArc(() =>
      ttl !== undefined ? ctx.client.get(ctx.bearer, path, { ttl: String(ttl) }) : ctx.client.get(ctx.bearer, path),
    );
  },
);

const listMounts: Tool = guarded(
  {
    name: "arc_list_mounts",
    description: "List the engine mounts the caller can see. Useful for discovery before calling other tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  async (_input, ctx) => callArc(() => ctx.client.get(ctx.bearer, "sys/mounts")),
);

/** ----- Engine C: agent identity, authority introspection, revocation (ADR-005) --------- */

const agentsList: Tool = guarded(
  {
    name: "arc_agents_list",
    description:
      "List the agent identities owned by the caller. Returns each agent's id, label, ceiling scopes, autonomous-mode flag and status. Start here to discover agent ids for the other Engine-C tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  async (_input, ctx) => callArc(() => ctx.client.get(ctx.bearer, "vault/agents", undefined, { root: true })),
);

const agentGet: Tool = guarded(
  {
    name: "arc_agent_get",
    description: "Fetch one agent identity by id, including its ceiling scopes and autonomous-mode setting.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string", description: "Agent id (uuid)." } },
      required: ["agentId"],
    },
  },
  async (input, ctx) => {
    const agentId = str(input, "agentId", { required: true }) as string;
    return callArc(() => ctx.client.get(ctx.bearer, `vault/agents/${agentId}`, undefined, { root: true }));
  },
);

const agentAuthorize: Tool = guarded(
  {
    name: "arc_agent_authorize",
    description:
      "Explain whether an agent may perform one action, and why. Evaluates the Engine-C effective-authority meet (delegation \u2229 delegator ceiling \u2229 agent ceiling) for a path + capability and returns the decision. Read-only introspection: it does NOT perform the action and does NOT consume the delegation's call budget. Use it to answer \"what can this agent actually reach?\" before granting or revoking.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent id (uuid)." },
        path: { type: "string", description: 'Target path, e.g. "secret/data/app/prod/db".' },
        capability: {
          type: "string",
          enum: ["create", "read", "update", "delete", "list", "sudo"],
          description: "Capability being tested.",
        },
        delegationId: {
          type: "string",
          description: "Optional: evaluate against one specific delegation instead of the agent's best-matching one.",
        },
      },
      required: ["agentId", "path", "capability"],
    },
  },
  async (input, ctx) => {
    const agentId = str(input, "agentId", { required: true }) as string;
    const path = str(input, "path", { required: true }) as string;
    const capability = str(input, "capability", { required: true }) as string;
    const delegationId = str(input, "delegationId");
    const body: Record<string, unknown> = { path, capability };
    if (delegationId !== undefined) body.delegationId = delegationId;
    return callArc(() =>
      ctx.client.post(ctx.bearer, `vault/agents/${agentId}/authorize`, body, { root: true }),
    );
  },
);

const delegationsList: Tool = guarded(
  {
    name: "arc_agent_delegations_list",
    description:
      "List the delegations issued to an agent — the signed grants that give it scoped authority, with their scopes, budgets, expiry and revocation state.",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string", description: "Agent id (uuid)." } },
      required: ["agentId"],
    },
  },
  async (input, ctx) => {
    const agentId = str(input, "agentId", { required: true }) as string;
    return callArc(() =>
      ctx.client.get(ctx.bearer, `vault/agents/${agentId}/delegations`, undefined, { root: true }),
    );
  },
);

const delegationRevoke: Tool = guarded(
  {
    name: "arc_agent_delegation_revoke",
    description:
      "Revoke one delegation, immediately removing the authority it granted. Irreversible — a new delegation must be signed by the delegator to restore access (which this MCP server cannot do). Use arc_agent_task_close to revoke a whole task's delegations at once.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent id (uuid)." },
        delegationId: { type: "string", description: "Delegation id to revoke." },
      },
      required: ["agentId", "delegationId"],
    },
  },
  async (input, ctx) => {
    const agentId = str(input, "agentId", { required: true }) as string;
    const delegationId = str(input, "delegationId", { required: true }) as string;
    return callArc(() =>
      ctx.client.delete(ctx.bearer, `vault/agents/${agentId}/delegations/${delegationId}`, { root: true }),
    );
  },
);

const taskOpen: Tool = guarded(
  {
    name: "arc_agent_task_open",
    description:
      "Open a task for an agent: the revocable unit of work and the anchor of its signed-intent hash chain. A task carries a budget (wall-clock, max calls, max secrets unsealed) that the server enforces. Opening a task does NOT itself grant authority — that requires a delegation signed by the delegator.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent id (uuid)." },
        taskId: { type: "string", description: "Optional explicit task id (uuid) — e.g. the one a delegation was signed against." },
        delegationId: { type: "string", description: "Optional delegation this task runs under." },
        budget: {
          type: "object",
          description: "Optional budget caps; the server applies defaults for anything omitted.",
          properties: {
            wallClockMs: { type: "integer", minimum: 1, description: "Wall-clock lifetime in ms." },
            maxCalls: { type: "integer", minimum: 1, description: "Maximum authorized calls." },
            maxSecretsUnsealed: { type: "integer", minimum: 1, description: "Maximum distinct secrets unsealed." },
          },
          additionalProperties: false,
        },
      },
      required: ["agentId"],
    },
  },
  async (input, ctx) => {
    const agentId = str(input, "agentId", { required: true }) as string;
    const taskId = str(input, "taskId");
    const delegationId = str(input, "delegationId");
    const body: Record<string, unknown> = {};
    if (taskId !== undefined) body.taskId = taskId;
    if (delegationId !== undefined) body.delegationId = delegationId;
    if (input.budget !== undefined) {
      const budget = input.budget;
      if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
        throw new Error('argument "budget" must be an object');
      }
      body.budget = budget;
    }
    return callArc(() => ctx.client.post(ctx.bearer, `vault/agents/${agentId}/tasks`, body, { root: true }));
  },
);

const taskGet: Tool = guarded(
  {
    name: "arc_agent_task_get",
    description:
      "Fetch a task's state: budget consumed vs remaining, status, and its recorded signed-intent chain. Set verify=true to re-verify the intent chain server-side — each intent's signature and its link to the previous hash — which detects tampering or omission in the agent's action history.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent id (uuid)." },
        taskId: { type: "string", description: "Task id (uuid)." },
        verify: { type: "boolean", description: "Re-verify the signed-intent hash chain (default false).", default: false },
      },
      required: ["agentId", "taskId"],
    },
  },
  async (input, ctx) => {
    const agentId = str(input, "agentId", { required: true }) as string;
    const taskId = str(input, "taskId", { required: true }) as string;
    const verify = input.verify;
    if (verify !== undefined && typeof verify !== "boolean") {
      throw new Error('argument "verify" must be a boolean');
    }
    const query = verify === true ? { verify: "true" } : undefined;
    return callArc(() =>
      ctx.client.get(ctx.bearer, `vault/agents/${agentId}/tasks/${taskId}`, query, { root: true }),
    );
  },
);

const taskClose: Tool = guarded(
  {
    name: "arc_agent_task_close",
    description:
      "Close a task and cascade-revoke everything it holds — its delegations and every lease issued under it. This is the one-shot kill switch for a running agent: after it returns, the agent has no authority from that task. Irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Agent id (uuid)." },
        taskId: { type: "string", description: "Task id (uuid) to close." },
      },
      required: ["agentId", "taskId"],
    },
  },
  async (input, ctx) => {
    const agentId = str(input, "agentId", { required: true }) as string;
    const taskId = str(input, "taskId", { required: true }) as string;
    return callArc(() =>
      ctx.client.post(ctx.bearer, `vault/agents/${agentId}/tasks/${taskId}/close`, {}, { root: true }),
    );
  },
);

const approvalsList: Tool = guarded(
  {
    name: "arc_approvals_list",
    description:
      "List the caller's pending human-in-the-loop approvals — elevated agent actions waiting on consent. Read-only: granting one requires a WebAuthn assertion from the owner's authenticator and cannot be done through MCP.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  async (_input, ctx) => callArc(() => ctx.client.get(ctx.bearer, "vault/approvals", undefined, { root: true })),
);

export const tools: readonly Tool[] = Object.freeze([
  // Engine A — secrets engines
  kvGet,
  kvPut,
  kvList,
  transitEncrypt,
  transitDecrypt,
  dynamicCredsIssue,
  listMounts,
  // Engine C — agent identity: inspect + revoke (never grant)
  agentsList,
  agentGet,
  agentAuthorize,
  delegationsList,
  delegationRevoke,
  taskOpen,
  taskGet,
  taskClose,
  approvalsList,
]);
