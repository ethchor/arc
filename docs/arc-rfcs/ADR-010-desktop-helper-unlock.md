# ADR-010 — Desktop-helper unlock: browser-survivable unlock with no key at rest

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** ethchor
- **Depends on:** ADR-008 (which deferred this design), docs/12 §12.2 + §12.4, docs/02 §2.4

## Context

ADR-008 closed the "extension stays unlocked across browser restarts" question with a
rejection — *inside the browser* the only implementation is a long-lived KEK in extension
storage, and we don't ship that. It ended with an explicit pointer: if the unlocked key
moves to a **separately-running process** protected by the OS, "survives restarts" can be
revisited, and *"that is its own ADR."* This is that ADR.

The ingredients already exist:

- `apps/arc-vault-desktop` is a Tauri v2 shell over `crates/desktop-core`: an in-memory
  `Session` holding the unlocked keys in `Zeroizing` buffers with an idle auto-lock timer,
  a `DeviceKeyStore` keychain abstraction that stores **only** the device private key, and
  an SQLCipher ciphertext cache. The WebView never holds the VK — `vault_decrypt_item`
  returns single fields ("decrypt-narrowly", docs/12 §12.2).
- docs/12 §12.4 already names the better posture for the extension in passing: keys live
  in the background service worker *"(or, better, in a connected native core via native
  messaging)"* — anticipated, never designed.

What users actually asked for: restart the browser, click the arc button, and be **in** —
no master password, no biometric ceremony repeated per restart. What we refuse to give up:
**no unlocked key material at rest, anywhere, ever** (ADR-008 §2).

The resolution is that those two are compatible, because "survives a *browser* restart"
does not require surviving a *helper* or *machine* restart. A browser restart kills the
extension service worker; it does not kill an independent desktop process.

## Decisions

### 1. ACCEPT — the desktop app is the helper; the extension becomes its client

When `arc-vault-desktop` is installed and unlocked, the browser extension connects to it
and delegates **all** key operations to the desktop's Rust `Session`:

```
[ extension SW ] ⇄ stdio ⇄ [ arc-vault-nm shim ] ⇄ unix socket / named pipe ⇄ [ arc-vault-desktop ]
                 (native                              (peer-verified IPC)        desktop-core Session
                  messaging)                                                     keys in Zeroizing memory
```

- The browser spawns the **native-messaging shim** (`arc-vault-nm`, a small Rust binary
  registered via the browser's NM-host manifest). The shim holds **no keys and no state**;
  it forwards frames between browser stdio and the desktop app's local IPC endpoint. This
  indirection exists because the browser *owns* the NM host's lifetime (it dies with the
  browser) — the unlocked session must live in the process the browser does *not* own.
- "Survives browser restart" therefore means: browser restarts → new SW, new shim → shim
  reconnects to the still-running, still-unlocked desktop app → extension is unlocked
  again with **zero user interaction**. Nothing was ever written to disk.
- If the desktop app is locked, not running, or not installed, the extension falls back to
  exactly today's posture: its own in-SW crypto, passkey-first unlock (ADR-008 §3). The
  helper path is an upgrade, never a requirement.

### 2. ACCEPT — keys never enter the browser process at all (decrypt-narrowly over IPC)

The helper does **not** hand the WK / identity keys to the extension. The extension sends
requests ("decrypt this envelope", "credentials for origin X", "sign this mutation") and
receives single results — the same decrypt-narrowly contract the Tauri WebView already
lives under (docs/12 §12.2), now extended across the IPC boundary.

This makes the helper-connected extension **strictly stronger** than today's standalone
extension: today an unlocked extension keeps keys in SW memory (readable by anything that
can read browser process memory); connected, the browser holds *zero* key material and a
memory-dump of the entire browser yields ciphertext only.

Two enforcement points move (not copy — *move*) into the helper when connected:

- **Origin binding for autofill** (docs/12 §12.4): the extension states the page origin;
  the helper matches it against the item's stored URI (eTLD+1 rules) and refuses
  mismatches. A compromised renderer asking for the wrong site's password gets a refusal
  from a process it cannot reach into.
- **Rate limiting + audit**: the helper logs and rate-limits per-origin credential
  requests, giving "extension asked for 400 passwords in a minute" a tripwire that browser
  malware can't disable.

### 3. REJECT — unlocked-key persistence in the OS keychain as the implementation

The tempting shortcut — "put the identity key / WK in the OS keychain, gate it with
biometrics, done" — is rejected for the same reason ADR-008 §2 rejected extension-storage
KEKs, made worse by platform asymmetry:

- **Windows** (Credential Manager / DPAPI): any process running as the user can read the
  secret. No per-app ACL, no per-use presence gate on the basic API.
- **Linux** (Secret Service): unlocked with the login session; any same-session process
  can read it.
- **macOS** is the only mainstream desktop where a keychain item can demand per-use user
  presence (Touch ID) with Secure-Enclave-backed access control.

Shipping "unlock persistence" on that foundation silently downgrades two of three
platforms to *filesystem-read ⇒ vault*. The existing `keychain.rs` contract — device
private key only, never MK/VK/identity plaintext — **stands unchanged**. A future
*per-device, opt-in* "hardware-presence-gated at-rest unlock" on platforms with real
per-use gating (Secure Enclave; TPM + Windows Hello where it can be made per-use) is
acknowledged as possible but **deferred to its own ADR** — it changes the threat model per
platform and must not ride in on this one.

### 4. ACCEPT — pairing requires explicit approval in the desktop app; the IPC peer is verified

