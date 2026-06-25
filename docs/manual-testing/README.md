# arc — Manual Testing Guide

A step-by-step playbook for spinning the whole stack up locally and exercising every shipped
feature by hand. Pair this with `pnpm -r test` (automated coverage — 300 tests) for full
confidence; this guide is for the cases automation can't validate cleanly, like browser PRF
authenticators, the live OpenBao backend, and the cross-engine UX.

> **Status reference.** The set of features below tracks `docs/STATUS.md`. If something here
> looks stale, that doc is the source of truth.

## Contents

| File | What it covers |
|------|---|
| `00-prerequisites.md` | Toolchain, env vars, docker, browser support |
| `01-bootstrap.md` | Clone → install → build → run the full stack locally |
| `02-engine-b-vault.md` | Engine-B (E2E vault) — enroll, unlock, items, folders, sharing, rotation, devices, recovery, audit |
| `03-passkey-unlock.md` | Register a passkey → unlock with it (server + SDK shipped, web UI pending) |
| `04-engine-a-openbao.md` | Engine-A (OpenBao-backed) — KV v2, transit, PKI, database dynamic creds (HTTP/CLI) |
| `05-plugin-host.md` | Mount the AWS / GCP / GitHub plugins programmatically + dispatch through `/v1` |
| `06-grants-acl.md` | Per-mount ACL — bootstrap root, create policies, attach/detach, default-deny |
| `07-cli.md` | `arc-vault` CLI: login, enroll, create-vault, set/get, TOTP |
| `08-e2e-scripts.md` | Cross-engine flows (e.g. "store a DB password in Engine B + mint a DB cred via Engine A") |
| `09-troubleshooting.md` | Common failures and how to diagnose them |
| `10-operator-engines.md` | Engine-A through the **operator UI** — KV browser, Transit playground, PKI issue/revoke, dynamic creds ceremony, server-wide Leases (PRs #108–#112) |

## Quick-start (TL;DR)

```bash
# clone + install + build
git clone https://github.com/ethchor/arc.git
cd arc
pnpm install
pnpm -r build

# fast-feedback automated tests (300 passing)
pnpm -r test

# start the full stack for manual testing
docker compose -f integrations/arc-openbao-adapter/docker-compose.yml up -d   # OpenBao
export BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN=root
pnpm --filter @arc/server start &                                              # arc-server :3001
pnpm --filter @arc/vault-web dev                                               # web UI :3002

# open http://localhost:3002 and follow `02-engine-b-vault.md`
```

Everything else, in order of "what to try first":

1. [`01-bootstrap.md`](01-bootstrap.md) — get the stack running
2. [`02-engine-b-vault.md`](02-engine-b-vault.md) — the consumer vault flow (always-works,
   no docker required) — now covers the **Security dashboard**, **breach exposure** (HIBP
   k-anonymity), **fix-weak wizard**, and **Home device posture**
3. [`04-engine-a-openbao.md`](04-engine-a-openbao.md) — once OpenBao is up, infra-secrets
   through the HTTP / CLI surface
4. [`10-operator-engines.md`](10-operator-engines.md) — the same engines through the
   **operator web UI**: KV browser, Transit playground, PKI issuance, dynamic creds,
   server-wide Leases
5. [`05-plugin-host.md`](05-plugin-host.md), [`06-grants-acl.md`](06-grants-acl.md) — the
   platform pieces
6. [`08-e2e-scripts.md`](08-e2e-scripts.md) — verify the two engines feel like one product

> **Going to prod?** Read [`../production-hardening.md`](../production-hardening.md)
> first — the env-var contract, boot-time fail-closed gates, and the per-variable
> reference. This guide is for QA; that doc is for ops.

For a feature-by-feature checklist (good for release validation):
[`checklist.md`](checklist.md).
