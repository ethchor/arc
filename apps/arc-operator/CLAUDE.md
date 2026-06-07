# arc-operator — agent context

**Scope.** Kubernetes operator that reconciles two CRDs:
- `ArcSecret` → sync a KV v2 secret from arc into a K8s Secret.
- `ArcDynamicCredential` → issue + auto-rotate a dynamic credential into a K8s Secret.

**Auth.** The operator's pod runs with a ServiceAccount whose projected token is presented
to `POST /v1/auth/kubernetes/login` (the K8s auth plugin shipped in #7). The returned arc
JWT is what every subsequent request to arc-server carries. `@arc/grants` decides what each
identity can touch — arc-operator never makes authorization decisions locally.

**Reconcile strategy.** Polling, not watch. Every `POLL_INTERVAL_SECONDS` we list both CR
kinds and reconcile each one. Simpler than informers, deterministic, fine for the
secret-injection workload. Watch can replace it later behind the same `KubeClient`
interface.

**Deps rule.** Workspace deps are none. External runtime dep is `@kubernetes/client-node`
only. Do not import `@arc/server` or any arc-server-internal package — the operator is an
*app*, not a server-internal module, and reaches arc-server through plain HTTP.

**Layering.**
```
main.ts → ArcClient (login + HTTP) + KubeClient (kube API)
       ↓
       runReconcileLoop(opts)
         ├── reconcileArcSecret(cr, deps)
         └── reconcileArcDynamicCredential(cr, deps)
```

The reconcilers are **pure functions over the two client interfaces** — the FakeKubeClient
+ FakeArcClient in tests cover every code path without `@kubernetes/client-node` or `fetch`.

**Errors.** A single bad CR cannot block the loop — every per-reconciler error is caught,
recorded as a `Failed` condition on the CR's `.status`, and the next CR runs. A failure to
list CRs (e.g. transient apiserver outage) drops the rest of that iteration; the next poll
retries.

**Status invariants.**
- `ArcSecret.status.observedVersion` is the KV v2 version we last applied.
- `ArcDynamicCredential.status.leaseId` is the **currently-in-effect** lease. Re-issuing
  swaps it in *and* best-effort revokes the previous one (errors in revoke are intentionally
  silenced — the new lease is what matters).

**Trust boundary.** The operator carries an org-issued arc JWT scoped by policy. It does
not log into arc with anything stronger and does not have credentials for arc-server's
admin surface. Anything that needs ACL escalation belongs in a separate, narrower
ServiceAccount + role.
