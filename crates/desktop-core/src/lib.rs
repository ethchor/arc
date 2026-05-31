//! Webkit-free desktop runtime for arc-vault. The Tauri shell in `apps/arc-vault-desktop/src-tauri`
//! is a thin wrapper that exposes these as `#[tauri::command]`s; all real logic lives here
//! so it compiles and is tested without GUI system dependencies.

pub mod keychain;
pub mod session;
pub mod store;

pub use keychain::{DeviceKeyStore, KeychainError, MemoryKeyStore};
pub use session::{open_vek_from_device, Session, SessionError};
pub use store::{CachedItem, CipherCache};

#[cfg(feature = "os-keychain")]
pub use keychain::OsKeyStore;
