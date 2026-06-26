# @arc/leasing

Engine-A **lease lifecycle** — Vault-style TTLs, renewal, and revocation — as
backend-agnostic logic. No network, no crypto, no framework. Persistence lives behind a
pluggable `LeaseStore` (default: in-memory); `@arc/leasing` owns only the lifecycle math.

A `Lease` records when a dynamically issued secret/token was minted, when it expires, and a hard
`maxTtl` ceiling that renewals can never exceed. `LeaseManager` issues leases, renews them
*from now* (capped at the ceiling, as Vault does), revokes them (single or by mount prefix), and
sweeps expired/revoked entries. Every method is `async` (a `LeaseStore` may be I/O-backed).

```ts
import { LeaseManager } from "@arc/leasing";

const leases = new LeaseManager();
const lease = await leases.issue({ mount: "database/pg", ttlSeconds: 3600, maxTtlSeconds: 86_400 });
await leases.renew(lease.id);            // extend by ttl, bounded by maxTtl
await leases.revokePrefix("database/");  // revoke everything under a mount
```

The clock and id generator are injectable (`new LeaseManager({ clock, idGen })`) for
deterministic tests. To make leases durable across restarts and consistent across replicas,
pass a persistent store (`new LeaseManager({ store })`) — arc-server supplies a Postgres-backed
one with `SELECT … FOR UPDATE` row locks on renew/revoke (see issue #113).

Part of **Engine A** (infrastructure secrets). See `docs/REFERENCE-hashicorp-vault.md` §5 and
`docs/MONOREPO_PLAN.md`.
