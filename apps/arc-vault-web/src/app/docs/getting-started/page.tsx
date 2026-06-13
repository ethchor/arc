import { CodeBlock } from "../components/code-block";
import { Callout } from "../components/callout";
import { DocsPrevNext } from "../components/docs-prev-next";
import { highlightAll } from "../components/highlight";

export const metadata = { title: "Quick start · arc docs" };

const snippets = {
  prereqs: {
    code: `node --version       # v22.x or v24.x
pnpm --version       # 10.x
docker --version     # optional (Engine A only)
rustc --version      # optional (Rust crates only)`,
    lang: "bash",
  },
  install: {
    code: `git clone https://github.com/ethchor/arc.git
cd arc
pnpm install
pnpm build           # ~90 s cold, ~10 s warm (turbo cache)`,
    lang: "bash",
  },
  startServer: {
    code: `# MED-C opt-in: required for /auth/dev-login to work in dev.
ARC_ENABLE_DEV_LOGIN=true pnpm --filter @arc/server start`,
    lang: "bash",
  },
  serverLog: {
    code: `[arc-vault] JWT_SECRET not set; using an ephemeral random secret (dev/test only).
INFO Starting Nest application...
INFO Engine-A disabled (BAO_ADDR unset); /v1/* will return 503
INFO Nest application successfully started
INFO arc-vault API listening on :3001`,
    lang: "text",
  },
  verify: {
    code: `curl -s -o /dev/null -w 'HTTP %{http_code}\\n' http://localhost:3001/metrics
# → HTTP 200

curl -s -X POST http://localhost:3001/auth/dev-login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"hello@example.com"}'
# → { "accessToken": "eyJ...", "userId": 1 }`,
    lang: "bash",
  },
  startWeb: {
    code: `pnpm --filter @arc/vault-web dev
# → open http://localhost:3000`,
    lang: "bash",
  },
  optBao: {
    code: `# Boot OpenBao (pinned tag — never use :latest).
docker compose -f integrations/arc-openbao-adapter/docker-compose.yml up -d

# Tell arc-server where it lives and restart.
export BAO_ADDR=http://127.0.0.1:8200
export BAO_TOKEN=root
ARC_ENABLE_DEV_LOGIN=true pnpm --filter @arc/server start`,
    lang: "bash",
  },
  prod: {
    code: `JWT_SECRET="$(openssl rand -hex 32)" \\
DATABASE_URL=postgres://arc:arc@localhost:5432/arc \\
NODE_ENV=production \\
ARC_DEFAULT_POLICY=deny \\
ARC_ROOT_USERS=alice@example.com \\
pnpm --filter @arc/server start`,
    lang: "bash",
  },
};

export default async function GettingStartedPage() {
  const h = await highlightAll(snippets);
  return (
    <>
      <h1>Quick start</h1>
      <p>
        Get arc running on your machine in about 60 seconds. The dev profile uses an in-memory
        database and a per-boot JWT secret, so you don't need to provision anything.
      </p>

      <h2>Prerequisites</h2>
      <p>Node 22 LTS or 24 LTS, pnpm 10. Docker and Rust are optional.</p>
      <CodeBlock html={h.prereqs} raw={snippets.prereqs.code} language="bash" />
      <Callout kind="tip">
        Missing pnpm? <code>corepack enable && corepack prepare pnpm@latest --activate</code>.
        Wrong Node? <code>fnm use 22</code> or <code>nvm install --lts</code>.
      </Callout>

      <h2>1 · Install and build</h2>
      <CodeBlock html={h.install} raw={snippets.install.code} language="bash" filename="terminal" />

      <h2>2 · Run the API server</h2>
      <CodeBlock html={h.startServer} raw={snippets.startServer.code} language="bash" />
      <p>You should see something like:</p>
      <CodeBlock html={h.serverLog} raw={snippets.serverLog.code} filename="arc-server" />
      <Callout kind="warning" title="ARC_ENABLE_DEV_LOGIN">
        The audit MED-C remediation made <code>/auth/dev-login</code> opt-in even in dev so
        deploys that forgot <code>NODE_ENV</code> can't accidentally ship a "log in as anyone"
        RPC. Without it the endpoint 403s with <code>dev_login_disabled</code>. In production
        it's force-disabled regardless of the env var.
      </Callout>

      <h2>3 · Verify it's up</h2>
      <CodeBlock html={h.verify} raw={snippets.verify.code} language="bash" />
      <p>
        <code>/metrics</code> exposes Prometheus counters with no auth (network-layer access
        control). <code>/auth/dev-login</code> mints a real JWT_SECRET-signed token you can
        pass as <code>Authorization: Bearer …</code>.
      </p>

      <h2>4 · Run the web console</h2>
      <CodeBlock html={h.startWeb} raw={snippets.startWeb.code} language="bash" />
      <p>
        Open <code>http://localhost:3000</code> and click <em>Create account</em>. The master
        password and every derived key stay on the client — the server only receives
        ciphertext.
      </p>

      <h2>5 · Optional · Engine A</h2>
      <p>
        Want infrastructure secrets too? Boot OpenBao with the bundled compose file. The image
        tag is pinned to the same version the Helm chart ships (MED-I — never{" "}
        <code>:latest</code>).
      </p>
      <CodeBlock html={h.optBao} raw={snippets.optBao.code} language="bash" />

      <h2>Production-style boot</h2>
      <p>
        The dev profile is intentionally permissive. To prove your install would also survive a
        real prod start:
      </p>
      <CodeBlock html={h.prod} raw={snippets.prod.code} language="bash" />
      <p>
        The server now refuses to boot without <code>DATABASE_URL</code> and{" "}
        <code>JWT_SECRET</code>, runs TypeORM migrations (not synchronize), defaults the policy
        to deny, and force-disables dev-login. This is the posture the Helm chart and Terraform
        module deploy with.
      </p>

      <DocsPrevNext href="/docs/getting-started" />
    </>
  );
}
