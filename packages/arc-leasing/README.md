# @arc-vault/leasing

Engine-A **lease lifecycle** — Vault-style TTLs, renewal, and revocation — as pure,
backend-agnostic logic. No network, no storage, no crypto.

A `Lease` records when a dynamically issued secret/token was minted, when it expires, and a hard
`maxTtl` ceiling that renewals can never exceed. `LeaseManager` issues leases, renews them
*from now* (capped at the ceiling, as Vault does), revokes them (single or by mount prefix), and
sweeps expired/revoked entries.

```ts
import { LeaseManager } from "@arc-vault/leasing";

const leases = new LeaseManager();
const lease = leases.issue({ mount: "database/pg", ttlSeconds: 3600, maxTtlSeconds: 86_400 });
leases.renew(lease.id);            // extend by ttl, bounded by maxTtl
leases.revokePrefix("database/");  // revoke everything under a mount
```

The clock and id generator are injectable (`new LeaseManager({ clock, idGen })`) for
deterministic tests.

Part of **Engine A** (infrastructure secrets). See `docs/REFERENCE-hashicorp-vault.md` §5 and
`docs/MONOREPO_PLAN.md`.
