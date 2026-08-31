# 17 — Free-tier deployment (production-like, $0)

Goal: run **all** of arc — Engine-A, Engine-B, Engine-C, the operator, the web app and the
MCP server — somewhere free, with every feature genuinely exercisable. Not a demo with the
hard parts stubbed out.

Researched 2026-08. Free tiers move; re-check the numbers before committing.

## 17.1 The constraint that decides everything

OpenBao needs **a persistent volume attached to a process that does not sleep**. That single
requirement eliminates almost every free tier:

| Option | Persistent volume | Sleeps | Verdict |
| ------ | ----------------- | ------ | ------- |
| Render free | none on free tier | 15 min | ✗ |
| Koyeb free | 2 GB, ephemeral | 1 h, **cannot disable** | ✗ — seals hourly |
| Railway free | 500 MB, deleted after 30 d | no | ✗ — $1/mo credit |
| Cloudflare Containers | **ephemeral by design** | 10 min | ✗ — and paid |
| Fly.io | real volumes | no | ✗ — no free tier since Oct 2024 |
| **Oracle Cloud Always Free** | **200 GB block storage** | **no** | ✅ |

So the shape is: **one Oracle Always Free ARM VM running k3s** holds everything stateful, and
we push the two workloads off-box where a free tier is *better* than the VM (static-ish web
serving, and object storage).

Treat "free Docker hosting, no card, NVMe volumes" search results as affiliate spam. A
secrets manager's Raft store does not go on one.

## 17.2 Oracle's June 2026 cut — read this before signing up

Oracle **halved** the Always Free ARM allowance on 2026-06-15, with no announcement:

- **Now 2 OCPU / 12 GB RAM** (1,500 OCPU-hours + 9,000 GB-hours per month). Previously 4/24.
- Instances above the new cap were **disabled and deleted from 2026-08-18**.
- A surviving 4/24 instance is one termination away from permanent demotion — Oracle's docs
  say resources above the current limit may not be recreatable.

Still workable (§17.4), but with consequences:

- **A1 OCPUs are integers**, so 2 OCPU is at most two 1-OCPU VMs. **A 3-node Raft quorum is
  no longer possible on the free tier.** Single-node Raft it is.
- **Idle reclamation** hits Always Free accounts when, over 7 days, CPU *and* network *and*
  memory are all below 20% at p95. A full arc stack clears the memory bar, but not by much.
  → **Upgrade to Pay As You Go immediately.** It stays $0 within Always Free limits and
  removes reclamation exposure entirely. Highest-value five minutes of the whole setup.
- **Home region is chosen at signup and is permanent**, and Always Free compute is
  home-region-only. Pick a 3-availability-domain region; Frankfurt / Singapore / Tokyo
  provision far more reliably than the US regions.
- `Out of host capacity` remains endemic. Script the retry; don't sit clicking.
- A credit card is required for identity verification.
- The free load balancer is capped at **10 Mbps both ways** — skip it, run Traefik on the
  VM's public IP.

## 17.3 Topology

| Component | Where | Why there |
| --------- | ----- | --------- |
| **OpenBao** | Oracle VM, k3s StatefulSet, PVC on block storage | The only free persistent-volume-and-no-sleep option that exists |
| **PostgreSQL** | Oracle VM, in-cluster | Beats every free managed tier: no 0.5 GB ceiling, no 5-minute suspend, no egress cap, no 30-day expiry |
| **arc-server** ×2 | Oracle VM | Long-running, no cold start, no request timeout, and two replicas actually exercise the shared-state requirement |
| **Valkey** | Oracle VM, in-cluster | Upstash free is 500K commands/month; per-request throttle counters burn that in days |
| **arc-operator** | Oracle VM | A real cluster is the only way to exercise CRDs + RBAC |
| **arc-mcp-server** | Oracle VM | 50m / 64Mi, free to co-locate |
| **Web app** | **Cloudflare Workers** (`@opennextjs/cloudflare`) | Saves ~512Mi on the constrained box; real SSR; CSP/headers still ours. Watch the 3 MiB gzipped bundle cap |
| **Attachments** | **Cloudflare R2** | 10 GB, 1M/10M ops, **zero egress**. Already supported: `ARC_BLOB_BACKEND=s3` + `ARC_BLOB_S3_ENDPOINT`, and `s3-blob-store.ts` sets `forcePathStyle` when an endpoint is given |
| **TLS / ingress** | Traefik + cert-manager on the VM | Avoids the 10 Mbps LB cap |
| **CI + registry** | GitHub Actions + GHCR | Already the image namespace |

Two footnotes that will bite otherwise: `@aws-sdk/client-s3` is an **optional** peer dep and
must be installed into the image or the S3 blob backend throws at boot; and Cloudflare **D1
is SQLite**, so it is not a substitute for Postgres here.

## 17.4 Does it still fit in 2 OCPU / 12 GB?

Summing `resources.requests` from `values.yaml` plus what the chart doesn't ship:

