# ADR-008 — Passkey residency + the call on extension unlock that "survives browser restarts"

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** ethchor
- **Depends on:** docs/13 (passkeys + WebAuthn PRF unlock), docs/12 (extension)

## Context

The last open product question in `STATUS.md` was *"hardware-key (FIDO2 resident credential)
as a primary unlock path on the extension. Different from passkey-prf; would let the
extension run unlocked across browser restarts."*

The framing glues two ideas together:

1. **Resident (discoverable) credentials** — passkeys stored *on the authenticator* with a
   user handle, so the extension can offer **username-less** unlock (no email typed).
2. **Survives browser restarts** — the extension comes back already-unlocked (or unlock is
   one silent step after a restart).

Idea (1) is a real UX win that costs nothing. Idea (2), under the model arc already chose,
can only be honestly delivered by **caching a long-lived KEK in extension storage** — which
walks back the zero-knowledge posture we built everything else on. This ADR makes both
calls explicitly so they don't get re-asked.

## Decisions

### 1. ACCEPT — passkey registration is `residentKey: "required"` (discoverable)

Passkeys are registered with `residentKey: "required"` (currently `"preferred"`) and the
existing `userID = encode(String(userId))` becomes the discoverable user handle. The
unlock screen on every surface (web, extension) gains a **username-less unlock** path:
the user clicks *Unlock with passkey* and the authenticator picks the right credential —
no email field needed.

Cryptographic effect: **none.** Residency is a property of where the credential is *stored*,
not what it derives. PRF unwrap still requires a fresh user-activation gesture (a tap on
the authenticator); the wrap key is still derived live per unlock and never cached. The
server change is one option flag.

### 2. REJECT — caching a long-lived KEK in extension storage

The "survives browser restarts" reading of the proposal can only be satisfied two ways:

- **Silent re-derivation on launch.** WebAuthn requires a user-activation gesture for PRF
  derivation; the platform won't let you. *Not on the table.*
- **Cache a KEK locally and re-use it on restart.** Stores a key alongside the wrapped
  envelopes; an attacker with read access to the user's profile directory has the vault.
  *That's the Bitwarden "PIN unlock" / "biometric unlock" trade-off, and we don't ship it.*

Today, an attacker with filesystem read on the user's profile dir has the *wrapped* keys
but no KEK; they need to phish the master password or capture a passkey assertion. We are
not going to be the first surface in arc that downgrades that property. **No long-lived
KEK / wrapped master key / unlocked WK lives on disk or in `chrome.storage.local` / IndexedDB
in the extension or anywhere else.**

The in-flight unlocked work key + identity privs stay where they are: **MV3 service-worker
memory only**, cleared when the worker dies (browser restart, idle eviction, explicit lock,
auto-lock TTL). That's the existing posture and it is the posture, period.

### 3. ACCEPT — make passkey-PRF the prominent default on the extension unlock screen

The honest friction users feel after a browser restart isn't "I have to tap my passkey"
(one biometric gesture). It's *"the unlock screen makes me type my master password again."*
The extension popup makes **passkey unlock the top-most action**, with master password
collapsed behind a *Use master password instead* toggle. The default path is exactly **one
biometric tap → vault unlocked**, same security as today.

Combined with decision (1), a first-time launch on a new browser is also email-less.

## What this means for the recipient of "survives browser restarts"

The user who wants the extension to stay unlocked across browser restarts now has a path:
**one tap → unlocked**. They don't need to type anything. The vault is not unlocked *until
they tap*, and the tap is required by WebAuthn — there is no design where it isn't. If a
future product hops the trust boundary into a separately-running process (e.g. a Tauri-
wrapped extension that keeps the WK in a desktop helper protected by the OS keychain),
that's where "survives restarts" can be revisited — with a **separate process** holding
the key, not the extension service worker. That is its own ADR.

## Construction

- **Server**: flip `residentKey: "preferred"` → `"required"` in
  `PasskeyService.beginRegistration`. New endpoints:
  - `POST /vault/passkey/discover-challenge` — issues an unbound challenge (no userId
    parameter) tracked by challenge value with a short TTL.
  - `POST /vault/passkey/discover-unlock` — verifies the assertion, resolves the user from
    the asserted credential id + the embedded `userHandle`, returns the same wrap
    envelopes as the per-user `finishUnlock` **plus** an `accessToken` (the passkey assertion
    is itself proof of account control — equivalent to OAuth login for that user).
- **SDK**: `unlockWithDiscoverablePasskey(authenticator)` runs the flow and leaves the
  client both *signed in* (`accessToken` set) and *unlocked* (identity key in memory).
- **Extension popup**: passkey-first UI — primary button *Unlock with passkey*; secondary
  *Use master password instead* reveals the legacy form. No email field on the primary path.

No new crypto. Residency is a flag; discoverable unlock reuses the existing
`verifyAuthenticationResponse` + PRF-unwrap pipeline.

## Migration

- Existing passkeys registered with `residentKey: "preferred"` already became resident on
  any compliant authenticator (the modal preference is honored when the authenticator
  supports it). They keep working unchanged — the change only tightens *future*
  registrations.
- Users with **no** passkey registered fall back to the master-password path as before; the
  primary-button shift is purely UX.

## Consequences

**Better.** Username-less first-time unlock on every surface. Extension restart UX is one
biometric tap. The "survives restarts" question is closed: documented "no, for these
reasons," with a clear path for a future desktop-helper-backed design if the trade ever
makes sense.

**No worse.** Zero-knowledge posture intact. No KEK on disk. The master-password path is
still available behind a toggle for users without a passkey or whose authenticator is
unavailable.

## Test plan

- **Server unit:** `beginRegistration` emits `authenticatorSelection.residentKey
  === "required"`. `discover-challenge` returns a challenge with no `allowCredentials`.
  `discover-unlock` resolves the user from `userHandle`, verifies the assertion, returns
  wrap envelopes + an accessToken; rejects an assertion whose challenge wasn't issued by us;
  rejects an unknown credential id.
- **e2e (`@arc/server`):** the existing `passkey.e2e-spec`'s `FakeAuthenticator` is extended
  to assert with a `userHandle`. A fresh client with **no email** issues
  `discover-challenge` → signs → `discover-unlock` and receives a usable token + the
  identity wraps. The legacy `unlock-challenge` / `unlock` path keeps working byte-for-byte.
