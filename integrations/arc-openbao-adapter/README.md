# @arc/openbao-adapter

Implements the `@arc/secrets-engine` contract against a **colocated OpenBao** server over
its HTTP API. This is the Engine-A core integration: OpenBao provides the barrier, seal/unseal,
Raft HA, PKI, transit, and KV v2; arc drives it through this adapter.

- `OpenBaoClient` — thin HTTP client (`sealStatus()` = the `bao status` round-trip, plus
  read/write/list/delete). Fetch is injectable for tests.
- `OpenBaoKvEngine` — maps arc's `KvEngine` onto OpenBao's `<mount>/data|metadata/<path>` layout.
- `OpenBaoTransitEngine` — maps arc's `TransitEngine` onto `<mount>/keys/<name>`,
  `<mount>/encrypt/<name>`, `<mount>/decrypt/<name>`. Encryption-as-a-service: the engine
  holds the key, your app sends `Uint8Array` plaintext and gets back the portable
  `vault:vN:...` ciphertext string. Key rotation advances `latestVersion`; older versions
  remain valid for decrypt until they're explicitly trimmed.

```ts
import { OpenBaoClient, OpenBaoKvEngine } from "@arc/openbao-adapter";

const client = new OpenBaoClient({ addr: process.env.BAO_ADDR!, token: process.env.BAO_TOKEN });
await client.sealStatus();                       // -> { sealed: false, version, ... }
const kv = new OpenBaoKvEngine(client, "secret");
await kv.put("app/config", { apiKey: "xyz" });
```

### Local dev

```sh
# One-off:
docker run --rm -p 8200:8200 -e BAO_DEV_ROOT_TOKEN_ID=root \
  quay.io/openbao/openbao:latest server -dev

# Or use the included compose file:
docker compose -f integrations/arc-openbao-adapter/docker-compose.yml up -d

export BAO_ADDR="http://127.0.0.1:8200"
export BAO_TOKEN="root"
```

### Smoke test

`tests/integration.test.ts` exercises the full Engine-A round-trip against a real OpenBao
dev server: `sealStatus()` (the `bao status` equivalent), `health()`, and a KV v2
`put → get → list → soft-delete` cycle through `OpenBaoKvEngine`. The suite **skips
entirely when `BAO_ADDR` is unset**, so the default `pnpm test` stays green without
Docker. To run it:

```sh
docker compose -f integrations/arc-openbao-adapter/docker-compose.yml up -d
BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN=root pnpm --filter @arc/openbao-adapter test
```

> **License:** target is **OpenBao (MPL 2.0)** only. This adapter speaks the documented HTTP API
> and contains **no HashiCorp Vault (BSL 1.1) source**. See `integrations/arc-openbao-adapter/CLAUDE.md`.
