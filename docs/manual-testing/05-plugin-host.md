# 05 — Plugin host (AWS / GCP / GitHub)

`PluginsService` in arc-server hosts secrets plugins. Each plugin claims a mount path and
answers `GET /v1/<mount>/creds/<role>` like a native engine. There are **three ways to
mount one**, and this guide uses all of them:

| Path | When to use it | Persists restart? |
| --- | --- | --- |
| `ARC_PLUGIN_MOUNTS=<path>=<bin>?manifest=<json>` env | production / boot-time, signed OOP artifacts | yes — env is the source of truth |
| `POST /v1/sys/plugins/mounts` admin API (ADR-009) | live mount/unmount without bouncing the server | **no** — response includes the `envSnippet` to make it stick |
| programmatic `mountSecretsPlugin()` in a custom main | **this guide's fake-vendor testing** — inject in-memory transports | n/a (dev entrypoint) |

The env + admin paths run every artifact through the signed-manifest gate
(`ARC_PLUGIN_TRUST_ANCHORS` pins publishers); the operator-side
`arc-vault plugin install|uninstall` CLI verifies a release and prints exactly these env
snippets / admin `curl`s. Sections A–F below use the programmatic path because injecting
**fake vendor transports** (no real AWS/GCP/GitHub accounts) requires constructing the
plugin instance yourself; section G exercises the admin API + env path with the signed
OOP artifact.

## Approach: a custom main entry that mounts plugins at boot

Create `apps/arc-server/src/manual-main.ts`:

```ts
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { PluginsService } from "./plugins/plugins.service";
import { AwsSecretsPlugin } from "@arc/plugin-aws";
import { GcpSecretsPlugin } from "@arc/plugin-gcp";
import { GitHubAppPlugin } from "@arc/plugin-github";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const plugins = app.get(PluginsService);

  // Pluggable transports — each plugin accepts the interface and any impl.
  // For manual testing, hand-roll a fake that returns fixed credentials so you don't
  // need real AWS / GCP / GitHub accounts:

  const fakeAwsSts = {
    async assumeRole({ roleArn, sessionName, durationSeconds }) {
      return {
        accessKeyId: `AKIA-FAKE-${sessionName}`,
        secretAccessKey: "fake-secret-key",
        sessionToken: `fake-session-${sessionName}`,
        expirationSeconds: durationSeconds,
        assumedRoleArn: `arn:aws:sts::000000000000:assumed-role/x/${sessionName}`,
      };
    },
  };

  await plugins.mountSecretsPlugin(new AwsSecretsPlugin(fakeAwsSts), "aws/", {
    roles: {
      "read-only": {
        roleArn: "arn:aws:iam::000000000000:role/arc-read",
        defaultTtlSeconds: 1800,
        maxTtlSeconds: 3600,
      },
    },
  });

  const fakeGcpIam = {
    async generateAccessToken({ targetServiceAccount, lifetimeSeconds }) {
      return {
        accessToken: `ya29.${targetServiceAccount.split("@")[0]}.fake`,
        expirationSeconds: lifetimeSeconds,
      };
    },
  };

  await plugins.mountSecretsPlugin(new GcpSecretsPlugin(fakeGcpIam), "gcp/", {
    roles: {
      "deploy": {
        targetServiceAccount: "deploy@arc-manual.iam.gserviceaccount.com",
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        defaultTtlSeconds: 3600,
      },
    },
  });

  const fakeGitHub = {
    async createInstallationToken({ installationId, repositories }) {
      return {
        token: `ghs_fake_${installationId}`,
        expirationSeconds: 3600,
        permissions: { contents: "read" },
        repositorySelection: repositories ? "selected" : "all",
      };
    },
  };

  await plugins.mountSecretsPlugin(new GitHubAppPlugin(fakeGitHub), "github/", {
    appId: 1,
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
    roles: {
      "ci": { installationId: 1, permissions: { contents: "read", actions: "write" } },
    },
  });

  await app.listen(3001);
  new Logger("Bootstrap").log("arc-server (manual mode) listening on :3001");
}
bootstrap();
```

Run it:

```bash
npx ts-node apps/arc-server/src/manual-main.ts
```

## A. Verify all three plugins are mounted

```bash
export TOKEN=$(curl -s -X POST http://localhost:3001/auth/dev-login \
  -H 'Content-Type: application/json' -d '{"email":"plugins@example.com"}' | jq -r .accessToken)

curl http://localhost:3001/v1/sys/mounts -H "Authorization: Bearer $TOKEN" | jq
# → [{"path":"aws/","type":"plugin:arc-plugin-aws",...},
#     {"path":"gcp/","type":"plugin:arc-plugin-gcp",...},
#     {"path":"github/","type":"plugin:arc-plugin-github",...}]
```

And `/v1/sys/plugins`:

```bash
curl http://localhost:3001/v1/sys/plugins -H "Authorization: Bearer $TOKEN" | jq
# → 3 entries with {name, version, kind, mount}
```

## B. Mint creds from each plugin

```bash
# AWS
curl http://localhost:3001/v1/aws/creds/read-only \
  -H "Authorization: Bearer $TOKEN" | jq
# → { "data": { "access_key": "AKIA-FAKE-arc-read-only-1",
#               "secret_key": "fake-secret-key",
#               "session_token": "fake-session-arc-read-only-1",
#               "assumed_role_arn": "..." },
#     "lease_id": "<arc-uuid>", "lease_duration": 1800, "renewable": false }

# GCP
curl http://localhost:3001/v1/gcp/creds/deploy \
  -H "Authorization: Bearer $TOKEN" | jq

# GitHub
curl http://localhost:3001/v1/github/creds/ci \
  -H "Authorization: Bearer $TOKEN" | jq
# → { "data": { "token": "ghs_fake_1", "installation_id": 1, ... }, ... }
```

