# @arc-vault/openbao-adapter

Implements the `@arc-vault/secrets-engine` contract against a **colocated OpenBao** server over
its HTTP API. This is the Engine-A core integration: OpenBao provides the barrier, seal/unseal,
Raft HA, PKI, transit, and KV v2; arc drives it through this adapter.

- `OpenBaoClient` — thin HTTP client (`sealStatus()` = the `bao status` round-trip, plus
  read/write/list/delete). Fetch is injectable for tests.
- `OpenBaoKvEngine` — maps arc's `KvEngine` onto OpenBao's `<mount>/data|metadata/<path>` layout.

```ts
import { OpenBaoClient, OpenBaoKvEngine } from "@arc-vault/openbao-adapter";

const client = new OpenBaoClient({ addr: process.env.BAO_ADDR!, token: process.env.BAO_TOKEN });
await client.sealStatus();                       // -> { sealed: false, version, ... }
const kv = new OpenBaoKvEngine(client, "secret");
await kv.put("app/config", { apiKey: "xyz" });
```

### Local dev

```sh
docker run --rm -p 8200:8200 -e BAO_DEV_ROOT_TOKEN_ID=root \
  quay.io/openbao/openbao:latest server -dev
export BAO_ADDR="http://127.0.0.1:8200"
export BAO_TOKEN="root"
```

> **License:** target is **OpenBao (MPL 2.0)** only. This adapter speaks the documented HTTP API
> and contains **no HashiCorp Vault (BSL 1.1) source**. See `integrations/arc-openbao-adapter/CLAUDE.md`.
