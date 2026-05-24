# 13 — Passkeys & WebAuthn (PRF) Unlock

Goal: let a user unlock without typing the master password, using a WebAuthn authenticator,
**without weakening zero-knowledge**. The mechanism wraps the **identity private key** (not a
vault key) with a key derived from the WebAuthn **PRF extension**, so a passkey unlock is an
alternate path to the same identity layer (doc 05), not a parallel crypto stack.

## 13.1 How PRF-based unlock works

The WebAuthn **PRF** extension lets a relying party obtain a stable, high-entropy secret from
an authenticator, bound to a specific credential and a caller-supplied salt, released only
after a successful user-verified assertion (touch/biometric/PIN).

```
enrollment of a passkey unlock:
  1. Create/register a WebAuthn credential with the prf extension enabled.
  2. Assert with prf eval salt = "arc/passkey/v1" → prfOutput (32 B, stable per credential).
  3. wrapKey_passkey = HKDF-SHA256(prfOutput, info="arc/passkey/v1").
  4. encIdentityPrivPasskey = wrap(wrapKey_passkey, identity_priv).   // new alternate wrap
     Store it server-side alongside encIdentityPriv (under WK) and encIdentityPrivRecovery.

unlock via passkey:
  1. WebAuthn assertion (user verification) → prfOutput → wrapKey_passkey.
  2. Unwrap identity_priv from encIdentityPrivPasskey. Identity layer unlocked (doc 05 §5.2).
```

The master password's WK-wrap and the recovery-key wrap remain unchanged; the passkey wrap is
**additive**. The server still stores only ciphertext and learns nothing from a passkey
unlock.

Why wrap the **identity** key (not a per-vault VEK): it ties passkey unlock into the single
identity layer, so one passkey unlock transitively unlocks every vault the user can access —
matching the recovery-key model and avoiding per-vault passkey wraps.

## 13.2 Compatibility limitations (documented honestly)

PRF is not universally available. The design must degrade gracefully:

| Limitation | Impact | Handling |
| ---------- | ------ | -------- |
| **PRF not supported** by the authenticator/browser | Cannot derive `wrapKey_passkey` | Detect at registration; if absent, **do not offer** passkey unlock; fall back to master password. Never silently weaken. |
| **PRF is per-credential** | Each passkey yields a *different* `prfOutput` | Store one `encIdentityPrivPasskey` **per registered passkey credential**. Registering a new passkey adds a wrap; it does not reuse another's. |
| **Synced passkeys** (iCloud Keychain, Google Password Manager) | The same credential — and thus the same PRF output — exists on multiple devices | Convenient (unlock on any synced device) **but** the unlock secret now lives wherever the passkey syncs; its security inherits the passkey-sync provider's. Surface this to the user; for high-assurance vaults prefer a **device-bound** authenticator. |
| **Hardware/platform variance** in PRF output stability | A non-stable output would break unwrap | Treat PRF as opaque; verify at registration by round-tripping a test wrap before relying on it. If the round-trip fails, refuse to enable passkey unlock for that credential. |
| **Conditional UI / autofill** support varies | UX inconsistency | Feature-detect; fall back to explicit passkey selection. |
| **Authenticator lost/reset** | That passkey's wrap is dead | Other unlock paths (master password, recovery key, or another registered passkey) still work; prune the dead credential's wrap. Losing the *only* passkey but retaining the master password is fine; this is exactly why passkey unlock is additive. |

## 13.3 Fallback strategy (always present)

- The **master password path is always available** as the canonical unlock; passkey unlock is
  a convenience layer on top.
- The **recovery key** remains the ultimate fallback (doc 05 §5.7).
- A user may register **multiple passkeys** (e.g. phone + security key) for redundancy; each
  gets its own identity-key wrap.
- If passkey unlock fails for any reason (PRF unavailable on this device, authenticator
  absent), the client transparently offers the master password — no dead-end.
- Disabling/removing a passkey deletes only its `encIdentityPrivPasskey`; nothing else
  rotates.

## 13.4 Passkeys as *stored items* vs as *unlock* (don't conflate)

Two different features that both involve WebAuthn:

1. **Passkey unlock** (this doc) — using an authenticator's PRF to unlock arc-vault itself.
2. **Storing/syncing the user's passkeys for third-party sites** — arc-vault acting as a
   credential provider that holds the user's site passkeys as vault items (a consumer
   password-manager feature, `[planned]`). These site passkeys are vault items encrypted
   under IK/VK like any secret; their use is origin-bound by the browser (doc 12 §12.4).

Keep the two mentally separate: (1) is about getting *into* arc-vault; (2) is about arc-vault
holding credentials *for other services*.

## 13.5 Relationship to enterprise SSO (`[future]`)

For org deployments, account *login* (sync authorization) may go through enterprise
SSO/OIDC, while vault *unlock* still uses the master password / passkey / recovery key path
described here. Login and unlock stay decoupled (doc 06 §6.1); SSO never yields a vault
decryption key.

## 13.6 Invariants

- Passkey unlock wraps the **identity private key**, additively; it never replaces the
  master-password or recovery-key wraps.
- PRF support is feature-detected and verified by a round-trip before being relied upon;
  otherwise passkey unlock is not offered.
- A master-password fallback is always reachable; passkey failure is never a dead-end.
- The server learns nothing decryptable from a passkey unlock.