| | CPU | Memory |
| --- | --- | --- |
| k3s + containerd + kubelet | ~400m | ~700Mi |
| Traefik | 100m | 128Mi |
| Postgres | 250m | 1Gi |
| Valkey | 50m | 128Mi |
| OpenBao | 100m | 256Mi |
| arc-server ×2 | 200m | 512Mi |
| web (if on-box) | 100m | 512Mi |
| mcp-server + operator | 100m | 128Mi |
| **Total** | **~1.3 vCPU** | **~3.4Gi** |

Ampere A1 has no SMT, so 2 OCPU = 2 vCPU. **Memory is comfortable; CPU is thin but adequate**
— and moving the web app to Workers buys back the headroom. Keep `replicaCount: 2` on
arc-server: dropping to 1 would hide exactly the multi-replica bugs this deployment exists to
surface (SEC-M6 shared state). 50 GB boot + 50 GB block leaves ~100 GB spare.

## 17.5 The chart gap this closed

`openbao-statefulset.yaml` ran `server -config=/etc/openbao/config.hcl` in the non-dev branch,
but **no template produced that file**, nothing mounted `/etc/openbao`, and
`persistence.enabled` defaulted to `false`. A default `helm install` rendered an Engine-A that
CrashLoopBackOffs. Fixed here (BL-H8 / issue #150):

- `openbao-configmap.yaml` ships a real `config.hcl` — listener, **Raft storage** on the PVC,
  `api_addr`/`cluster_addr`, and a seal stanza.
- `persistence.enabled` now defaults to **true**, and the ConfigMap **refuses to render**
  without it. Raft on a container filesystem is an in-memory vault that looks healthy and
  loses every secret on reschedule — that must not be reachable by default.
- `seal.type` is `shamir` (manual `bao operator unseal` after each restart) or `transit`
  (auto-unseal against another OpenBao). The transit token comes from a Secret, never the
  ConfigMap.

Still **not** HA: one node, single-node Raft. That is a free-tier limit, not a design choice —
see §17.7.

## 17.6 Bring-up order

1. Oracle signup → **pick a 3-AD region** (permanent). Then **upgrade to Pay As You Go**.
2. Provision `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, Ubuntu 24.04 ARM64, 50 GB boot; retry on
   capacity errors. Attach a 50 GB block volume.
3. `curl -sfL https://get.k3s.io | sh -` — ships Traefik and a `local-path` StorageClass.
4. cert-manager + a Let's Encrypt ClusterIssuer; point DNS (Cloudflare free) at the VM.
5. Postgres (CloudNativePG) and Valkey into the cluster.
6. `helm install arc infra/arc-helm-charts/arc` with `arcServer.env.NODE_ENV=production`,
   `openbao.devMode=false`, `openbao.persistence.enabled=true`, and a real
   `arcServer.secret.jwtSecret`.
7. `bao operator init` + `unseal`; keep the unseal shares off the box.
8. R2 bucket → set `ARC_BLOB_BACKEND=s3` + endpoint/keys.
9. Register an OAuth client (Google or GitHub) → set `ARC_OIDC_ISSUERS` + `ARC_OIDC_AUDIENCES`
   so `POST /auth/oidc/login` works. **Leave `ARC_ENABLE_DEV_LOGIN` unset.**
10. Deploy the web app to Workers; point it at the API host.

## 17.7 What cannot be free

| Not free | Why | Cheapest fallback |
| -------- | --- | ----------------- |
| 3-node OpenBao Raft HA | 2 OCPU splits into at most 2 ARM VMs; the 1/8-OCPU AMD micros are not credible quorum members | 2× Hetzner CAX11 ≈ €5/mo each |
| Replicated Postgres | no free tier offers replicas | Aiven Developer $5/mo (never powers off) |
| KMS-backed auto-unseal | no free cloud KMS with a compatible seal | OCI Vault / AWS KMS ≈ $1/key/mo |
| Surviving loss of the VM | one node, one region, one AD | Hetzner CAX11 warm standby ≈ €5/mo |

If Oracle capacity is unobtainable in your region, the honest answer is not another free tier
— it is **Hetzner CAX11 at ~€5/month**: same 2 ARM vCPUs, a real disk, no capacity lottery, no
reclamation policy, 20 TB traffic.

## 17.8 Free-tier limits that would fake a passing test

Worth stating plainly, because each one lets a broken build look healthy:

- **Neon** free suspends after 5 minutes and caps egress at 5 GB/month — exceed it and compute
  suspends until the next cycle. **Supabase** free pauses the whole project after a week idle.
  Both would make sync look broken at exactly the moment you demo it. Hence self-hosted PG.
- **Render** free Postgres is **deleted 30 days after creation**, and its free Key Value store
  does not persist to disk at all.
- **Upstash** free is 500K commands/month total — throttle counters alone would exhaust it,
  and a rate limiter that silently stops counting is worse than none.
- **Cloudflare Workers** free gives **10 ms CPU per invocation**. Fine for SSR, nowhere near
  enough for Argon2 — which is correct anyway: KDF work belongs on the client, never the edge.
