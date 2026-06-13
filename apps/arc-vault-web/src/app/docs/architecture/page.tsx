import { ArchitectureDiagram } from "../components/architecture-diagram";
import { Callout } from "../components/callout";
import { CodeBlock } from "../components/code-block";
import { DocsPrevNext } from "../components/docs-prev-next";
import { highlightAll } from "../components/highlight";

export const metadata = { title: "Architecture · arc docs" };

const snippets = {
  packages: {
    code: `packages/      arc-types · arc-crypto · arc-grants · arc-leasing · arc-secrets-engine · arc-plugin-sdk
apps/          arc-server · arc-vault-web · arc-vault-desktop · arc-browser-extension · arc-cli · arc-operator
sdks/          arc-js-sdk · arc-go-sdk
plugins/       cloud/{aws,gcp,azure} · scm/{github,gitlab,bitbucket}
integrations/  arc-openbao-adapter · arc-mcp-server
crates/        vault-crypto-rs · desktop-core · arc-agent
infra/         arc-helm-charts · arc-terraform · arc-release
docs/          protocol specs · ADRs · manual-testing playbook · STATUS.md`,
    lang: "text",
  },
  deps: {
    code: `plugins/*       → arc-plugin-sdk, arc-types ONLY
apps/*          → packages/*, sdks/*, integrations/*
sdks/*          → packages/* ONLY
integrations/*  → packages/* + external clients (OpenBao API)
packages/*      → other packages/* (per graph in docs/CLAUDE.md)
infra/*         → no imports from packages/apps
docs/*          → no code imports`,
    lang: "text",
  },
};

export default async function ArchitecturePage() {
  const h = await highlightAll(snippets);
  return (
    <>
      <h1>Architecture</h1>
      <p>
        arc is one control plane (<code>arc-server</code>, NestJS) routing three engines
        behind one identity, one policy engine, and one audit pipeline. The control plane
        never sees a master password or any vault plaintext — only ciphertext envelopes,
        signed delegations, and the metadata they carry.
      </p>

      <h2>The whole picture</h2>
      <p>
        Pan and zoom the diagram below. <strong>Blue</strong> is Engine A (infrastructure
        secrets), <strong>violet</strong> is Engine B (E2E vault),{" "}
        <strong>amber</strong> is Engine C (agents). The dashed edge from Engine C down to
        leases shows the <code>closeTask()</code> cascade — the audit HIGH-C remediation
        guarantees a closed task revokes every dependent lease + delegation + outstanding
        agent JWT in one operation.
      </p>
      <div className="not-prose">
        <ArchitectureDiagram />
      </div>

      <h2>Trust boundary</h2>
      <p>
        The whole zero-knowledge claim collapses to this picture: <strong>keys are derived
        and used only on the client</strong>; the server is a blind ciphertext store.
      </p>
      <div className="not-prose my-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border bg-card p-5">
          <h3 className="mb-2 font-semibold tracking-tight">Client — trusted</h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>Master password → Argon2id → MK</li>
            <li>MK → HKDF → identity, signing, wrapping keys</li>
            <li>Items encrypted, signed, and packaged locally</li>
            <li>
              Rust on the desktop (<code>vault-crypto-rs</code>) — TypeScript everywhere else
              (<code>@arc/crypto</code>), verified byte-for-byte against shared KAT vectors
            </li>
          </ul>
        </div>
        <div className="rounded-xl border bg-card p-5">
          <h3 className="mb-2 font-semibold tracking-tight">Server — blind</h3>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>Stores ciphertext envelopes, signatures, and policy / audit metadata</li>
            <li>Never receives a key, plaintext, or master password</li>
            <li>
              Runs ACL decisions on signed-claim subjects (users, agents) and tamper-evident
              chains (vault head + per-task intent chain)
            </li>
            <li>OpenTelemetry traces + Prometheus <code>/metrics</code> built in</li>
          </ul>
        </div>
      </div>
      <Callout kind="success" title="Zero-knowledge in practice">
        Take a postgres backup, snapshot the disk, subpoena the operator: the rows you find
        are envelopes the server doesn't have the keys to open. The threat model in{" "}
        <a href="https://github.com/ethchor/arc/blob/develop/docs/02-threat-model.md">
          docs/02
        </a>{" "}
        spells out what the server <em>can</em> still learn (size, timing, membership graph)
        and what mitigations are in place.
      </Callout>

      <h2>Monorepo layout</h2>
      <p>
        pnpm workspaces + Turborepo with <strong>strict, enforced dependency boundaries</strong>:
      </p>
      <CodeBlock html={h.packages} raw={snippets.packages.code} filename="repo layout" />
      <p>
        Nothing in <code>packages/</code> may import from <code>apps/</code>; plugins are
        sandboxed to <code>arc-plugin-sdk</code> and <code>arc-types</code>; integrations
        wrap external APIs and don't reach into app internals.
      </p>
      <CodeBlock html={h.deps} raw={snippets.deps.code} filename="dependency rules" />

      <h2>Where to learn more</h2>
      <ul>
        <li>
          <a href="/docs/engines/engine-a">Engine A</a> — infrastructure secrets, backed by
          OpenBao (MPL 2.0) behind a swap-out-able adapter.
        </li>
        <li>
          <a href="/docs/engines/engine-b">Engine B</a> — the end-to-end vault: keys, items,
          sharing, recovery, multi-device.
        </li>
        <li>
          <a href="/docs/engines/engine-c">Engine C</a> — agent identity, signed delegation,
          per-task hash chains, push-consent.
        </li>
      </ul>

      <DocsPrevNext href="/docs/architecture" />
    </>
  );
}
