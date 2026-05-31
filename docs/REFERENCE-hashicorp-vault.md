# Reference — HashiCorp Vault / OpenBao Feature Set

> Purpose: an exhaustive map of what Vault provides so arc can reach feature parity for
> **Engine A (infrastructure secrets)**. Read this to understand *behavior*; implement against
> **OpenBao (MPL 2.0)**, never by copying Vault's BSL code.
>
> Reference repos/docs:
>
> - OpenBao (build on this): <https://github.com/openbao/openbao> · <https://openbao.org/>
> - Vault docs (read to understand): <https://developer.hashicorp.com/vault/docs>
> - Vault repo (read, do not copy — BSL): <https://github.com/hashicorp/vault>

-----

## 1. Core Concepts

- **Secrets engine**: a mountable plugin that stores, generates, or encrypts secrets. Mounted at a path (case-sensitive). Each behaves per its own API. Can be enabled / disabled / moved / tuned (TTLs etc.). Disabling revokes all its secrets and deletes its data.
- **Auth method**: a mountable plugin that authenticates a caller against an internal or external system and returns an identity + token. Vault enforces auth as part of request processing.
- **Token**: the core unit of access. Every authenticated request carries a token with attached policies and a TTL. The `token` auth method is built-in at `auth/token`.
- **Policy**: declarative ACL (path + capabilities: create/read/update/delete/list/sudo/deny). Least-privilege model. Attached to tokens/identities.
- **Lease**: every dynamic secret + service token has a lease (TTL). Leases can be renewed or revoked; expiry triggers automatic revocation/cleanup.
- **Identity**: entities (a user across all their auth aliases) + groups, managed by the built-in Identity secrets engine. One policy framework across all auth methods.
- **Mount system**: everything (engines, auth) is mounted at a path; requests route by path prefix.
- **Static vs dynamic secrets**: static = stored encrypted, long-lived; dynamic = generated on demand, short-lived, auto-revoked at lease end.

-----

## 2. Secrets Engines (full list)

### Key/Value & generic

- **KV v1** — simple key/value store.
- **KV v2** — versioned key/value, with metadata, soft-delete, undelete, destroy, check-and-set.
- **Cubbyhole** — per-token private storage; data tied to the token, destroyed when token expires. Used for response-wrapping.
- **Identity** — entities & groups, identity tokens (OIDC-style), aliases. Built-in, cannot be disabled.
- **TOTP** — generate & validate time-based OTP codes (provider role) or store keys to act as a TOTP client.

### Databases (dynamic credentials, with per-DB plugins)

Cassandra · Couchbase · Elasticsearch · HanaDB (SAP) · InfluxDB · MongoDB · MongoDB Atlas · MSSQL · MySQL / MariaDB · Oracle · PostgreSQL · Redis · Redshift · Snowflake · (custom plugins). Capabilities: generate dynamic DB users with TTL, rotate root credential, rotate static-role passwords.

### Cloud

- **AWS** — dynamic IAM users, STS AssumeRole / federation tokens.
- **Azure** — dynamic service principals, MSI.
- **Google Cloud** — dynamic SA keys & short-lived OAuth tokens.
- **AliCloud** — dynamic RAM credentials.
- **Google Cloud KMS** — encrypt/decrypt/sign via GCP KMS.
- **Consul** — dynamic Consul ACL tokens.
- **Nomad** — dynamic Nomad ACL tokens.
- **Kubernetes** — generate short-lived K8s service-account tokens / RBAC.
- **Terraform Cloud** — dynamic TFC/TFE API tokens.

### PKI / Certificates

- **PKI** — full X.509 CA: issue/sign/revoke certs, intermediate CAs, CRL/OCSP, ACME protocol support (Vault acts as an ACME CA), short-lived leaf certs.
- **SSH** — three modes: **Signed Certificates** (CA signs user SSH keys), **SSH OTP** (one-time passwords for SSH), **Dynamic Key** (legacy).
- **Venafi** — certificate issuance via Venafi platform.

### Encryption / data protection

