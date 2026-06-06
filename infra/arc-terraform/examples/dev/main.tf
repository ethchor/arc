## Dev example — single-namespace deploy against the in-repo chart.
##
##   1. Have a kube-context pointing at a local cluster (kind / minikube / k3d).
##   2. `terraform init && terraform apply`.
##   3. Port-forward the server Service: `kubectl -n arc-dev port-forward svc/arc-dev-server 3001:3001`.

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    helm       = { source = "hashicorp/helm",       version = ">= 2.12.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = ">= 2.25.0" }
  }
}

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

  namespace     = "arc-dev"
  release_name  = "arc-dev"
  chart_path    = "../../../arc-helm-charts/arc"
  chart_version = "0.1.0"

  arc_server = {
    replica_count = 1
    image = {
      repository = "ghcr.io/ethchor/arc-server"
      tag        = "main"
    }
    env = {
      NODE_ENV           = "development"
      LOG_LEVEL          = "debug"
      ARC_DEFAULT_POLICY = "allow"
    }
    secret = {
      create       = true
      jwt_secret   = "dev-jwt-secret-change-me"
      database_url = "postgres://arc:arc@postgres.arc-dev.svc.cluster.local:5432/arc"
    }
  }

  openbao = {
    enabled  = true
    dev_mode = true
  }

  service_monitor = { enabled = false }
}

output "server_service" {
  value = module.arc.server_service
}