## C. Renew (refused — STS / GCP / GH tokens are not renewable)

```bash
LEASE_ID="<paste lease_id from above>"
curl -X POST http://localhost:3001/v1/sys/leases/renew \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"lease_id\":\"$LEASE_ID\"}" -i
# → 400 { "errors": ["lease ... is not renewable"], "code": "not_renewable" }
```

## D. Revoke (no-op at the vendor, drops local tracking)

```bash
curl -X PUT "http://localhost:3001/v1/sys/leases/revoke/$LEASE_ID" \
  -H "Authorization: Bearer $TOKEN" -i
# → 204

# Subsequent renew on the same lease id is now 404.
curl -X POST http://localhost:3001/v1/sys/leases/renew \
  -H "Authorization: Bearer $TOKEN" -d "{\"lease_id\":\"$LEASE_ID\"}" -i
# → 404
```

## E. Real-vendor variant

To exercise live AWS / GCP / GitHub:

- AWS: `import { createSdkStsClient } from "@arc/plugin-aws/aws-sdk"` and pass an
  `STSClientConfig`. ADC / env vars / instance profile all work.
- GCP: `import { createGoogleAuthClient } from "@arc/plugin-gcp/google-auth-library"` with
  `GOOGLE_APPLICATION_CREDENTIALS` set (or use Workload Identity).
- GitHub: `import { createNodeGitHubClient } from "@arc/plugin-github/node"` with the
  App's private key PEM.

The `manual-main.ts` swap is a one-line change per plugin. Use the same role configs;
the wire shape stays identical.

## F. Plugin-only deployments (no OpenBao)

Stop OpenBao + restart arc-server without `BAO_ADDR`. The three plugin mounts above
still work — they don't depend on the OpenBao backend. Only OpenBao-backed engine routes
(KV, transit, PKI, database) disappear from `/v1/sys/mounts`.

## G. Live mount/unmount via the admin API (ADR-009) + boot-time env mount

This path exercises the **signed OOP artifact** flow — the one operators actually run.
It needs a built plugin bin + signed manifest; the quickest source is a local install:

```bash
# Build + sign a release dir (test key), then install it the way an operator would.
pnpm --filter @arc/plugin-aws build                           # tsup emits dist/bin.cjs
mkdir -p /tmp/rel
npx arc-plugin-sign keygen --out-priv /tmp/pub.key            # prints PUB_B64U on stdout
npx arc-plugin-sign sign --artifact plugins/cloud/arc-plugin-aws/dist/bin.cjs \
  --priv /tmp/pub.key --publisher publisher:arc-core --name arc-plugin-aws \
  --version 0.1.0 --kind process --capabilities read,delete --out /tmp/rel/manifest.json
cp plugins/cloud/arc-plugin-aws/dist/bin.cjs /tmp/rel/
arc-vault plugin install --from-dir /tmp/rel --pub <PUB_B64U> --out-dir /tmp/arc-plugins
# (if the printed key starts with a dash, pass it as --pub=<PUB_B64U> — Node 24 parseArgs)
```

Boot the server with the publisher pinned and yourself as a root user (sudo on `*` via
the seeded `root` policy — the admin endpoints require `sudo` on `sys/plugins/`). The
value is the numeric **userId**; the first dev-login on a fresh DB is `1`:

```bash
ARC_ROOT_USERS=1 \
ARC_PLUGIN_TRUST_ANCHORS=publisher:arc-core=<PUB_B64U> \
pnpm --filter @arc/server start
```

Mount it live — no restart:

```bash
curl -X POST http://localhost:3001/v1/sys/plugins/mounts \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mountPath":"aws-live/","binPath":"/tmp/arc-plugins/arc-plugin-aws/bin.cjs",
       "manifestPath":"/tmp/arc-plugins/arc-plugin-aws/manifest.json"}' | jq
# → 201 { "data": { "name": "arc-plugin-aws", "mountPath": "aws-live/",
#         "declaredCapabilities": ["read","delete"],
#         "envSnippet": "aws-live/=/tmp/arc-plugins/.../bin.cjs?manifest=..." } }
# Tampered bin / unpinned publisher → 400 with the same structured reason as boot
# (artifact_hash_mismatch, untrusted_publisher, …). Mount-path collision → 409.
```

The mount is **runtime-only**: it does not survive a restart. To persist it, append the
returned `envSnippet` to `ARC_PLUGIN_MOUNTS` (comma-separated entries) — at next boot the
auto-mount path mounts it through the same gate.

Unmount live (mount path URL-encoded — `aws-live/` → `aws-live%2F`):

```bash
curl -X DELETE http://localhost:3001/v1/sys/plugins/mounts/aws-live%2F \
  -H "Authorization: Bearer $TOKEN" -i
# → 204; repeat → 404. `arc-vault plugin uninstall` prints this exact curl for you.
```

A non-sudo subject gets 403 from `CapabilityGuard` on both verbs — delegate with the
`plugin-admin` policy from ADR-009 §2 if a non-root operator should manage plugins.
