# @arc-vault/plugin-sdk

Contracts + in-process host for arc's plugin system (parity with Vault's secret-engine / auth-method
ecosystem). A plugin depends on **this package only** (plus `arc-types` once it exists) — never on
app internals.

- `SecretsPlugin` — dynamic credential generation + revocation.
- `AuthPlugin` — authenticate a caller against an external IdP → arc identity + policies.
- `StoragePlugin` — pluggable backend storage (optional).
- `PluginHost` — register/lookup plugins by name and kind.
- `scopeAllows(scopes, path, capability)` — capability check used to constrain what a plugin may do.

**Security invariant:** plugins never receive the Engine-B master key — only their own config and
scoped capabilities. See `docs/MONOREPO_PLAN.md` §3b.

```ts
import { PluginHost } from "@arc-vault/plugin-sdk";

const host = new PluginHost();
host.register(myAwsPlugin);
const creds = await host.getSecrets("arc-plugin-aws").issue({ role: "deployer" });
```
