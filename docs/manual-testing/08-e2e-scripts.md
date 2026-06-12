# 08 — Cross-engine end-to-end flows

> **Set `ARC_ENABLE_DEV_LOGIN=true` once in your shell** before starting `arc-server`
> — the MED-C opt-in gates every dev-login curl in the scripts below.

The whole point of arc is **one platform** for infra-secrets *and* the consumer vault.
These scripts walk through scenarios that touch both engines — the kind of thing a real
team would do on day one.

## Flow 1: "Operator onboards a developer"

A developer joins the team. The operator (alice) provisions them with:
- An Engine-B vault entry for their workstation passwords.
- An Engine-A grant to mint short-lived AWS read-only credentials.

```bash
# === Operator side (Alice, role: ARC_ROOT_USERS=1) ===
# 1. Bootstrap as before (01-bootstrap.md) with deny mode.

# 2. Create the team's "platform" vault and add bob as a member.
#    (do this in the web UI — share dialog → bob@example.com)

# 3. Create + attach an Engine-A policy granting bob short-term AWS access:
curl -X POST http://localhost:3001/v1/sys/policy \
  -H "Authorization: Bearer $ROOT_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name":"aws-read",
    "scopes":[{"pathPrefix":"aws/","capabilities":["read"]}]
  }'

curl -X POST http://localhost:3001/v1/sys/policy/aws-read/attach \
  -H "Authorization: Bearer $ROOT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"subject\":\"$BOB_USER_ID\"}"

# === Developer side (Bob) ===
# 4. Bob signs into the web UI → unlocks his vault → reads platform creds shared by Alice.
# 5. Bob mints temporary AWS creds:
curl http://localhost:3001/v1/aws/creds/read-only -H "Authorization: Bearer $BOB_TOKEN" | jq
# → { "data": { "access_key": "AKIA...", "secret_key": "...", "session_token": "..." }, ... }
# 6. Bob can't touch /v1/database/ or /v1/pki/ — 403.
```

## Flow 2: "Storing infra creds in the consumer vault"

Sometimes you need a long-lived value (e.g. a third-party API key) that's not in the
infra engine. Put it in Engine-B alongside the team's other secrets.

```bash
# Alice creates a "third-party-keys" vault and adds the API key:
arc-vault create-vault --name third-party-keys
arc-vault set --vault third-party-keys --key STRIPE_LIVE_KEY --value "sk_live_..."
# Server stores ciphertext only. Alice's web client encrypted it locally.

# Alice shares the vault with bob via the web UI.
# Bob unlocks, sees the same key (decrypted client-side with the VK Alice sealed to his
# hybrid public key).
```

## Flow 3: "Cert + DB cred for a deployment"

A staging deploy needs a TLS cert AND a Postgres credential. One request to arc-server for
each — auth, audit, and ACL are unified.

```bash
export TOKEN=$(curl -s -X POST http://localhost:3001/auth/dev-login \
  -H 'Content-Type: application/json' -d '{"email":"deploy-bot@example.com"}' | jq -r .accessToken)

# Mint a leaf certificate (Engine-A PKI):
CERT=$(curl -s -X POST http://localhost:3001/v1/pki/issue/leaf \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"common_name":"staging.arc.test","ttl":"24h"}' | jq -r .data.certificate)
echo "$CERT" > /tmp/staging.crt

# Mint a short-lived DB cred (Engine-A database, with renewal lifecycle):
CRED=$(curl -s http://localhost:3001/v1/database/creds/app-role -H "Authorization: Bearer $TOKEN")
USERNAME=$(echo "$CRED" | jq -r .data.username)
PASSWORD=$(echo "$CRED" | jq -r .data.password)
LEASE=$(echo "$CRED" | jq -r .lease_id)

# Use them:
psql "postgres://$USERNAME:$PASSWORD@db/app?sslmode=verify-full&sslcert=/tmp/staging.crt"

# Halfway through the deploy, refresh the DB cred:
curl -X POST http://localhost:3001/v1/sys/leases/renew \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"lease_id\":\"$LEASE\",\"increment\":1800}"

# At the end, revoke + delete the cert:
curl -X PUT "http://localhost:3001/v1/sys/leases/revoke/$LEASE" -H "Authorization: Bearer $TOKEN"
SERIAL=$(curl -s http://localhost:3001/v1/pki/issue/leaf ... | jq -r .data.serial_number)
curl -X POST http://localhost:3001/v1/pki/revoke -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"serial_number\":\"$SERIAL\"}"
```

The same JWT and the same audit trail cover both engines.

## Flow 4: "Lost-laptop recovery"

Bob loses his laptop. Alice (admin) revokes Bob's devices; Bob recovers his vault from
his recovery key on a new laptop; the team-shared vaults remain accessible.

```bash
# Alice's side — revoke Bob's old device (web UI: Devices → revoke).
# This invalidates the device's wrapped VK; the device can no longer pull items.

# Bob's side — new laptop:
arc-vault login --email bob@example.com
# On the unlock screen, click "Forgot your master password?" → paste recovery key.
# Bob's identity priv is unwrapped from the recovery envelope; a new master password is set.
# Existing shared vaults are still accessible (the VK grants are sealed to bob's identity,
# not his master password).
```

## Flow 5: "PR robot mints a GitHub installation token"

CI needs a short-lived GitHub token to read protected branches. Configure the GitHub
plugin once (programmatically — admin HTTP API for plugin registration is queued);
CI calls `/v1/github/creds/ci`.

```bash
# CI script:
export TOKEN=$(curl -s -X POST $ARC_BASE/auth/dev-login \
  -H 'Content-Type: application/json' -d '{"email":"ci-runner@example.com"}' | jq -r .accessToken)
GH_TOKEN=$(curl -s $ARC_BASE/v1/github/creds/ci -H "Authorization: Bearer $TOKEN" | jq -r .data.token)
git -c http.extraheader="Authorization: token $GH_TOKEN" clone https://github.com/acme/private-repo
```

The token expires in 1h. No renewal — the next CI step mints a fresh one.

## Invariants to spot-check while running these flows

- The arc-server logs show metadata only (method, URL, status, request id) — no bodies.
- The audit log under `/vaults/:id/audit` records every privileged action.
- Bob never sees Alice's identity *private* key in any response — Engine-B is
  zero-knowledge by construction.
- Engine-A errors are translated cleanly: OpenBao 4xx surfaces as a `503` with
  `{errors, status}` rather than leaking the raw upstream JSON.
