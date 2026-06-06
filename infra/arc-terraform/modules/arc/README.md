# `modules/arc`

Reusable Terraform module that deploys the [`arc`](../../../arc-helm-charts/arc)
Helm chart to a Kubernetes cluster.

## Quickstart

```hcl
provider "kubernetes" {
  config_path = "~/.kube/config"
}

provider "helm" {
  kubernetes {
    config_path = "~/.kube/config"
  }
}

module "arc" {
  source = "../../modules/arc"

  namespace     = "arc"
  release_name  = "arc"
  chart_path    = "../../../arc-helm-charts/arc" # in-repo dev
  # chart_repository / chart_version when consuming a published chart

  arc_server = {
    replica_count = 2
    image         = { repository = "ghcr.io/ethchor/arc-server", tag = "v0.0.1" }
    secret        = { create = true, jwt_secret = "redacted", database_url = "postgres://..." }
  }

  openbao = {
    enabled  = true
    dev_mode = false
    persistence = { enabled = true, size = "20Gi" }
  }

  service_monitor = { enabled = true }
}
```

## Inputs

| Variable | Type | Default | Notes |
|----------|------|---------|-------|
| `namespace` | `string` | `arc` | Created when `create_namespace = true`. |
| `create_namespace` | `bool` | `true` | Skip when the namespace is managed elsewhere. |
| `release_name` | `string` | `arc` | Helm release name; prefix on every K8s object. |
| `chart_repository` | `string?` | `null` | Helm repo URL. Leave `null` to use `chart_path`. |
| `chart_name` | `string` | `arc` | Chart name within the repo. |
| `chart_version` | `string` | `0.1.0` | Pin to an exact release for production. |
| `chart_path` | `string?` | `null` | Local filesystem path to the chart (overrides `chart_repository`). |
| `atomic` | `bool` | `true` | `--atomic` rolls back on install failure. |
| `timeout_seconds` | `number` | `600` | Helm install/upgrade timeout. |
| `arc_server` | `object` | typed | 1:1 with `arcServer` in `values.yaml`. |
| `openbao` | `object` | typed | 1:1 with `openbao` in `values.yaml`. |
| `ingress` | `object` | typed | Disabled by default. |
| `service_monitor` | `object` | typed | Requires `prometheus-operator` CRDs in-cluster. |
| `common_labels` | `map(string)` | `{}` | Labels applied to every rendered object. |
| `common_annotations` | `map(string)` | `{}` | Annotations applied to every rendered object. |
| `extra_values` | `any` | `{}` | Raw values merged on top — escape hatch for unmodelled keys. |

## Outputs

- `namespace`
- `release_name`
- `chart_version`
- `server_service` — internal DNS for arc-server
- `openbao_service` — internal DNS for colocated OpenBao (nullable)

## Production checklist

The same list as the [chart README](../../../arc-helm-charts/arc/README.md):
flip `openbao.dev_mode = false`, enable persistence, manage secrets
out-of-band, pin `chart_version`, wire the ServiceMonitor, and decide on
an Ingress vs Gateway.
