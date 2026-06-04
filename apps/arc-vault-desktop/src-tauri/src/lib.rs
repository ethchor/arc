//! Tauri v2 shell. Thin `#[tauri::command]` wrappers over `arc-vault-desktop-core`.
//!
//! Security model (docs/12 §12.2): the VEK and device key live in the Rust session/keychain;
//! the WebView only ever sends ciphertext envelopes and receives the specific decrypted
//! field it asked for. These are core invoke handlers — no broad fs/shell capability is
//! granted (see capabilities/default.json).

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use arc_vault_crypto::{x25519_keypair, x25519_public_from_secret, EncryptedItem, Envelope};
use arc_vault_desktop_core::{
    open_vek_from_device, CachedItem, CipherCache, DeviceKeyStore, OsKeyStore, Session,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const KEYCHAIN_SERVICE: &str = "app.arcvault.desktop";
const DEVICE_KEY_ACCOUNT: &str = "device-x25519";
const DEFAULT_AUTOLOCK_SECS: u64 = 300;
/// How often the background tick runs the lock check. 1s keeps the "vault-locked" event
/// snappy without blowing the budget; the underlying check is just a timestamp compare.
const LOCK_TICK: Duration = Duration::from_secs(1);
/// Event name the shell emits when the session transitions from unlocked → locked.
const EVT_LOCKED: &str = "arc://vault-locked";

pub struct AppState {
    session: Arc<Mutex<Session>>,
    keystore: Box<dyn DeviceKeyStore + Send + Sync>,
    /// Lazily opened on first cache_* command (web app picks the path).
    cache: Mutex<Option<CipherCache>>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn from_hex32(s: &str) -> Result<[u8; 32], String> {
    hex::decode(s)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "expected 32 bytes".to_string())
}

#[tauri::command]
fn vault_set_autolock(secs: u64, state: State<AppState>) {
    state.session.lock().unwrap().set_autolock(secs);
}

#[tauri::command]
fn vault_lock(state: State<AppState>) {
    state.session.lock().unwrap().lock();
}

#[tauri::command]
fn vault_is_locked(state: State<AppState>) -> bool {
    state.session.lock().unwrap().is_locked(now())
}

#[tauri::command]
fn vault_touch(state: State<AppState>) {
    state.session.lock().unwrap().touch(now());
}

/// Generate this device's X25519 keypair, store the private key in the OS keychain, and
/// return the public key (hex) to register with the server (docs/06 §6.3).
#[tauri::command]
fn vault_device_keypair(state: State<AppState>) -> Result<String, String> {
    let (priv_key, pub_key) = x25519_keypair();
    state.keystore.store(DEVICE_KEY_ACCOUNT, &priv_key).map_err(|e| format!("{e:?}"))?;
    Ok(hex::encode(pub_key))
}

/// Open a device-targeted VEK grant with the keychain device key and load it into the
/// session. The VEK never crosses to the WebView.
#[tauri::command]
fn vault_load_grant(
    vault_id: String,
    key_version: u64,
    grant: Envelope,
    state: State<AppState>,
) -> Result<(), String> {
    let priv_vec = state.keystore.load(DEVICE_KEY_ACCOUNT).map_err(|e| format!("{e:?}"))?;
    let device_priv: [u8; 32] = priv_vec.try_into().map_err(|_| "bad device key".to_string())?;
    let device_pub = x25519_public_from_secret(&device_priv);
    let vek = open_vek_from_device(&device_priv, &device_pub, &grant).map_err(|e| format!("{e:?}"))?;
    state.session.lock().unwrap().add_vault_key(&vault_id, vek, key_version, now());
    Ok(())
}

#[tauri::command]
fn vault_encrypt_item(
    vault_id: String,
    item_id: String,
    version: u64,
    plaintext: String,
    state: State<AppState>,
) -> Result<EncryptedItem, String> {
    state
        .session
        .lock()
        .unwrap()
        .encrypt_item(&vault_id, &item_id, version, now(), plaintext.as_bytes())
        .map_err(|e| format!("{e:?}"))
}

/// Decrypt narrowly: returns only the requested item's plaintext, not the VEK.
#[tauri::command]
fn vault_decrypt_item(
    vault_id: String,
    item_id: String,
    version: u64,
    key_version: u64,
    ciphertext: Envelope,
    wrapped_item_key: Envelope,
    state: State<AppState>,
) -> Result<String, String> {
    let pt = state
        .session
        .lock()
        .unwrap()
        .decrypt_item(&vault_id, &item_id, version, key_version, now(), &ciphertext, &wrapped_item_key)
        .map_err(|e| format!("{e:?}"))?;
    String::from_utf8(pt).map_err(|_| "non-utf8 plaintext".to_string())
}

/// Wrap a vault's VEK to a new device's public key (device-approval transfer).
#[tauri::command]
fn vault_wrap_vek_for_device(
    vault_id: String,
    device_pub_hex: String,
    state: State<AppState>,
) -> Result<Envelope, String> {
    let device_pub = from_hex32(&device_pub_hex)?;
    state
        .session
        .lock()
        .unwrap()
        .wrap_vek_for_device(&vault_id, &device_pub, now())
        .map_err(|e| format!("{e:?}"))
}

// --- CipherCache commands (docs/12 §12.2) -------------------------------------------------
//
// The cache stores server-supplied ciphertext envelopes ONLY — never plaintext. Even with
// plain rusqlite this preserves zero-knowledge at rest; production builds swap to
// `bundled-sqlcipher` for file-level encryption (file encryption key wrapped under the
// keychain device key). Commands are gated on the cache being opened first via
// `cache_open` so multiple windows can share the same file path.

#[derive(Deserialize, Serialize)]
pub struct CachedItemDto {
    pub item_id: String,
    pub ciphertext: Envelope,
    pub wrapped_item_key: Envelope,
    pub version: i64,
    pub key_version: i64,
    pub seq: i64,
}

impl From<CachedItem> for CachedItemDto {
    fn from(c: CachedItem) -> Self {
        Self {
            item_id: c.item_id,
            ciphertext: c.ciphertext,
            wrapped_item_key: c.wrapped_item_key,
            version: c.version,
            key_version: c.key_version,
            seq: c.seq,
        }
    }
}

impl From<CachedItemDto> for CachedItem {
    fn from(d: CachedItemDto) -> Self {
        Self {
            item_id: d.item_id,
            ciphertext: d.ciphertext,
            wrapped_item_key: d.wrapped_item_key,
            version: d.version,
            key_version: d.key_version,
            seq: d.seq,
        }
    }
}

/// Open (or reopen) the local ciphertext cache file. Pass `":memory:"` for a transient
/// cache, useful for tests + first-run "what does the offline mode look like" demos.
#[tauri::command]
fn cache_open(path: String, state: State<AppState>) -> Result<(), String> {
    let cache = if path == ":memory:" {
        CipherCache::open_in_memory()
    } else {
        CipherCache::open(&path)
    }
    .map_err(|e| format!("{e}"))?;
    *state.cache.lock().unwrap() = Some(cache);
    Ok(())
}

#[tauri::command]
fn cache_upsert(vault_id: String, item: CachedItemDto, state: State<AppState>) -> Result<(), String> {
    with_cache(&state, |c| c.upsert(&vault_id, &item.into()).map_err(|e| format!("{e}")))
}

#[tauri::command]
fn cache_get(
    vault_id: String,
    item_id: String,
    state: State<AppState>,
) -> Result<Option<CachedItemDto>, String> {
    with_cache(&state, |c| {
        c.get(&vault_id, &item_id).map(|opt| opt.map(Into::into)).map_err(|e| format!("{e}"))
    })
}

#[tauri::command]
fn cache_list(vault_id: String, state: State<AppState>) -> Result<Vec<CachedItemDto>, String> {
    with_cache(&state, |c| {
        c.list(&vault_id)
            .map(|items| items.into_iter().map(Into::into).collect())
            .map_err(|e| format!("{e}"))
    })
}

fn with_cache<T>(
    state: &State<AppState>,
    f: impl FnOnce(&CipherCache) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state.cache.lock().unwrap();
    let cache = guard.as_ref().ok_or_else(|| "cache not opened".to_string())?;
    f(cache)
}

// --- Auto-lock background tick ------------------------------------------------------------

/// Spawn a background thread that polls `is_locked()` every {@link LOCK_TICK} and emits
/// {@link EVT_LOCKED} to the WebView when the session transitions from unlocked → locked.
/// The web app listens for this event to drop in-memory keys + bounce to the unlock screen
/// without polling Rust on every input.
fn spawn_lock_watcher(session: Arc<Mutex<Session>>, app: AppHandle) {
    thread::spawn(move || {
        let mut last_locked = session.lock().unwrap().is_locked(now());
        loop {
            thread::sleep(LOCK_TICK);
            let locked = session.lock().unwrap().is_locked(now());
            if locked && !last_locked {
                // Best-effort emit — if no window is open yet the event is dropped, which
                // is fine because the WebView re-syncs state when it loads.
                let _ = app.emit(EVT_LOCKED, ());
            }
            last_locked = locked;
        }
    });
}

pub fn run() {
    let session = Arc::new(Mutex::new(Session::new(DEFAULT_AUTOLOCK_SECS, now())));
    let state = AppState {
        session: session.clone(),
        keystore: Box::new(OsKeyStore::new(KEYCHAIN_SERVICE)),
        cache: Mutex::new(None),
    };

    tauri::Builder::default()
        .setup(move |app| {
            spawn_lock_watcher(session.clone(), app.handle().clone());
            Ok(())
        })
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            vault_set_autolock,
            vault_lock,
            vault_is_locked,
            vault_touch,
            vault_device_keypair,
            vault_load_grant,
            vault_encrypt_item,
            vault_decrypt_item,
            vault_wrap_vek_for_device,
            cache_open,
            cache_upsert,
            cache_get,
            cache_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running arc-vault desktop");
}