- **Transit** — encryption-as-a-service: encrypt/decrypt/sign/verify/HMAC/rewrap without storing data; key versioning & rotation, convergent encryption, datakey generation, managed keys (cloud KMS / PKCS#11 HSM), AEAD ciphers (aes128-gcm96, aes256-gcm, chacha20-poly1305).
- **Transform** *(Enterprise)* — format-preserving encryption (FPE, FF3-1), tokenization, data masking.
- **Key Management** *(Enterprise)* — distribute & manage keys in external KMS (Azure Key Vault, AWS KMS, GCP).
- **KMIP** *(Enterprise)* — act as a KMIP server for enterprise key management.

### Messaging / misc

- **RabbitMQ** — dynamic RabbitMQ user credentials.
- **OpenLDAP / Active Directory** — manage & rotate LDAP/AD account passwords, dynamic LDAP credentials, check-out/check-in of service accounts.

-----

## 3. Auth Methods (full list)

### Machine / platform identity

- **AppRole** — RoleID + SecretID for apps/automation (supports custom mount path).
- **AWS** — authenticate via EC2 instance identity or IAM.
- **Azure** — authenticate via Azure MSI / managed identity.
- **GCP** — authenticate via GCE instance identity or IAM SA.
- **AliCloud** — RAM-based.
- **Kubernetes** — authenticate via K8s ServiceAccount JWT.
- **Cloud Foundry (CF)** — instance identity.
- **TLS Certificates (cert)** — client X.509 cert auth.
- **Kerberos** — SPNEGO/Kerberos.

### Human / federated identity

- **Userpass** — username + password.
- **LDAP** — corporate LDAP/AD directory.
- **OIDC / JWT** — OpenID Connect login or raw JWT verification.
- **OAuth-based SSO** via OIDC providers (Okta, Azure AD, Google, etc.).
- **Okta** — native Okta auth.
- **RADIUS** — RADIUS server auth.
- **GitHub** — GitHub org/team-based auth.
- **Token** — built-in; create/renew/revoke tokens directly.

-----

## 4. Identity, Policy & Access Control

- **Entities & aliases** — one entity unifies a user's multiple auth-method logins.
- **Groups** — internal groups + external (mapped from IdP). Policies attach to entities/groups.
- **ACL policies** — path-based capabilities (create/read/update/delete/list/sudo/deny), parameter constraints, allowed/denied parameters, required parameters.
- **Templated policies** — inject entity metadata into policy paths.
- **Sentinel / RGP & EGP** *(Enterprise)* — fine-grained, logic-based policies (role-governing & endpoint-governing).
- **Control groups** *(Enterprise)* — require multi-party approval before a request proceeds.
- **Namespaces** *(Enterprise; FREE in OpenBao)* — multi-tenancy: isolated mounts/policies/identities per namespace.

-----

## 5. Tokens & Leasing

- **Token types**: service tokens (leased, renewable), batch tokens (lightweight, non-persisted), periodic tokens, orphan tokens.
- **Token lifecycle**: create, lookup, renew, revoke (single + tree), accessor-based management.
- **Lease management**: every dynamic secret has a lease; renew, revoke, revoke-prefix, revoke-force; max-TTL caps; automatic expiry.
- **Response wrapping** — wrap a secret in a single-use cubbyhole token with its own TTL; unwrap once.

-----

## 6. Cryptographic Barrier, Seal & Storage

- **Security barrier** — all data encrypted (AES-256-GCM) before hitting storage; the barrier key is itself encrypted by the master key.
- **Seal / Unseal** — Shamir secret sharing (split master key into N shares, need K to unseal), or **auto-unseal** via cloud KMS / HSM / Transit (another Vault).
- **Rekey / rotate** — rotate the master key and the encryption key.
- **Storage backends** — Integrated Storage (Raft, recommended), Consul, plus legacy (S3, GCS, Azure, DynamoDB, etcd, MySQL, PostgreSQL…). OpenBao focuses on Raft + file.
- **High availability** — active/standby via Raft or Consul; leader election.
- **Seal wrapping** *(Enterprise)* — extra encryption of stored values via the seal mechanism.

-----

## 7. Operations & Observability

- **Audit devices** — log every request/response (HMAC'd sensitive fields) to file, syslog, or socket. Multiple devices; if all fail, requests block (fail-closed).
- **Activity log / client counting** — track unique clients for billing/usage.
- **Telemetry / metrics** — Prometheus, StatsD, etc.
- **Plugin system** — external secrets/auth/database plugins run as separate processes over **gRPC via hashicorp/go-plugin**: multiplexing, mutual TLS between core and plugin, health checks + auto-restart. Plugins registered in a catalog (with SHA256 pinning).
- **Replication** *(Enterprise)* — Performance Replication (scale reads) & Disaster Recovery Replication.
- **Auto-snapshots** *(Enterprise)* — scheduled Raft snapshots (manual scripting in OSS/OpenBao).

-----

## 8. Integrations & Agents

- **Vault Agent** — client-side daemon: auto-auth (AppRole/AWS/Azure/GCP/JWT/Kerberos/K8s/cert), templating (render secrets into files), caching, persistent caching.
- **Vault Secrets Operator (VSO)** — Kubernetes operator: sync any Vault secret engine into K8s Secrets via CRDs (VaultConnection, VaultAuth, VaultStaticSecret, VaultDynamicSecret, VaultPKISecret); rollout-restart on rotation; client cache.
- **Vault CSI provider** — mount secrets into pods via the Secrets Store CSI driver.
- **Agent Injector** — mutating admission webhook injects an init/sidecar Vault Agent into pods.
- **CLI** (`vault` / `bao`) — full management surface.
- **HTTP API** — everything is API-first; UI and CLI are clients of it.

-----

## 9. What arc must build for Engine-A parity (mapped to arc packages)

| Vault capability | arc home |
|------------------|----------|
| Secret engine contract + mounts | `packages/arc-secrets-engine` |
| KV v1/v2 (versioned) | engine impl behind adapter |
| Dynamic DB/cloud/SCM creds | `plugins/*` implementing `SecretsPlugin` |
| Lease / renew / revoke | `packages/arc-leasing` |
| PKI / SSH-CA / Transit | OpenBao via `integrations/arc-openbao-adapter` (or dedicated plugins) |
| Auth methods (OIDC, K8s, cloud) | `plugins/auth/*` implementing `AuthPlugin` |
| Policies / entities / groups | `packages/arc-grants` + `packages/arc-identity` |
| Tokens & response wrapping | `packages/arc-auth` |
| Audit devices | `packages/arc-audit` |
| Agent / K8s operator / injector | `infra/arc-operator` |
| Seal/unseal, barrier, Raft HA | provided by colocated OpenBao |

**Strategy**: colocate OpenBao for the hard cryptographic core (barrier, seal, Raft, PKI,
transit, KV v2) and expose arc's clean API + plugin system on top. Build dynamic-cred breadth
(cloud/SCM/db) as arc plugins so arc isn't limited to OpenBao's engine catalog.
