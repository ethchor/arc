output "namespace" {
  description = "Namespace the release was installed into."
  value       = var.namespace
}

output "release_name" {
  description = "Helm release name."
  value       = helm_release.arc.name
}

output "chart_version" {
  description = "Helm chart version that was installed."
  value       = helm_release.arc.version
}

output "server_service" {
  description = "Cluster-internal Service DNS for arc-server (svc.cluster.local form)."
  value       = "${var.release_name}-server.${var.namespace}.svc.cluster.local"
}

output "openbao_service" {
  description = "Cluster-internal Service DNS for the colocated OpenBao StatefulSet."
  value       = var.openbao.enabled ? "${var.release_name}-openbao.${var.namespace}.svc.cluster.local" : null
}
