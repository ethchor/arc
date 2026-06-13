import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Bot,
  KeyRound,
  Lock,
  Network,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { FeatureCard } from "./components/feature-card";
import { ArchitectureDiagram } from "./components/architecture-diagram";

export default function DocsLanding() {
  return (
    <>
      <div className="not-prose mb-8 rounded-2xl border bg-gradient-to-br from-primary/10 via-card to-card p-8 shadow-sm">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs">
          <Sparkles className="h-3 w-3 text-primary" /> 24 / 24 audit findings closed · zero-knowledge by architecture · post-quantum hybrid by default
        </div>
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">arc documentation</h1>
        <p className="mt-3 max-w-2xl text-base text-muted-foreground">
          arc unifies <strong className="text-foreground">infrastructure secrets</strong> (KV,
          transit, PKI, dynamic credentials) and an{" "}
          <strong className="text-foreground">end-to-end-encrypted vault</strong> (passwords,
          passkeys, TOTP, notes, sharing) under one identity, one policy engine, and one audit
          trail. <strong className="text-foreground">Agents</strong> are a first-class principal
          with a cryptographic human→agent→action chain.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link
            href="/docs/getting-started"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Quick start <ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <Link
            href="/docs/architecture"
            className="inline-flex items-center gap-1.5 rounded-md border bg-card px-4 py-2 text-sm font-medium hover:border-primary/40"
          >
            Explore the architecture
          </Link>
        </div>
      </div>

      <h2 className="!mt-0 !border-0 !pb-0">Three engines, one control plane</h2>
      <p>
        Every request — human or agent — flows through the same identity, policy, and audit
        pipeline. Pan and zoom the diagram below; each cluster is one engine, and the dashed
        link on the right shows how closing an agent task cascades a revoke down to leased
        infrastructure credentials.
      </p>
      <div className="not-prose">
        <ArchitectureDiagram />
      </div>

      <h2>Where to start</h2>
      <div className="not-prose my-6 grid gap-4 sm:grid-cols-2">
        <FeatureCard
          icon={<KeyRound className="h-4 w-4" />}
          title="Engine A — infrastructure secrets"
          href="/docs/engines/engine-a"
        >
          KV v2, transit encryption-as-a-service, PKI X.509, and dynamic credentials for AWS,
          GCP, Azure, GitHub, GitLab, and Bitbucket. Routed per-mount behind the{" "}
          <strong>MountRegistry</strong> so backends are swappable.
        </FeatureCard>
        <FeatureCard
          icon={<Lock className="h-4 w-4" />}
          title="Engine B — end-to-end vault"
          href="/docs/engines/engine-b"
        >
          Passwords, TOTP, secure notes, item-level sharing, multi-device, passkey unlock,
          recovery — all client-encrypted. The server stores only ciphertext.
        </FeatureCard>
        <FeatureCard
          icon={<Bot className="h-4 w-4" />}
          title="Engine C — agentic identity"
          href="/docs/engines/engine-c"
        >
          First-class agent principals, signed narrow-only delegations, signed intents folded
          into a per-task hash chain, push-consent CIBA via passkeys, and an MCP server.
        </FeatureCard>
        <FeatureCard
          icon={<Network className="h-4 w-4" />}
          title="Architecture deep dive"
          href="/docs/architecture"
        >
          The full control-plane map: how the surfaces, the engines, the policy engine, and
          the storage layers fit together. Interactive React Flow diagram with engine-coloured
          clusters and revoke-cascade edges.
        </FeatureCard>
      </div>

      <h2>By persona</h2>
      <p>
        Pick the role that matches what you're building — each page walks through the smallest
        useful end-to-end story for that surface, plus copy-paste code.
      </p>
      <ul className="not-prose mt-4 grid gap-3 sm:grid-cols-2">
        <li>
          <Link
            href="/docs/getting-started"
            className="group block rounded-lg border bg-card p-4 transition-colors hover:border-primary/40"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4 text-primary" /> Platform engineer
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Stand up arc-server locally, wire OpenBao, see KV + transit + PKI work.
            </p>
          </Link>
        </li>
        <li>
          <Link
            href="/docs/engines/engine-b"
            className="group block rounded-lg border bg-card p-4 transition-colors hover:border-primary/40"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <Lock className="h-4 w-4 text-primary" /> Person / team
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Enroll, unlock, store an item, share it — verify the server never sees plaintext.
            </p>
          </Link>
        </li>
        <li>
          <Link
            href="/docs/reference/api"
            className="group block rounded-lg border bg-card p-4 transition-colors hover:border-primary/40"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <BookOpen className="h-4 w-4 text-primary" /> SDK / API integrator
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              REST endpoints, error codes, wire shapes. The TypeScript SDK is the reference
              client.
            </p>
          </Link>
        </li>
        <li>
          <Link
            href="/docs/engines/engine-c"
            className="group block rounded-lg border bg-card p-4 transition-colors hover:border-primary/40"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <Bot className="h-4 w-4 text-primary" /> Agent / MCP builder
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Mint an agent identity, exercise a signed delegation, submit signed intents,
              prove cascading revoke works.
            </p>
          </Link>
        </li>
      </ul>

      <h2>This site at a glance</h2>
      <p>
        Every page in the sidebar is generated from the same source of truth as the protocol
        specs in <code>docs/</code> and the manual-testing playbooks. If you spot a drift,
        please open an issue — the docs site, the README, the spec docs, and the codebase are
        all on a single CI gate.
      </p>
    </>
  );
}
