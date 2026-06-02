# 04 — Engine-A (OpenBao-backed infra secrets)

Engine-A is the OpenBao surface mounted under `/v1/*`. The wire shape is Vault-compatible
so existing Vault CLIs / SDKs hit arc-server unchanged.

**Prereq.** OpenBao running on `:8200` and arc-server started with `BAO_ADDR` set. See
[`01-bootstrap.md`](01-bootstrap.md) §4.

## Getting an auth token

Engine-A respects the same JWT auth as Engine-B; grab a token from `/auth/dev-login`:

```bash
export TOKEN=$(curl -s -X POST http://localhost:3001/auth/dev-login \
  -H 'Content-Type: application/json' \
  -d '{"email":"engine-a@example.com"}' | jq -r .accessToken)
```

(With `ARC_DEFAULT_POLICY=deny` this user would get 403 on every `/v1/*` request — see
[`06-grants-acl.md`](06-grants-acl.md) for the bootstrap. The default `allow` mode is fine
for first-pass manual testing.)

## A. List mounts

```bash
curl http://localhost:3001/v1/sys/mounts \
  -H "Authorization: Bearer $TOKEN" | jq
```

Expect: `secret/` (KV v2), `transit/`, `pki/`, `database/`. Each entry carries `path`,
`type`, `description`.

## B. KV v2 round-trip

```bash
# write
curl -X POST http://localhost:3001/v1/secret/data/app/db \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"data":{"url":"postgres://localhost/app","password":"hunter2"}}' | jq

# read
curl http://localhost:3001/v1/secret/data/app/db \
  -H "Authorization: Bearer $TOKEN" | jq

# list under metadata
curl -G http://localhost:3001/v1/secret/metadata/app \
  -H "Authorization: Bearer $TOKEN" --data-urlencode "list=true" | jq

# soft-delete
curl -X DELETE http://localhost:3001/v1/secret/data/app/db \
  -H "Authorization: Bearer $TOKEN" -i
# → 204
```

After delete, the read still returns the body but `metadata.deletion_time` is non-empty
(KV v2 semantics).

## C. Transit (encryption-as-a-service)

```bash
# create a key
curl -X POST http://localhost:3001/v1/transit/keys/payments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"aes256-gcm96"}' | jq

# encrypt
PLAINTEXT_B64=$(echo -n "card-number=4111..." | base64)
curl -X POST http://localhost:3001/v1/transit/encrypt/payments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"plaintext\":\"$PLAINTEXT_B64\"}" | jq
# → { "data": { "ciphertext": "vault:v1:...", "key_version": 1 } }

# decrypt the returned ciphertext
CT="vault:v1:..." # paste from above
curl -X POST http://localhost:3001/v1/transit/decrypt/payments \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"ciphertext\":\"$CT\"}" | jq -r .data.plaintext | base64 -d
# → card-number=4111...

# rotate the key — old ciphertext still decrypts under v1
curl -X POST http://localhost:3001/v1/transit/keys/payments/rotate \
  -H "Authorization: Bearer $TOKEN" | jq
```

## D. PKI (X.509 issuance)

OpenBao dev mode doesn't auto-mount a CA — bootstrap once:

```bash
curl -X POST http://localhost:3001/v1/pki/root/generate/internal \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"common_name":"arc-manual-root","ttl":"87600h"}' | jq

curl -X POST http://localhost:3001/v1/pki/roles/leaf \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"allowed_domains":"arc.test","allow_subdomains":true,"max_ttl":"72h"}' | jq
```

Issue a certificate:

```bash
curl -X POST http://localhost:3001/v1/pki/issue/leaf \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"common_name":"svc.arc.test","ttl":"1h","alt_names":"svc-alt.arc.test"}' | jq
# → { "data": { "certificate": "...", "issuing_ca": "...", "private_key": "...",
#               "serial_number": "...", "expiration": 1717... } }
```

Read CA + list issued certs + revoke:

```bash
curl http://localhost:3001/v1/pki/ca/pem -H "Authorization: Bearer $TOKEN" | jq -r .data.certificate
curl -G http://localhost:3001/v1/pki/certs -H "Authorization: Bearer $TOKEN" --data-urlencode "list=true" | jq
curl -X POST http://localhost:3001/v1/pki/revoke \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"serial_number":"<paste from issue>"}' | jq
```

Re-reading the cert shows `revocation_time` > 0.

## E. Database dynamic credentials (lease lifecycle)

OpenBao needs a backing database + a configured role; the e2e covers the wire shape
extensively, manual test is mostly about lease renew/revoke:

```bash
# (with a Postgres role pre-configured in OpenBao — see OpenBao docs for the one-time setup)
curl http://localhost:3001/v1/database/creds/app-role \
  -H "Authorization: Bearer $TOKEN" | jq
# → { "data": { "username": "v-token-app-...", "password": "..." },
#     "lease_id": "<arc-uuid>", "lease_duration": 3600, "renewable": true }

# renew
LEASE_ID="<paste arc lease id>"
curl -X POST http://localhost:3001/v1/sys/leases/renew \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"lease_id\":\"$LEASE_ID\",\"increment\":1800}" | jq

# revoke
curl -X PUT "http://localhost:3001/v1/sys/leases/revoke/$LEASE_ID" \
  -H "Authorization: Bearer $TOKEN" -i
# → 204
```

The arc-internal lease id (`<arc-uuid>`) maps to the OpenBao backend id internally; the
caller only sees the arc id, which is a small but meaningful UX improvement over Vault's
path-shaped ids.

## F. Disabled-mode behavior (no OpenBao)

Restart arc-server *without* `BAO_ADDR`. Then:

```bash
curl http://localhost:3001/v1/sys/seal-status -H "Authorization: Bearer $TOKEN" -i
# → 503 with { "errors": ["Engine-A (OpenBao backend) is not configured. ..."],
#              "engine": "A", "configured": false }

curl http://localhost:3001/v1/sys/mounts -H "Authorization: Bearer $TOKEN" -i
# → 200 with { "data": [] }    (mounts list survives without a backend)

curl http://localhost:3001/v1/secret/data/x -H "Authorization: Bearer $TOKEN" -i
# → 404 ("no mount at secret/data/x") — *not* 503, because plugin-only deployments are valid
```

Engine-B (`/vaults`, `/vault/*`) is completely unaffected.
