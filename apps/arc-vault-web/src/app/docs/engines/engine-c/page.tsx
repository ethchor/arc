import { Callout } from "../../components/callout";
import { CodeBlock } from "../../components/code-block";
import { DocsPrevNext } from "../../components/docs-prev-next";
import { highlightAll } from "../../components/highlight";

export const metadata = { title: "Engine C — agentic identity · arc docs" };

const snippets = {
  registerAgent: {
    code: `import { VaultClient } from "@arc/sdk";

const owner = new VaultClient({ baseUrl: "http://localhost:3001", profile: "test" });
await owner.devLogin("alice@example.com");
await owner.enroll("master-pw");

// Generate an agent keyset and register it.
const keyset = VaultClient.generateAgentKeyset();
const agent = await owner.registerAgent({
  displayName: "ci-deploy-bot",
  publicKeys: keyset.publicKeys,
});`,
    lang: "typescript",
  },
  delegate: {
    code: `// Sign a narrow, time-boxed delegation. The decision at evaluation time is the
// intersection of (delegated ∩ delegator-policy ∩ agent-policy) — a delegation
// can only ever narrow, never escalate.
const delegation = await owner.createDelegation(agent.id, {
  scopes: [{ pathPrefix: "secret/data/app", capabilities: ["read"] }],
  ttlMs: 60 * 60 * 1000, // 1 hour
});

// Open a task — this is the revocable unit. closeTask cascades a revoke down
// to every delegation, lease, and outstanding agent JWT (HIGH-C).
const task = await owner.openTask(agent.id, { delegationId: delegation.id });`,
    lang: "typescript",
  },
  agentAuth: {
    code: `// Agent authenticates with its own signing key via challenge-response.
// The JWT carries the owner as \`sub\` + the RFC 8693 \`act\` claim, and is
// pinned to the agent's \`tokenEpoch\` so closeTask() revokes it instantly.
const agentClient = new VaultClient({ baseUrl: "http://localhost:3001" });
const { accessToken } = await agentClient.agentToken(agent.id, keyset.signing.priv);
agentClient.useBearerToken(accessToken);`,
    lang: "typescript",
  },
  submitIntent: {
    code: `// Every action is a signed intent. argsDigest binds the body; prevChainHead
// binds the chain position (MED-E) — the server refuses any intent whose
// prevChainHead disagrees with its own head with 409 intent_chain_mismatch.
import { ZERO_CHAIN } from "@arc/crypto";

let chainHead = ZERO_CHAIN;
const result = await agentClient.submitIntent(agent.id, keyset.signing.priv, {
  taskId: task.taskId,
  delegationId: delegation.id,
  op: "kv.read",
  path: "secret/data/app/db",
  prevChainHead: chainHead,
});
chainHead = result.chainHead; // for the next intent on this task`,
    lang: "typescript",
  },
  close: {
    code: `// Owner closes the task. tokenEpoch bumps; every outstanding agent JWT for
// this agent now fails with 401 agent_token_revoked. Re-auth mints a fresh one.
await owner.closeTask(agent.id, task.taskId);

// The same JWT used above:
await agentClient.submitIntent(agent.id, keyset.signing.priv, { ... });
// → 401 { error: "agent_token_revoked", reason: "epoch_mismatch" }`,
    lang: "typescript",
  },
};

export default async function EngineCPage() {
  const h = await highlightAll(snippets);
  return (
    <>
      <h1>Engine C — agentic identity</h1>
      <p>
        Engine C is arc's first-class agent surface. Agents are not service accounts dressed
        up as humans — they are their own principal type, with their own keypair, their own
        policy attachments, and their own signed-intent chain. The trust chain from{" "}
        <em>human → agent → action</em> is a cryptographic artifact, not a stack of bearer
        tokens.
      </p>

      <h2>What ADR-005 gives you</h2>
      <ul>
        <li>
          <strong>Verifiable agent identity</strong> — Ed25519 signing + X25519/ML-KEM hybrid
          identity per agent, attached to <code>@arc/grants</code> via the{" "}
          <code>agent:&lt;id&gt;</code> subject handle. Optional SPIFFE / sigstore / TPM
          attestation behind a pluggable verifier.
        </li>
        <li>
          <strong>Signed delegations that can only narrow</strong> — effective decision is
          the intersection of <code>delegated ∩ delegator-policy ∩ agent-policy</code>. A
          delegation can never escalate beyond the delegator's authority.
        </li>
        <li>
          <strong>Signed intents + per-task hash chain</strong> — every action is signed by
          the agent; <code>argsDigest</code> binds the body; <code>prevChainHead</code> binds
          the chain position (audit MED-E). Tamper-evidence is intrinsic.
        </li>
        <li>
          <strong>Push-consent CIBA via passkeys</strong> — elevated actions block until the
          owning human proves control with a WebAuthn assertion. The challenge is derived
          from the intent digest (audit MED-F) so the assertion can't be redirected to a
          different intent.
        </li>
        <li>
          <strong>Revocable tokens via <code>tokenEpoch</code></strong> — every JWT carries
          the epoch at issuance; <code>closeTask()</code> bumps it (audit HIGH-C) and every
          outstanding JWT for that agent fails on the next request with{" "}
          <code>agent_token_revoked</code>.
        </li>
      </ul>

      <h2>End-to-end walkthrough</h2>

      <h3>Register an agent</h3>
      <CodeBlock html={h.registerAgent} raw={snippets.registerAgent.code} language="typescript" />

      <h3>Delegate scoped, time-boxed authority</h3>
      <CodeBlock html={h.delegate} raw={snippets.delegate.code} language="typescript" />

      <h3>Agent authenticates with its own key</h3>
      <CodeBlock html={h.agentAuth} raw={snippets.agentAuth.code} language="typescript" />

      <h3>Submit a signed intent</h3>
      <CodeBlock html={h.submitIntent} raw={snippets.submitIntent.code} language="typescript" />

      <h3>Owner closes the task → JWT is revoked instantly</h3>
      <CodeBlock html={h.close} raw={snippets.close.code} language="typescript" />

      <Callout kind="success" title="The agent surface is end-to-end testable">
        Every behaviour described above is exercised by{" "}
        <code>apps/arc-server/test/agent-*.e2e-spec.ts</code> — including the HIGH-C
        regression that opens a task, mints an agent JWT, proves it works pre-close, closes
        the task, and proves the same JWT now 401s with{" "}
        <code>agent_token_revoked</code>.
      </Callout>

      <h2>MCP server</h2>
      <p>
        The Engine-C credential path is exposed as Model Context Protocol tools via{" "}
        <code>integrations/arc-mcp-server</code>. Any MCP-capable agent authenticates via the
        challenge-response, receives a short-lived JWT carrying the RFC 8693 <code>act</code>{" "}
        claim, and calls arc operations as MCP tools — each authorised by{" "}
        <code>@arc/grants</code>, recorded in the audit log, and{" "}
        <strong>never handed the E2E master key</strong>.
      </p>

      <DocsPrevNext href="/docs/engines/engine-c" />
    </>
  );
}
