# 03 — Passkey unlock

> **Set `ARC_ENABLE_DEV_LOGIN=true` once in your shell** — every `devLogin()` call
> below depends on the MED-C opt-in.

The server flow + SDK are shipped end-to-end (real WebAuthn verification via
`@simplewebauthn/server`, real ES256 signatures, anti-clone counter check). The web UI
button is the next commit; until then, the SDK is the way to exercise the live path
manually.

## What's covered today

- Server: `/vault/passkey/{register-challenge,register,unlock-challenge,unlock}` + list /
  delete. Per-user PRF salt persisted (so register + unlock derive the same wrap key).
- SDK: `client.registerPasskey(authenticator, label?)`, `client.unlockWithPasskey(authenticator)`,
  `client.listPasskeys()`, `client.removePasskey(id)`.
- Crypto: `wrapIdentityForPasskey` / `wrapIdentityMlkemForPasskey` / `wrapSigningForPasskey`
  + their unwrap siblings. Each uses its own AAD label, so the ciphertexts can't be
  cross-confused.

## What's pending

- Web UI button on the unlock screen and a settings panel for register/list/remove.
  Tracked under "Phase 2 — Passkey unlock" in `docs/STATUS.md`.

## A. Run the live SDK flow against the real server

A small Node script proves the full register → unlock → re-write cycle works against
the running server, using a software authenticator that produces real ES256 signatures.

```bash
# Terminal A: server already running (see 01-bootstrap.md)
# Terminal B:
cat > /tmp/passkey-smoke.mjs <<'EOF'
import { VaultClient } from "@arc/sdk";
import { createHash, createSign, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";

// --- minimal fake authenticator (real ES256 signatures, HKDF-derived PRF) -----
function makeAuthenticator() {
  const credentialId = randomBytes(32);
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = kp.publicKey.export({ type: "spki", format: "der" });
  const pubRaw = spki.subarray(spki.length - 65);
  const prfSecret = randomBytes(32);
  let signCount = 0;
  const RP = "localhost"; const ORIGIN = "http://localhost:5173";
  const prf = (salt) => new Uint8Array(hkdfSync("sha256", prfSecret, salt, "prf", 32));
  const b64u = (b) => Buffer.from(b).toString("base64url");
  /* … (CBOR helpers + create / get implementations, ~120 lines)
     The complete file lives in
     apps/arc-server/test/sdk-passkey.e2e-spec.ts — copy the makeAuthenticator() function
     verbatim. */
  // ...
}

const url = "http://localhost:3001";
const authn = makeAuthenticator();
const A = new VaultClient({ baseUrl: url, profile: "test" });
await A.devLogin("passkey-manual@example.com");
await A.enroll("master-pw");
console.log("registered:", await A.registerPasskey(authn, "Manual smoke"));
console.log("list:", await A.listPasskeys());

const B = new VaultClient({ baseUrl: url, profile: "test" });
await B.devLogin("passkey-manual@example.com");
await B.unlockWithPasskey(authn);
console.log("vaults visible via passkey unlock:", await B.listVaults());
EOF
node --experimental-vm-modules /tmp/passkey-smoke.mjs
```

(The full `makeAuthenticator()` is in
`apps/arc-server/test/sdk-passkey.e2e-spec.ts` — the snippet above is the boundary that
the real flow goes through.)

Expected output:

- `registered: { credentialId: '<base64url>' }`
- `list: [ { id: '...', credentialId: '...', label: 'Manual smoke', createdAt: '...' } ]`
- `vaults visible via passkey unlock: [ ... ]` — same vaults as the master-password
  session sees. Anything write-capable (signing key) works too because all three privs
  are wrapped.

## B. Anti-clone check

In the same script: call `unlockWithPasskey` twice — the second call still succeeds
(authenticator's counter increments). Now tamper with the fake authenticator's
`signCount` to rewind it (e.g. `signCount = 0` before the second `get()`) and call
`unlockWithPasskey` again. The server returns **401** ("passkey counter regression
(possible clone)").

`apps/arc-server/test/passkey.e2e-spec.ts` automates this exact case.

## C. Web UI (when shipped)

Once the UI lands, the manual flow will be:

1. Unlock vault with master password.
2. Open **Settings** → **Passkeys** → **Add a passkey**.
3. OS prompts for biometric (Touch ID / Windows Hello / a roaming key).
4. Set a label (e.g. "MacBook Touch ID"). Save.
5. Sign out → on the unlock screen, click **Use a passkey**.
6. OS prompts again → unlocks.

> **Browser support.** Passkey unlock needs WebAuthn PRF. Chrome 116+ and Safari 17+
> ship it; Firefox is still pending. Test in Chrome on macOS for the most reliable
> result.

## D. Cleanup

```bash
# remove the credential
node -e "
import('@arc/sdk').then(async ({ VaultClient }) => {
  const A = new VaultClient({ baseUrl: 'http://localhost:3001', profile: 'test' });
  await A.devLogin('passkey-manual@example.com');
  await A.unlock('master-pw');
  for (const p of await A.listPasskeys()) await A.removePasskey(p.id);
  console.log('all passkeys removed');
});
"
```

## E. Security invariants worth observing

- The server never sees the PRF output. Watch the Pino logs in Terminal A across
  register + unlock — only opaque envelopes are logged, never plaintext.
- The server never sees the master key. Passkey unlock is **additive** to master
  password — it doesn't replace it.
- Each credential gets its own envelope. Removing one passkey doesn't invalidate
  the others (and doesn't touch the underlying identity).
- AAD labels (`identity-priv`, `identity-priv-mlkem`, `signing-priv`, each with
  `"passkey"` suffix) prevent any cross-target confusion — `arc-crypto`'s
  vault.test.ts has a test that proves swapping AAD throws.
