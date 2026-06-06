## ---------------------------------------------------------------------------
## Release-level inputs.
## ---------------------------------------------------------------------------

variable "namespace" {
  description = "Kubernetes namespace to deploy arc into. Created if `create_namespace = true`."
  type        = string
  default     = "arc"
}

variable "create_namespace" {
  description = "Create the namespace via Terraform before installing the release."
  type        = bool
  default     = true
}

variable "release_name" {
  description = "Helm release name. Becomes the prefix for every rendered Kubernetes object."
  type        = string
  default     = "arc"
}

variable "chart_repository" {
  description = "Helm repository the chart is pulled from. Leave null to use a local path via `chart_path`."
  type        = string
  default     = null
}

variable "chart_name" {
  description = "Helm chart name."
  type        = string
  default     = "arc"
}

variable "chart_version" {
  description = "Helm chart version. Pin to an exact release for production."
  type        = string
  default     = "0.1.0"
}

variable "chart_path" {
  description = "Local filesystem path to the chart (overrides `chart_repository`). Set to `../../arc-helm-charts/arc` for in-repo development."
  type        = string
  default     = null
}

variable "atomic" {
  description = "Pass `--atomic` to helm. Rolls the release back on failure."
  type        = bool
  default     = true
}

variable "timeout_seconds" {
  description = "Helm install/upgrade timeout in seconds."
  type        = number
  default     = 600
}

## ---------------------------------------------------------------------------
## Chart values — `arc_server`. Mirrors `arcServer:` in values.yaml.
## ---------------------------------------------------------------------------

variable "arc_server" {
  description = "arc-server configuration. Mirrors the `arcServer` block in the chart's values.yaml."
  type = object({
    enabled       = optional(bool, true)
    replica_count = optional(number, 2)
    image = optional(object({
      repository  = optional(string, "ghcr.io/ethchor/arc-server")
      tag         = optional(string, "")
      pull_policy = optional(string, "IfNotPresent")
    }), {})
    env = optional(map(string), {})
    secret = optional(object({
      create          = optional(bool, true)
      existing_secret = optional(string, "")
      jwt_secret      = optional(string, "")
      database_url    = optional(string, "")
      bao_token       = optional(string, "")
    }), {})
    service = optional(object({
      type = optional(string, "ClusterIP")
      port = optional(number, 3001)
    }), {})
    resources = optional(any, {})
    pod_security_context = optional(any, {
      runAsNonRoot = true
      runAsUser    = 1000
      fsGroup      = 1000
    })
    container_security_context = optional(any, {
      allowPrivilegeEscalation = false
      readOnlyRootFilesystem   = true
      capabilities             = { drop = ["ALL"] }
    })
    liveness_probe  = optional(any, {})
    readiness_probe = optional(any, {})
    pod_annotations = optional(map(string), {})
    node_selector   = optional(map(string), {})
    tolerations     = optional(list(any), [])
    affinity        = optional(any, {})
  })
  default = {}
}

## ---------------------------------------------------------------------------
## Chart values — `openbao`. Mirrors `openbao:` in values.yaml.
## ---------------------------------------------------------------------------

variable "openbao" {
  description = "Co-located OpenBao configuration. Disable when you operate OpenBao separately."
  type = object({
    enabled = optional(bool, true)
    image = optional(object({
      repository  = optional(string, "quay.io/openbao/openbao")
      tag         = optional(string, "latest")
      pull_policy = optional(string, "IfNotPresent")
    }), {})
    dev_mode       = optional(bool, true)
    dev_root_token = optional(string, "root")
    service = optional(object({
      type = optional(string, "ClusterIP")
      port = optional(number, 8200)
    }), {})
    persistence = optional(object({
      enabled       = optional(bool, false)
      storage_class = optional(string, "")
      size          = optional(string, "8Gi")
    }), {})
    resources = optional(any, {})
  })
  default = {}
}

## ---------------------------------------------------------------------------
## Chart values — `ingress` + `serviceMonitor`.
## ---------------------------------------------------------------------------

variable "ingress" {
  description = "Ingress for the arc-server Service. Disabled by default."
  type = object({
    enabled     = optional(bool, false)
    class_name  = optional(string, "")
    annotations = optional(map(string), {})
    hosts = optional(list(object({
      host = string
      paths = list(object({
        path      = string
        path_type = string
      }))
    })), [])
    tls = optional(list(any), [])
  })
  default = {}
}

variable "service_monitor" {
  description = "Prometheus ServiceMonitor. Requires kube-prometheus-stack / prometheus-operator."
  type = object({
    enabled        = optional(bool, false)
    interval       = optional(string, "30s")
    scrape_timeout = optional(string, "10s")
    labels         = optional(map(string), {})
    namespace      = optional(string, "")
  })
  default = {}
}

## ---------------------------------------------------------------------------
## Generic escape hatch for any value the typed inputs above don't expose yet.
## ---------------------------------------------------------------------------

variable "extra_values" {
  description = "Raw values merged on top of the typed inputs. Used as an escape hatch for chart values not modelled above."
  type        = any
  default     = {}
}

variable "common_labels" {
  description = "Labels applied to every rendered Kubernetes object."
  type        = map(string)
  default     = {}
}

variable "common_annotations" {
  description = "Annotations applied to every rendered Kubernetes object."
  type        = map(string)
  default     = {}
}
