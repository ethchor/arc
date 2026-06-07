# arc-go-sdk

Official Go client for [arc](https://github.com/ethchor/arc)'s **Engine-A** (infrastructure
secrets) HTTP API — the same surface the operator and agent use. Standard-library only, no
external dependencies.

```sh
go get github.com/ethchor/arc/sdks/arc-go-sdk
```

```go
import arc "github.com/ethchor/arc/sdks/arc-go-sdk"

c := arc.New("https://arc.svc:3001")

// Authenticate with a Kubernetes ServiceAccount token (or arc.WithToken("..."))
_, err := c.LoginKubernetes(ctx, "kubernetes", "my-role", saToken)

// Read a KV v2 secret
sec, err := c.KVGet(ctx, "secret", "app/prod/db", 0) // 0 = latest version
db := sec.Data.Data["password"]

// Mint a short-lived dynamic credential
cred, err := c.IssueDynamic(ctx, "aws", "deployer", 900)
key := cred.Data["access_key"]
defer c.RevokeLease(ctx, cred.LeaseID)
```

## What's covered

Engine-A only: `LoginKubernetes`, `KVGet`, `KVPut`, `IssueDynamic`, `RevokeLease`. The client
caches the arc JWT, forwards it as the bearer, and retries once on a 401 (token revoked
server-side); a 403 is returned as an `*APIError` without retry.

**Engine-B (the end-to-end vault) is intentionally not exposed** — that's a client-side
zero-knowledge cryptosystem; use [`@arc/sdk`](../arc-js-sdk) (TypeScript) for vault items.

## Trust model

This client is **not** the authorization decision point. arc-server's `@arc/grants` policy
engine gates every call; the SDK only carries a policy-bound token.

## License

The repo license is being finalized — see the root project. Add a `LICENSE` here (or rely on
the repo root) before tagging a Go module release (`git tag sdks/arc-go-sdk/v0.1.0`).
