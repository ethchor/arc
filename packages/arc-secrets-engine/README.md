# @arc-vault/secrets-engine

Engine-A **clean contract**. Defines arc's secrets-engine interfaces independent of any backend:

- `SecretsEngine` / `KvEngine` (KV v2) / `DynamicSecretsEngine` (leased credentials).
- `MountRegistry` — Vault-style mount table with **longest-prefix path routing**.

Concrete backends implement these: `integrations/arc-openbao-adapter` (OpenBao), and dynamic
credential `plugins/*`. Nothing OpenBao-specific lives here.

```ts
import { MountRegistry } from "@arc-vault/secrets-engine";

const mounts = new MountRegistry();
mounts.mount({ path: "database/pg", type: "database" });
mounts.resolve("database/pg/creds/app"); // -> { mount, relativePath: "creds/app" }
```

Lease types come from `@arc-vault/leasing`. See `docs/REFERENCE-hashicorp-vault.md` §1–2 and
`docs/MONOREPO_PLAN.md`.
