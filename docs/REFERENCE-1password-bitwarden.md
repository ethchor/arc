# Reference — 1Password & Bitwarden Feature Set

> Purpose: an exhaustive map of what the leading E2E password managers provide, so arc can
> reach parity for **Engine B (end-to-end-encrypted vault)**.
>
> - 1Password = the UX/feature gold standard (proprietary — study behavior only).
> - Bitwarden = the open-source reference for *architecture* (GPL/AGPL — reimplement the crypto
>   model in `arc-crypto`; do not vendor). Repo: <https://github.com/bitwarden> ·
>   Open-source overview: <https://bitwarden.com/open-source/>
> - Vaultwarden (AGPL, study only): <https://github.com/dani-garcia/vaultwarden>

-----

## PART A — 1Password

### A1. Core vault & items

- End-to-end encrypted vaults; **two-secret key derivation**: account password + a 128-bit Secret Key combined to derive the account key (defense even if password is weak).
- Item types: logins, passwords, passkeys, secure notes, credit cards, identities, API credentials, SSH keys, documents/files, software licenses, medical/crypto records, custom fields & sections.
- Multiple vaults; per-vault sharing; organize by tags & favorites.
- Watchtower: weak/reused/compromised password detection, breach alerts (HaveIBeenPwned), 2FA-available alerts, expiring items.

### A2. Autofill & clients

- Browser extensions (all major browsers), desktop apps (Mac/Win/Linux), mobile (iOS/Android), web.
- Autofill logins, passkeys, cards, identities; inline save/update prompts.
- Built-in TOTP generator (stores & autofills 2FA codes).
- Biometric unlock (Touch ID / Windows Hello / fingerprint).

### A3. Passkeys & passwordless

- Store, sync, and autofill **passkeys** across devices.
- Unlock 1Password itself with a passkey on some flows.

### A4. Sharing & collaboration

- Shared vaults with role-based access.
- **Item sharing via secure link** (time-limited, recipient-restricted, view limits) — share even with non-users.
- Family/Team/Business org structures; guest accounts.

### A5. Developer tools (the "secrets management" half)

- **1Password CLI (`op`)** — read/write items, inject secrets, automate admin; sign into the CLI with biometrics.
- **SSH agent** — generate/import/store SSH keys; authorize SSH/Git auth with fingerprint; private key never leaves 1Password; per-process control; SSH agent activity log.
- **Git commit signing** — sign commits with SSH keys held in 1Password.
- **Secret references** — `op://vault/item/field` URIs; load into env vars / config without plaintext.
- **Environments** — manage project `.env` secret sets, load directly without exposing plaintext.
- **Service accounts** — scoped tokens for automation/AI agents (scoped to vaults/environments/permissions).
- **Connect server** — self-hosted private REST API to serve secrets to apps/infra.
- **SDKs** — Go, JavaScript, Python; embed in apps/AI agents to decrypt secrets at runtime.
- **Shell plugins** — authenticate third-party CLIs (aws, gh, glab, etc.) with fingerprint, no plaintext creds.
- **VS Code extension** — detect plaintext secrets, replace with secret references.
- **Secrets Automation** — native CI/CD integration (GitHub Actions, GitLab CI, Jenkins, CircleCI); secrets fetched at runtime via service accounts.
- **Developer Watchtower** — flags exposed developer credentials (unencrypted SSH keys, plaintext .env).

### A6. Enterprise / admin

- SSO (with identity providers), SCIM provisioning bridge, directory sync.
- Admin console: user/group management, access policies, reporting.
- **Events API** (SIEM), **Users API**, **Partnership API** (billing).
- Travel Mode, device/firewall policies, audit/usage reporting.
- **Unified Access** (2026): discover AI/agent credential usage across endpoints, vault exposed secrets one-click, govern human/agent/machine credentials, audit who-used-what; roadmap to issue scoped runtime credentials to agents.

-----

## PART B — Bitwarden (open-source reference)

### B1. Core vault & crypto model (what arc-crypto reimplements)

- Master password → **PBKDF2-SHA256 or Argon2id** key derivation (client-side) → master key → stretched key → protects a random symmetric **vault key**; all items encrypted client-side; server stores **ciphertext only** (zero-knowledge). AES-256.
- Item types: logins, passkeys, cards, identities, secure notes; custom fields; folders; favorites; attachments (Premium).
- No server-side recovery (lose master password → data unrecoverable), mirroring the E2E guarantee.

### B2. Clients

