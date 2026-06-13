import { Callout } from "../../components/callout";
import { CodeBlock } from "../../components/code-block";
import { DocsPrevNext } from "../../components/docs-prev-next";
import { highlightAll } from "../../components/highlight";

export const metadata = { title: "Engine A — infrastructure secrets · arc docs" };

const snippets = {
  put: {
    code: `# Store a KV v2 secret. arc-server proxies through the OpenBao adapter.
curl -X POST http://localhost:3001/v1/secret/data/app/db \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": {
      "DATABASE_URL": "postgres://app:secret@db/app"
    }
  }'`,
    lang: "bash",
  },
  get: {
    code: `# Read it back.
curl -s http://localhost:3001/v1/secret/data/app/db \\
  -H "Authorization: Bearer $TOKEN" | jq .data.data
# → { "DATABASE_URL": "postgres://app:secret@db/app" }`,
    lang: "bash",
  },
  transit: {
    code: `# Create a transit key.
curl -X POST http://localhost:3001/v1/transit/keys/payments \\
  -H "Authorization: Bearer $TOKEN"

# Encrypt — the engine never gives you the key.
curl -X POST http://localhost:3001/v1/transit/encrypt/payments \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{ "plaintext": "'"$(echo -n 'card 4111…' | base64)"'" }'
# → { "data": { "ciphertext": "vault:v1:abc…" } }`,
    lang: "bash",
  },
  dynamic: {
    code: `# Dynamic AWS STS — arc returns a short-lived assume-role credential.
# The plugin manifest is signed; arc-server refuses to mount unsigned plugins
# in production (MED-D).
curl -s http://localhost:3001/v1/aws/creds/read-only \\
  -H "Authorization: Bearer $TOKEN" | jq
# → {
#     "lease_id": "aws/creds/read-only/abc",
#     "lease_duration": 3600,
#     "data": {
#       "access_key": "AKIA...",
#       "secret_key": "...",
#       "session_token": "..."
#     }
#   }`,
    lang: "bash",
  },
};

export default async function EngineAPage() {
  const h = await highlightAll(snippets);
  return (
    <>
      <h1>Engine A — infrastructure secrets</h1>
      <p>
        Engine A is the surface every workload talks to: KV v2 versioned storage, transit
        encryption-as-a-service, PKI X.509 issuance, and dynamic credentials for cloud and SCM
        providers. The wire shape is Vault-compatible so existing Vault CLIs, SDKs, and
        sidecars work unchanged.
      </p>

      <h2>What's available</h2>
      <ul>
        <li>
          <strong>KV v2</strong> — versioned secret storage with soft-delete + metadata.
        </li>
        <li>
          <strong>Transit</strong> — encrypt / decrypt / rotate without exposing the key
          material. Useful for application-side encryption-at-rest.
        </li>
        <li>
          <strong>PKI</strong> — issue and revoke X.509 certificates against a role-scoped CA.
        </li>
        <li>
          <strong>Dynamic credentials</strong> — AWS, GCP, Azure, GitHub, GitLab, Bitbucket.
          Issue-on-demand, auto-expiring tokens with central lease tracking + revoke.
        </li>
      </ul>

      <h2>How it's wired</h2>
      <p>
        The <code>@arc/secrets-engine</code> contract describes <em>what</em> a secrets
        backend does. <code>integrations/arc-openbao-adapter</code> implements it against a
        colocated OpenBao server. Every Engine-A request flows through the{" "}
        <code>MountRegistry</code> so the backend is swappable per mount — you can mount
        Engine A onto a different backend tomorrow without touching the SDK.
      </p>
      <Callout kind="info" title="Why OpenBao">
        OpenBao (MPL 2.0) gives us a battle-tested barrier, seal/unseal, Raft consensus, PKI
        CA, and KV engine for the cost of an HTTP adapter. The license is weak copyleft —
        modifications to MPL files stay MPL, but combining with proprietary arc code and
        shipping commercially is fine. See <code>integrations/arc-openbao-adapter/CLAUDE.md</code>{" "}
        for the boundary doc.
      </Callout>

      <h2>Examples</h2>

      <h3>KV — store + retrieve a secret</h3>
      <CodeBlock html={h.put} raw={snippets.put.code} language="bash" />
      <CodeBlock html={h.get} raw={snippets.get.code} language="bash" />

      <h3>Transit — encryption as a service</h3>
      <CodeBlock html={h.transit} raw={snippets.transit.code} language="bash" />
      <p>
        The transit key never leaves the engine. Your application sends plaintext bytes,
        receives a portable <code>vault:vN:…</code> ciphertext string, and stores that. Key
        rotation advances <code>latestVersion</code> while older versions remain valid for
        decrypt until explicitly trimmed.
      </p>

      <h3>Dynamic credentials</h3>
      <CodeBlock html={h.dynamic} raw={snippets.dynamic.code} language="bash" />

      <Callout kind="warning" title="Engine A authorization is enforced by @arc/grants">
        Every <code>/v1/*</code> request runs through the <code>CapabilityGuard</code>, which
        maps HTTP method → capability (<code>GET=read</code>,{" "}
        <code>GET?list=true=list</code>, <code>POST=create</code>, <code>PUT=update</code>,{" "}
        <code>DELETE=delete</code>) and asks <code>@arc/grants</code>. In production the
        default mode is <strong>deny</strong> (audit CRIT-B), so users need an explicit policy
        attached before any Engine-A operation succeeds. See{" "}
        <a href="/docs/reference/env-vars">
          ARC_DEFAULT_POLICY + ARC_ROOT_USERS
        </a>
        .
      </Callout>

      <h2>Production hardening</h2>
      <ul>
        <li>
          Pin the OpenBao image to a concrete tag, never <code>:latest</code> — the Helm
          chart, CI, and the docker-compose dev file all ship <code>2.3.1</code> (audit MED-I).
        </li>
        <li>
          Block on critical CVEs: <code>pnpm audit --audit-level=critical</code> is
          CI-blocking; <code>cargo audit</code> is too. The chart enforces a non-empty
          <code>jwtSecret</code> via a <code>required</code> guard (audit MED-B).
        </li>
        <li>
          Use the Helm chart at <code>infra/arc-helm-charts/arc/</code> or the Terraform
          module at <code>infra/arc-terraform/modules/arc/</code>.
        </li>
      </ul>

      <DocsPrevNext href="/docs/engines/engine-a" />
    </>
  );
}
