# arc Helm chart

Deploys [arc](https://github.com/ethchor/arc) — Engine-A (OpenBao-backed infra secrets) +
Engine-B (Bitwarden-class E2E vault) — to a Kubernetes cluster.

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
- `openbao.devMode=false` (and supply your real config + seal).
- Bind `serviceMonitor.enabled=true` if you run kube-prometheus-stack.
- Provide `arcServer.secret.existingSecret` (managed via External Secrets / SealedSecrets)
  instead of writing values into the chart.
- Set `arcServer.env.OTEL_EXPORTER_OTLP_ENDPOINT` to your collector to enable tracing.

## Values reference

See [`values.yaml`](values.yaml) — every knob is documented inline with the production-safe
default first.

## Local validation

```bash
helm lint infra/arc-helm-charts/arc
helm template my-release infra/arc-helm-charts/arc \
  --set-string arcServer.secret.jwtSecret=fake \
  --set-string arcServer.secret.databaseUrl=postgres://x/y
```

CI runs both on every push (`.github/workflows/ci.yml`).