The local IPC endpoint is a new attack surface (docs/02 §2.4 — same-user malware). Posture:

- **Browser-side**: the NM-host manifest pins the allowed extension IDs
  (`allowed_origins`), so only the arc extension can spawn the shim. The browser verifies
  the manifest's binary path; installing the manifest is an explicit, admin-visible act.
- **Helper-side**: on macOS the desktop app verifies the connecting shim's code signature;
  on Windows, the named-pipe client PID's binary signature; on Linux, `SO_PEERCRED`
  uid-match (honest caveat: uid-level only — Linux gets the weakest peer check, and the
  pairing approval below matters most there).
- **First connect from a browser profile** is a pairing event: the desktop app raises an
  approval dialog naming the browser + profile; the extension popup shows the same short
  SAS-style code the dialog shows (reusing the device-approval SAS pattern, docs/06).
  Approved pairings persist as pairing records (an HMAC key derived per pairing — *not*
  vault key material) so re-pairing isn't needed per session.
- Every helper response carries the session's lock state; an unpaired or stale client gets
  refusals only.

### 5. ACCEPT — lock semantics are shared, and the helper's are authoritative

One lock to rule them all: when connected, the desktop `Session` is *the* session.

- Desktop locks (idle TTL, OS lock-screen/sleep/user-switch hooks, explicit lock, app
  exit) → helper pushes a `locked` event → extension drops any cached plaintext fields and
  flips to the locked UI. The existing `arc://vault-locked` Tauri event becomes the same
  signal on the IPC channel.
- Extension activity counts as activity: client requests `touch` the desktop session, so
  using autofill keeps the shared session alive exactly like typing in the desktop app.
- The helper holding keys longer (that's the point) is bounded by the same `Zeroizing` +
  auto-lock machinery `session.rs` already implements — this ADR adds OS lock-screen/sleep
  as *mandatory* lock triggers for the helper, not just idle time.

## What this means for the ADR-008 user

| Scenario | Before (ADR-008) | After (ADR-010, helper running + unlocked) |
| --- | --- | --- |
| Browser restart | 1 biometric tap (passkey) | **0 interactions** — reconnect, unlocked |
| Machine reboot | 1 biometric tap | 1 desktop unlock (password/passkey) — keys were memory-only |
| Browser memory dump | wrapped keys + (if unlocked) SW keys | **ciphertext only** — keys never in browser |
| No desktop app | works (in-SW crypto) | unchanged fallback |

"Survives machine restarts" remains impossible without keys at rest — rejected above,
permanently, unless a future hardware-gated ADR makes a per-platform case.

## Construction (implementation order, each step shippable)

1. **`desktop-core`**: an `ipc` module — localhost-free local socket (UDS /
   `\\.\pipe\arc-vault`) speaking length-prefixed JSON frames; request vocabulary mirrors
   the existing Tauri commands (`status`, `touch`, `decrypt_item`, `credentials_for_origin`,
   `sign_mutation`, `lock`); peer verification + pairing records as in §4.
2. **`arc-vault-nm`** (new tiny crate): stdio⇄socket forwarder, NM manifests + install
   recipes for Chrome/Firefox per-OS (the desktop app writes the manifests on first run —
   the standard NM-host registration dance).
3. **Extension**: a `helper.ts` transport that probes for the helper at SW startup and on
   demand; if paired+unlocked, routes `messages.ts` operations there instead of the in-SW
   crypto; locked/absent → existing path. Popup gains a "Connected to arc desktop" state
   line and the pairing-code screen.
4. **Desktop UI**: pairing-approval dialog + paired-browsers list with revoke (deleting a
   pairing record kills that browser's access instantly).

No server changes. No new cryptography — transport authentication is pairing-record HMAC +
OS peer verification; all vault crypto stays in `desktop-core` exactly as it is.

## Consequences

**Better.** The asked-for UX ("restart the browser, still unlocked") delivered with zero
at-rest exposure; the connected extension is strictly harder to extract keys from than
today's; origin binding + rate limiting move behind a process boundary browser malware
can't cross; one shared lock state instead of two drifting ones.

**Worse / accepted costs.** A long-running process holding unlocked keys is a richer
memory-scraping target than a short-lived SW — bounded by docs/02 §2.4 (same-user malware
reads memory regardless; we add mandatory sleep/lock-screen locking). The NM
manifest + shim + pairing machinery is real operational surface across three OSes ×
two browser families. Linux peer verification is honestly weaker (uid-only); pairing
approval is the compensating control there.

## Test plan

- **`desktop-core` unit:** pairing lifecycle (approve → persist → revoke → refuse);
  lock-state transitions push events to connected clients; `credentials_for_origin`
  enforces eTLD+1 binding (exact, subdomain, and refusal cases); frame parser rejects
  oversized/malformed frames; `Zeroizing` drop on lock verified under the existing
  session tests.
- **Shim integration:** spawn `arc-vault-nm` against a fake socket server; assert
  bidirectional frame fidelity + clean EOF behavior both directions (browser death,
  helper death).
- **Extension unit (vitest, existing harness):** transport probe fallback matrix —
  helper absent / present-locked / present-unlocked × each message type routes to the
  right backend; `locked` event drops cached fields.
- **Cross-process e2e (manual, docs/manual-testing):** pair Chrome, unlock desktop, kill +
  relaunch the browser, assert autofill works with zero prompts; lock desktop, assert the
  popup flips locked within a second; revoke the pairing, assert refusal.
