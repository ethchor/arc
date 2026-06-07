# `@arc/operator`

Kubernetes operator that **declaratively delivers secrets from arc to workloads** through
two CRDs:

| CRD | What it does |
|---|---|
| `ArcSecret` | Reads a KV v2 secret from arc and synchronizes it into a K8s `Secret` in the same namespace. Optional Go-template-style projection. |
| `ArcDynamicCredential` | Issues a short-lived dynamic credential (AWS STS / GCP IAM / GitHub App / GitLab / Bitbucket / Azure AD / database) and re-issues it before its lease expires. Best-effort revokes the previous lease on rotation. |

The operator uses the **Kubernetes auth method** shipped with arc — at startup it presents
its own ServiceAccount token to `POST /v1/auth/kubernetes/login`, receives a policy-bound
arc JWT, and uses that to read from arc-server. `@arc/grants` decides what each operator
identity can touch — arc-operator is just a transport, not a policy decision point.

## CRDs

Install once per cluster:

```sh
kubectl apply -f https://raw.githubusercontent.com/ethchor/arc/develop/apps/arc-operator/crds/arc-secret.crd.yaml
kubectl apply -f https://raw.githubusercontent.com/ethchor/arc/develop/apps/arc-operator/crds/arc-dynamic-credential.crd.yaml
```

### ArcSecret — sync a static (KV v2) secret

```yaml
apiVersion: arc.io/v1alpha1
kind: ArcSecret
metadata:
  name: db-creds
  namespace: payments
spec:
  source:
    mount: secret      # defaults to "secret"
    path: app/prod/db
    # version: 7       # optional pin to a specific KV version
  target:
    name: db-creds
    type: Opaque
    template:
      DATABASE_URL: "postgres://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/{{ .db }}"
  refreshIntervalSeconds: 300
```

If `target.template` is omitted, every field of the arc secret's `data` is copied verbatim
into the K8s Secret. Templates use top-level `{{ .field }}` substitution only — references
to fields not present in the source surface as a `Synced=False` condition rather than
silently producing `{{ .password }}` in your Secret.

### ArcDynamicCredential — auto-rotating dynamic credentials

```yaml
apiVersion: arc.io/v1alpha1
kind: ArcDynamicCredential
metadata:
  name: aws-deployer
  namespace: payments
spec:
  source:
    mount: aws         # plugin mount path
    role: deployer
    ttlSeconds: 900
  target:
    name: aws-deployer
    type: Opaque
    template:
      AWS_ACCESS_KEY_ID: "{{ .access_key }}"
      AWS_SECRET_ACCESS_KEY: "{{ .secret_key }}"
      AWS_SESSION_TOKEN: "{{ .session_token }}"
  refreshLeadSeconds: 60   # re-issue 60s before lease expiry
```

Each reconcile pass: if the lease would expire within `refreshLeadSeconds`, the operator
issues a fresh one, rewrites the Secret, records the new lease in `.status`, and best-effort
revokes the previous lease.

`kubectl get arcdynamiccredential aws-deployer -o yaml` shows the current lease ID +
`expiresAt` under `.status`.

## Configuration

| Env var | Required | Notes |
|---|---|---|
| `ARC_SERVER_URL` | ✅ | Base URL of arc-server, e.g. `https://arc.svc.cluster.local:3001`. |
| `ARC_AUTH_MOUNT` | — | Auth method to log into. Default `kubernetes`. |
| `ARC_AUTH_ROLE` | ✅ | Role configured on the auth method. Maps to the operator's arc policies. |
| `POLL_INTERVAL_SECONDS` | — | Default 30. |

## RBAC

The operator's ServiceAccount needs:

- `secrets` — `get`, `create`, `update`, `patch` in every namespace it serves
- `arcsecrets.arc.io` and `arcdynamiccredentials.arc.io` — `get`, `list`, `watch`; plus
  `patch` on the `/status` subresource

Sample manifests will ship in `infra/arc-helm-charts/arc-operator/` (follow-up).

## Trust boundary

The operator is **not** the policy decision point. It carries an arc JWT issued by the K8s
auth method; arc-server's `JwtAuthGuard` + `CapabilityGuard` (against `@arc/grants`) decide
what each call is allowed to do. A 403 from arc-server surfaces as a `Failed` condition on
the CR — the operator does not retry-with-different-creds and does not infer authorization
locally.

## Testing

```sh
pnpm --filter @arc/operator test
```

23 tests cover: the reconcilers (verbatim copy, template projection, missing-field rejection,
lease re-issue + revoke, no-op when lease is fresh, error → status condition), the
ArcClient (SA-token login, JWT caching + refresh-ahead, 401-retry-once, 403-no-retry), the
template engine, and the poll loop (per-iteration progress, fault isolation per CR, clean
stop).
