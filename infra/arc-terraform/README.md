# `infra/arc-terraform`

Terraform module that deploys arc to a Kubernetes cluster by installing the
[`@arc/helm-charts`](../arc-helm-charts) chart. Mirrors the values surface of
the chart 1:1 so the same configuration mental-model works whether you
deploy via Helm or Terraform.

## Layout

```
infra/arc-terraform/
  modules/
    arc/           # the reusable module — call this from your own root module
  examples/
    dev/           # `terraform apply` here for a local single-namespace deploy
  tests/           # Node-based smoke tests (vitest) — no `terraform` binary needed
```

## Usage

```hcl
module "arc" {
  source = "github.com/ethchor/arc//infra/arc-terraform/modules/arc?ref=main"

  namespace      = "arc"
  release_name   = "arc"
  chart_version  = "0.1.0"

  arc_server = {
    replica_count = 2
    image = {
      repository = "ghcr.io/ethchor/arc-server"
      tag        = "v0.0.1"
    }
    env = {
      ARC_DEFAULT_POLICY          = "deny"
      ARC_ROOT_USERS              = "1"
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector.observability:4318"
    }
    secret = {
      create        = true
      jwt_secret    = var.arc_jwt_secret
      database_url  = var.arc_database_url
    }
  }

  openbao = {
    enabled        = true
    dev_mode       = false
    persistence    = { enabled = true, size = "20Gi" }
  }

  ingress = {
    enabled    = true
    class_name = "nginx"
    hosts      = [{ host = "arc.example.com", paths = [{ path = "/", path_type = "Prefix" }] }]
  }

  service_monitor = { enabled = true }
}
```

The module uses the [`helm` provider](https://registry.terraform.io/providers/hashicorp/helm)
under the hood; the entire input surface is the chart's `values.yaml` shape,
just rendered in HCL.

## Why a Helm-backed module (not bare Kubernetes resources)?

- **Single source of truth.** Image, security contexts, ServiceMonitor scrape
  paths, and Engine-A wiring all live in the chart already. Re-implementing
  them in `kubernetes_*` resources would drift every release.
- **Operator parity.** Whether you `helm install arc ...` or
  `terraform apply`, you end up with the same set of Kubernetes objects on
  the cluster.
- **Upgrades come for free.** Bumping `chart_version` reuses the chart's
  upgrade logic (annotation handling, secret references, etc.) instead of
  hand-rolling diffs.

## Verifying without a real cluster

`terraform plan` against a real cluster is the gold-standard check, but
contributors without a kube context still get fast feedback via the Node
smoke tests:

```sh
pnpm --filter @arc/terraform test
```

These tests load every `.tf` file with a small HCL-ish parser, assert the
module declares the expected variables/outputs, and round-trip the example
`tfvars.json` against the same shape the chart's `values.yaml` accepts.
A full `terraform fmt -check` + `terraform validate` runs in CI on every
PR.

## Production checklist

1. **Switch OpenBao out of dev mode.** Set `openbao.dev_mode = false`,
   enable `openbao.persistence.enabled = true`, and configure a real seal
   (KMS or Shamir).
2. **Provide secrets out of band.** Either pass `arc_server.secret.create = false`
   and reference `arc_server.secret.existing_secret`, or wire
   [external-secrets](https://external-secrets.io) at the chart level.
3. **Pin the chart version.** Never deploy from a moving tag; `chart_version`
   should be an exact version number.
4. **Enable the ServiceMonitor.** `service_monitor.enabled = true` requires
   `kube-prometheus-stack` (or upstream `prometheus-operator`) in the cluster.
5. **Front with an ingress.** The chart ships a Kubernetes Ingress, but you
   can also disable it and use a `Gateway`/`HTTPRoute` of your choice — the
   Service is always exposed.
