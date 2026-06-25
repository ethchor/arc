# arc Helm chart

Deploys [arc](https://github.com/ethchor/arc) — Engine-A (OpenBao-backed infra secrets) +
Engine-B (Bitwarden-class E2E vault) — to a Kubernetes cluster.

> **Before installing in a non-dev cluster**: read
> [`docs/production-hardening.md`](../../../docs/production-hardening.md) for the env-var
> contract (what arc-server requires + what it fails-closed on). This chart bakes most of
> it in but a few values still need your real-domain inputs (`ARC_PASSKEY_RP_ID`,
> `CORS_ORIGINS`, `ARC_ROOT_USERS`).

## TL;DR

```bash
helm repo add arc https://ethchor.github.io/arc/charts   # (when published)
helm install arc arc/arc \
  --namespace arc --create-namespace \
  --set-string arcServer.secret.jwtSecret="$(openssl rand -hex 32)" \
  --set-string arcServer.secret.databaseUrl="postgres://user:pw@db/arc"
```

Until a chart repo exists, install from a local checkout:

```bash
helm install arc ./infra/arc-helm-charts/arc \
  --namespace arc --create-namespace \
  --set-string arcServer.secret.jwtSecret="$(openssl rand -hex 32)" \
  --set-string arcServer.secret.databaseUrl="postgres://user:pw@db/arc"
```

## What the chart deploys

| Workload | Kind | Toggle |
|---|---|---|
| arc-server | Deployment + Service | `arcServer.enabled` (default `true`) |
| OpenBao (co-located) | StatefulSet + Service | `openbao.enabled` (default `true`) |
| Ingress | networking.k8s.io/v1 | `ingress.enabled` |
| ServiceMonitor (Prometheus Operator) | monitoring.coreos.com/v1 | `serviceMonitor.enabled` |
| Secret (JWT, DB URL, BAO token) | Opaque | `arcServer.secret.create` |

The chart does **not** install Postgres — production uses a managed offering. The
`DATABASE_URL` you supply is what arc-server uses.

## Production checklist

- `arcServer.env.NODE_ENV=production` (default).
- `arcServer.env.ARC_DEFAULT_POLICY=deny` + at least one id in `ARC_ROOT_USERS`.
- `openbao.devMode=false` (the default; supply your real config + seal). The chart
  **refuses to render** a dev-mode OpenBao under a production arc-server — flip
  `arcServer.env.NODE_ENV=development` if you genuinely want a local in-memory trial.
- `openbao.image.tag` is pinned (default `2.3.1`, not `latest`). Bump deliberately to a
  version you've tested; pin by digest for the strongest supply-chain assurance.
- Bind `serviceMonitor.enabled=true` if you run kube-prometheus-stack.
- Provide `arcServer.secret.existingSecret` (managed via External Secrets / SealedSecrets)
  instead of writing values into the chart.
- Set `arcServer.env.OTEL_EXPORTER_OTLP_ENDPOINT` to your collector to enable tracing.

## Ops components (operator · agent · MCP server)

The chart can also deploy the three secret-delivery + agent surfaces. All are **off by
default**; enable the ones you need.

### arc-operator (`operator.enabled=true`)

Reconciles the `ArcSecret` + `ArcDynamicCredential` CRDs into K8s Secrets. The chart ships
the two CRDs in its `crds/` directory (Helm installs them on first `helm install`; use
`--skip-crds` to manage them out-of-band) and creates the operator's Deployment +
ServiceAccount + ClusterRole/Binding (`operator.rbac.create`, `operator.serviceAccount.create`).
The operator authenticates to arc-server with its own ServiceAccount token via the
Kubernetes auth method — set `operator.auth.role` to a role configured on arc-server's
`kubernetes` auth mount.

```bash
helm upgrade --install arc infra/arc-helm-charts/arc \
  --set operator.enabled=true \
  --set operator.auth.role=arc-operator
```

### arc-mcp-server (`mcpServer.enabled=true`)

Exposes Engine-A (KV / transit / dynamic creds) over the Model Context Protocol for AI
agents. Stateless Deployment + Service on port 8800; forwards each agent's bearer to
arc-server (where `@arc/grants` gates it). No cluster RBAC — it only talks to arc-server.
`mcpServer.arcServerUrl` defaults to the in-chart server Service.

### arc-agent (`agent.sampleConfig.enabled=true`)

The agent runs as an **init container + sidecar inside your own workload pods**, so the
chart doesn't own a Deployment for it — it only ships a sample config ConfigMap when
`agent.sampleConfig.enabled=true`. Mount that ConfigMap at `/etc/arc-agent/` in your pod
and add the `ghcr.io/ethchor/arc-agent` sidecar (see the arc-agent README for the snippet).

## Values reference

See [`values.yaml`](values.yaml) — every knob is documented inline with the production-safe
default first. The ops blocks are `operator.*`, `mcpServer.*`, and `agent.*`.

## Local validation

```bash
helm lint infra/arc-helm-charts/arc
helm template my-release infra/arc-helm-charts/arc \
  --set-string arcServer.secret.jwtSecret=fake \
  --set-string arcServer.secret.databaseUrl=postgres://x/y
```

CI runs both on every push (`.github/workflows/ci.yml`).
