# arc-vault desktop (Tauri v2)

The desktop client. It is a **thin Tauri shell** over two webkit-free, fully-tested Rust
crates:

- [`crates/vault-crypto-rs`](../../crates/vault-crypto-rs) — the crypto core (byte-compatible
  with `packages/vault-crypto`; see its parity tests).
- [`crates/desktop-core`](../../crates/desktop-core) — the runtime: in-memory `Session`
  with idle auto-lock and `Zeroizing` key buffers, the device `keychain` abstraction, and
  the encrypted local `store` (SQLite cache of ciphertext envelopes).

`src-tauri/src/lib.rs` exposes these as `#[tauri::command]`s. The security model (docs/12
§12.2): the VEK and device private key stay in the Rust process; the WebView only ever
sends ciphertext envelopes and gets back the single decrypted field it requested
(`vault_decrypt_item`). The commands are core invoke handlers — `capabilities/default.json`
grants no broad fs/shell/http permissions.

## Commands

`vault_device_keypair`, `vault_load_grant`, `vault_encrypt_item`, `vault_decrypt_item`,
`vault_wrap_vek_for_device`, `vault_lock`, `vault_is_locked`, `vault_touch`,
`vault_set_autolock`.

## Building

This shell links GUI system libraries and is **not built in CI** (the logic it wraps is
tested in `crates/desktop-core`). To build locally you need the Tauri v2 prerequisites:

- Linux: `webkit2gtk-4.1`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
  plus a C toolchain (for the bundled SQLite / SQLCipher).
- macOS/Windows: the standard Tauri v2 toolchain.

```bash
# from apps/desktop
pnpm dlx @tauri-apps/cli@^2 dev      # dev: runs `web dev` (http://localhost:3000)
pnpm dlx @tauri-apps/cli@^2 build    # prod: runs `web build:desktop` -> ../../web/out
```

The frontend is wired in `tauri.conf.json`:

- `beforeDevCommand` → `pnpm --filter @arc-vault/web dev`, loaded from `devUrl`.
- `beforeBuildCommand` → `pnpm --filter @arc-vault/web build:desktop`, which runs Next.js
  with `NEXT_OUTPUT=export` to emit the static `apps/web/out` that `frontendDist` points at.
  In export mode the web app serves no response headers; the desktop CSP comes from
  `tauri.conf.json` `app.security.csp`.

Bundling also needs app icons — generate them once with
`pnpm dlx @tauri-apps/cli@^2 icon path/to/icon.png`.

## At-rest encryption

The local cache stores only ciphertext envelopes, so plain SQLite already preserves
zero-knowledge at rest. For defense-in-depth, build `desktop-core` with the SQLCipher
variant of `rusqlite` and wrap the DB key under the keychain device key.