- Browser extensions (all majors), desktop (Electron, Win/Mac/Linux), mobile (iOS/Android), web vault, **full CLI**.
- Autofill, inline menu, biometric unlock, **unlock with passkey**.
- 60+ language translations.

### B3. Generator & extras

- Password / passphrase / username generator; integrates with email-alias providers (SimpleLogin, AnonAddy, Firefox Relay, etc.).
- Built-in TOTP authenticator (Premium) — stores & autofills 2FA codes.
- Advanced 2FA for login: authenticator app, email codes, **FIDO2 WebAuthn / hardware keys / passkeys** (Premium: up to 10 keys).

### B4. Bitwarden Send

- Transmit **encrypted text or files** to anyone via a link; expiration, max access count, optional password, deletion date. End-to-end encrypted.

### B5. Organizations & sharing

- **Organizations** with **Collections** (shared groups of items) and **Groups** (sets of users).
- Granular per-collection permissions (read/write, hide passwords, manage); principle of least privilege.
- Centralized item ownership; org policies (master-password requirements, 2FA enforcement, etc.).
- Account recovery (admin can reset enterprise user master password, if policy enabled).

### B6. Enterprise / admin

- **Login with SSO** via SAML 2.0 or OIDC.
- **SCIM** provisioning + **Directory Connector** (LDAP/AD/Okta/OneLogin/Azure AD) sync.
- **Event logs** (timestamped org actions), **SIEM integrations** (incl. Elastic for collection/event/group/policy data).
- Public **API** for org management (members revoke/restore, etc.).
- **Access Intelligence** — shadow-IT discovery, risk prioritization, guided password updates.
- Self-hosting (cloud or on-prem / private cloud) for data sovereignty.

### B7. Bitwarden Secrets Manager (their Engine-A analogue)

- Separate product for **infrastructure secrets**: centralize API keys, DB credentials, SSH keys, certificates in E2E-encrypted vault.
- **Projects** group secrets; assign user + machine access per project.
- **Machine accounts** — scoped access tokens for machines / AI agents (least-privilege).
- CLI + SDK to inject secrets into dev workflows & CI/CD; **Jenkins** pipeline injection, GitHub Actions, etc.
- Enterprise: SSO, SCIM, self-hosting, enterprise policies, event logs.

### B8. Recent (2026) notable

- Passkey storage on self-hosted servers; unlock with passkeys; import SSH keys from 1Password (.1pux); import/export passkeys via .json.

-----

## PART C — arc Engine-B parity checklist (mapped to arc packages)

| Capability | Source of idea | arc home |
|------------|----------------|----------|
| Zero-knowledge crypto (KDF, vault-key hierarchy, AES-256) | Bitwarden model | `packages/arc-crypto` |
| Two-secret strengthening (password + secret key) | 1Password | `packages/arc-crypto` (optional, stronger) |
| Item types (logins, passkeys, cards, notes, SSH keys, files) | both | `packages/arc-types` + `apps/arc-vault-web` |
| Passkey storage / autofill | both | `arc-crypto` + `arc-browser-extension` |
| Built-in TOTP | both | `arc-crypto` + clients |
| Autofill & biometric unlock | both | `apps/arc-browser-extension`, `arc-vault-desktop` |
| Secure send (encrypted link) | Bitwarden Send | `apps/arc-server` + `arc-crypto` |
| Vaults / collections / groups / org roles | both | `packages/arc-grants` + `arc-identity` |
| Per-item / per-collection sharing | both | `arc-grants` + `arc-crypto` (key wrapping) |
| Secret references (`arc://...`) | 1Password | `apps/arc-cli` + `sdks/arc-js-sdk` |
| SSH agent + Git signing | 1Password | `apps/arc-cli` / `arc-vault-desktop` |
| Service / machine accounts (scoped tokens) | both | `packages/arc-auth` + `arc-grants` |
| SDKs (JS/Go/Python) | both | `sdks/*` |
| CI/CD secret injection | both | `apps/arc-cli` + plugins |
| SSO / SCIM / directory sync | both | `plugins/auth/*` + `arc-identity` |
| Event logs / SIEM | both | `packages/arc-audit` |
| Watchtower (breach/weak-password) | both | `apps/arc-server` (analysis service) |
| Self-hosting | both | `infra/arc-helm-charts`, `arc-terraform` |

**Key architectural note:** arc's differentiator is unifying Engine A (Vault-class infra
secrets, dynamic creds, leasing) and Engine B (1Password/Bitwarden-class E2E personal/team
vault) under one identity, one policy model (`arc-grants`), one audit trail (`arc-audit`),
and one UI — something none of the three do fully in a single self-hostable product.
