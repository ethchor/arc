# 07 — CLI

The `arc-vault` CLI is the command-line surface over the same SDK the web UI uses.
Handy for scripted setup, headless tests, and "I just want to grep a value" workflows.

## Build + invoke

```bash
pnpm --filter @arc/cli build
node apps/arc-cli/dist/bin.js --help
```

The CLI's auth/session state is stored in `~/.arc-vault/session.json` (a plain JSON
file with the JWT + key handles). To start fresh: `rm ~/.arc-vault/session.json`.

## Commands (alphabetical)

```
arc-vault login          --email <e>                      # /auth/dev-login → store token
arc-vault enroll         --password <pw>                  # /vault/enroll
arc-vault unlock         --password <pw>                  # /vault/unlock + local IK derive
arc-vault whoami                                         # print current account + identity fingerprint
arc-vault create-vault   --name <n> [--type team|personal] # /vaults POST
arc-vault ls             [--vault <name>]                 # list vaults, or items in one
arc-vault set            --vault <n> --key <k> --value <v> # store a generic key/value
arc-vault get            --vault <n> --key <k>             # read a value
arc-vault totp-add       --vault <n> --uri 'otpauth://...' # add a TOTP item from a URI
arc-vault totp           --vault <n> --key <k>             # print the rotating code
```

## Quick smoke (5 commands)

```bash
BASE=http://localhost:3001
arc=$(echo "node apps/arc-cli/dist/bin.js --base-url $BASE")

$arc login --email cli-smoke@example.com
$arc enroll --password 'cli-test-pw-12345'
$arc create-vault --name dev
$arc set --vault dev --key DATABASE_URL --value 'postgres://localhost/x'
$arc get --vault dev --key DATABASE_URL
# → postgres://localhost/x
```

## TOTP round-trip

```bash
URI='otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme&digits=6&period=30'
$arc totp-add --vault dev --uri "$URI"
$arc totp --vault dev --key Acme-alice    # 6-digit code valid for the current 30s window
```

Cross-check with the e2e fixture: `apps/arc-server/test/cli.e2e-spec.ts` boots a full
server + driver and round-trips the same flow.

## Headless flow against the running stack

```bash
# Stand up the stack (see 01-bootstrap.md)
# Then:
arc-vault login --email automation@example.com
arc-vault enroll --password "$AUTOMATION_PASSWORD"
arc-vault create-vault --name production-secrets
for k in DB_URL REDIS_URL OPENAI_KEY; do
  arc-vault set --vault production-secrets --key "$k" --value "${!k}"
done
arc-vault ls --vault production-secrets
```

The CLI doesn't yet support listing shares, devices, audit, or sharing operations —
those are web-only today and tracked under "Phase 1 finish" in `STATUS.md`.
