# 12 — Clients, Sessions & Browser Extension

Covers per-client session security, the Tauri/Rust core, and the browser-extension
architecture (the highest-risk consumer surface). The guiding assumption is doc 02 §2.4:
while unlocked, code in the client can read secrets — so minimize the unlock window and the
unlocked surface, and keep keys out of the most exposed contexts.

## 12.1 Web client (Next.js)

Hard limits (doc 02 §2.4): JS can't guarantee secret erasure; XSS while unlocked = full
compromise. Therefore:

- **Keys never persisted.** VEK/VK/IK and the identity/signing privs live only in a single
  module-scoped closure while unlocked. They are **never** in Zustand `persist`,
  `localStorage`, `sessionStorage`, IndexedDB, or any React state that could serialize. (The
  auth store's pattern of excluding tokens from `partialize` is the model; the vault store
  excludes *all* key material.)
- **Best-effort zeroization** on lock: overwrite typed arrays, drop references. Acknowledged
  as best-effort only.
- **Minimal unlock window:** aggressive auto-lock (§12.3).
- **Prefer the Rust core when available:** under Tauri, the web layer asks Rust to
  decrypt/encrypt and only ever receives the specific field it needs, so the VK never enters
  the WebView (§12.2).

### CSP / XSS hardening

- Strict CSP: `default-src 'self'`; no `unsafe-inline` / `unsafe-eval`; `connect-src` limited
  to the API origin (localhost API under Tauri); no third-party scripts.
- **Trusted Types** enabled; no `dangerouslySetInnerHTML` anywhere in vault routes.
- Subresource Integrity on any external asset (ideally none for vault routes).
- On desktop, the vault is served as a static export from `tauri://localhost` — no remote
  origin — shrinking the XSS/network surface.
- XSS while unlocked still = compromise; CSP reduces, it does not eliminate.

## 12.2 Tauri / Rust core (`apps/arc-vault-desktop/src-tauri/src/vault/`)

Materially stronger than the browser: keys live in Rust `Zeroizing` memory and the WebView
never holds the VK. Module sketch:

| File | Responsibility |
| ---- | -------------- |
| `mod.rs` | command registration; in-memory `VaultSession` state |
| `crypto.rs` | Argon2id derive, HKDF split, XChaCha20-Poly1305 seal/open, `crypto_box`/seal, Ed25519, JCS+digest — the **same** envelope/serialization as `packages/arc-crypto` (doc 04) |
| `keychain.rs` | OS keychain (`keyring`): stores **only** the device X25519 private key (and optionally a device VK grant). Never MK/VK/identity-priv plaintext. |
| `store.rs` | `rusqlite` + SQLCipher offline encrypted cache; the SQLCipher DB key is random, wrapped under the keychain device key |
| `session.rs` | auto-lock timer; holds VK in `Zeroizing` while unlocked |

Tauri commands (registered in `lib.rs` `invoke_handler`): `vault_derive_keys`,
`vault_unlock`, `vault_lock`, `vault_encrypt_item`, `vault_decrypt_item`,
`vault_device_keypair`, `vault_wrap_vek_for(pubkey)`, `vault_open_vek(encVekDevice)`,
`vault_sign_mutation`, `vault_verify_head`, `vault_set_autolock(secs)`. These are core invoke
handlers — kept out of any broad `fs`/`shell` capability grant in
`capabilities/default.json`.

**Decrypt-narrowly:** `vault_decrypt_item` returns only the requested field(s) to the
WebView (e.g. just the password to copy), not the whole decrypted item, so the WebView's
exposure window is one field, not the vault.

Still bounded by doc 02 §2.4: same-user malware can read decrypted memory; the keychain
protects at rest, not against a running malicious process.

## 12.3 Auto-lock & clipboard

- **Idle auto-lock:** default 5 min idle; also lock on window blur / OS lock-screen
  (desktop) and on tab hidden (web). On lock, clear in-memory keys; re-unlock requires master
  password or passkey (doc 13).
- **Clipboard auto-clear:** copied secrets clear after ~20 s (desktop via the Tauri clipboard
  plugin; web via `navigator.clipboard` + timeout, acknowledging the web clipboard can't be
  reliably cleared if focus is lost). Prefer "type into field" (extension, §12.4) over
  clipboard for passwords where possible.

## 12.4 Browser-extension architecture

The extension is the consumer autofill surface and a prime phishing/exfiltration target. It
is also, per doc 02 §2.4, an "any code in an unlocked client" risk. Design for strict
isolation and origin binding.

### Component isolation

```
[ background service worker ]  ← holds the unlocked session (or a handle to the Tauri/native core)
        ▲   message passing (structured, validated)   ▲
        │                                              │
[ popup UI ]                                   [ content script (isolated world) ]
                                                        │  DOM-only, no key material ever
                                                   page DOM (untrusted)
```

- **Keys live only in the background service worker** (or, better, in a connected native
  core via native messaging). The **content script never receives key material** — it only
  receives the specific value to fill, and only after origin checks pass.
- Content scripts run in the **isolated world** (separate JS heap from the page) so page
  scripts can't read extension variables. They communicate with the background worker via
  validated, structured messages — never `window.postMessage` to the page.
- The popup is a normal extension page under the extension's own CSP, not injected into the
  page.

### Autofill security & phishing/origin binding

- **Origin binding:** an item autofills only when the page's origin matches the item's stored
  URL by **registrable domain (eTLD+1)**, using the Public Suffix List. A login saved for
  `example.com` does **not** fill on `example.com.evil.tld` or `evil.com`.
- **HTTPS only:** never autofill credentials on `http://` (except explicit localhost dev
  allowances the user opts into).
- **No silent fill:** autofill is user-initiated (click/keyboard), never automatic on page
  load — this defeats invisible-form and drive-by harvesting.
- **Anti-clickjacking:** refuse to fill into cross-origin iframes whose ancestor origin
  doesn't match the credential's domain; detect and refuse overlay/0-opacity tricks where
  feasible.
- **Phishing resistance via passkeys:** where a site supports WebAuthn (doc 13), passkeys are
  inherently origin-bound by the browser — preferred over password autofill for phishing
  resistance.
- **Save prompts** verify the submitting origin before offering to store a new credential, so
  a malicious page can't trick the user into saving a credential against the wrong domain.
- **No remote code:** the extension ships only bundled, reviewed code (Manifest V3, no remote
  scripts), with the same lockfile pinning / SRI discipline as the web app.

### Extension trust boundary (honest)

A compromised extension (malicious update, or a sufficiently privileged page exploit
reaching the background worker) can read what the unlocked session can decrypt — the same
fundamental limit as XSS. Mitigations narrow the surface (isolation, origin binding,
user-initiated fill); they don't make the extension a trusted computing base.

## 12.5 Mobile (`[planned]`)

- Native cores (Swift/Kotlin or a shared Rust core via UniFFI) mirror the Tauri model: keys
  in native memory, OS keystore (Keychain / Keystore) for the device key, biometric unlock as
  a fast path that releases the wrapping of the device key (not a replacement for the master
  password's role).
- Autofill via the platform credential-provider APIs (iOS AutoFill, Android Autofill
  Framework) with the same eTLD+1 origin binding and HTTPS-only rules as the extension.
- Same auto-lock and clipboard-clear policies.

## 12.6 Session invariants

- No key material is ever persisted to disk in plaintext on any client.
- The browser content script and the web WebView never hold a VK; they receive only
  specific decrypted fields on demand.
- Autofill is origin-bound (eTLD+1), HTTPS-only, and user-initiated.
- Auto-lock clears all in-memory keys; re-unlock requires master password or passkey.
