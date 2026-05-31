//! Tauri v2 shell. Thin `#[tauri::command]` wrappers over `arc-vault-desktop-core`.
//!
//! Security model (docs/12 §12.2): the VEK and device key live in the Rust session/keychain;
//! the WebView only ever sends ciphertext envelopes and receives the specific decrypted
//! field it asked for. These are core invoke handlers — no broad fs/shell capability is
//! granted (see capabilities/default.json).

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use arc_vault_crypto::{x25519_keypair, x25519_public_from_secret, EncryptedItem, Envelope};
use arc_vault_desktop_core::{open_vek_from_device, DeviceKeyStore, OsKeyStore, Session};
use tauri::State;

const KEYCHAIN_SERVICE: &str = "app.arcvault.desktop";
const DEVICE_KEY_ACCOUNT: &str = "device-x25519";
const DEFAULT_AUTOLOCK_SECS: u64 = 300;

struct AppState {
    session: Mutex<Session>,
    keystore: Box<dyn DeviceKeyStore>,
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

pub fn run() {
    let state = AppState {
        session: Mutex::new(Session::new(DEFAULT_AUTOLOCK_SECS, now())),
        keystore: Box::new(OsKeyStore::new(KEYCHAIN_SERVICE)),
    };

    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running arc-vault desktop");
}
