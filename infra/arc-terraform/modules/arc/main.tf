## ---------------------------------------------------------------------------
## Namespace (optional).
## ---------------------------------------------------------------------------

resource "kubernetes_namespace" "this" {
  count = var.create_namespace ? 1 : 0

  metadata {
    name        = var.namespace
    labels      = var.common_labels
    annotations = var.common_annotations
  }
}

## ---------------------------------------------------------------------------
## Helm release. The values block is the chart's `values.yaml` shape, built
## from the typed inputs in variables.tf and the `extra_values` escape hatch.
## ---------------------------------------------------------------------------

locals {
  # Build the same nested map the chart expects. Keys use camelCase to match
  # values.yaml exactly so the chart never sees a key it doesn't recognize.
  values = {
    commonLabels      = var.common_labels
    commonAnnotations = var.common_annotations

    arcServer = {
      enabled       = var.arc_server.enabled
      replicaCount  = var.arc_server.replica_count
      image         = var.arc_server.image
      env           = var.arc_server.env
      secret = {
        create         = var.arc_server.secret.create
        existingSecret = var.arc_server.secret.existing_secret
        jwtSecret      = var.arc_server.secret.jwt_secret
        databaseUrl    = var.arc_server.secret.database_url
        baoToken       = var.arc_server.secret.bao_token
      }
      service                  = var.arc_server.service
      resources                = var.arc_server.resources
      podSecurityContext       = var.arc_server.pod_security_context
      containerSecurityContext = var.arc_server.container_security_context
      livenessProbe            = var.arc_server.liveness_probe
      readinessProbe           = var.arc_server.readiness_probe
      podAnnotations           = var.arc_server.pod_annotations
      nodeSelector             = var.arc_server.node_selector
      tolerations              = var.arc_server.tolerations
      affinity                 = var.arc_server.affinity
    }

    openbao = {
      enabled      = var.openbao.enabled
      image        = var.openbao.image
      devMode      = var.openbao.dev_mode
      devRootToken = var.openbao.dev_root_token
      service      = var.openbao.service
      persistence = {
        enabled      = var.openbao.persistence.enabled
        storageClass = var.openbao.persistence.storage_class
        size         = var.openbao.persistence.size
      }
      resources = var.openbao.resources
    }

    ingress = {
      enabled     = var.ingress.enabled
      className   = var.ingress.class_name
      annotations = var.ingress.annotations
      hosts       = var.ingress.hosts
      tls         = var.ingress.tls
    }

    serviceMonitor = {
      enabled       = var.service_monitor.enabled
      interval      = var.service_monitor.interval
      scrapeTimeout = var.service_monitor.scrape_timeout
      labels        = var.service_monitor.labels
      namespace     = var.service_monitor.namespace
    }
  }

  # Merge typed values with the raw escape hatch. `extra_values` wins on key
  # collisions so callers can always override a typed field.
  merged_values = merge(local.values, var.extra_values)
}

resource "helm_release" "arc" {
  name       = var.release_name
  namespace  = var.namespace
  repository = var.chart_repository
  chart      = var.chart_path != null ? var.chart_path : var.chart_name
  version    = var.chart_version

  atomic           = var.atomic
  timeout          = var.timeout_seconds
  create_namespace = false # Handled by `kubernetes_namespace.this` above.
  wait             = true

  values = [yamlencode(local.merged_values)]

  depends_on = [kubernetes_namespace.this]
}
