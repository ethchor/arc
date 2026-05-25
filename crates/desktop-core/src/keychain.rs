//! Device-key storage abstraction (docs/12 §12.2). The OS keychain stores ONLY the device
//! X25519 private key (and optionally a wrapped DB key) — never MK/VEK/identity plaintext.

use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug)]
pub enum KeychainError {
    NotFound,
    Backend(String),
}

pub trait DeviceKeyStore: Send + Sync {
    fn store(&self, account: &str, secret: &[u8]) -> Result<(), KeychainError>;
    fn load(&self, account: &str) -> Result<Vec<u8>, KeychainError>;
    fn delete(&self, account: &str) -> Result<(), KeychainError>;
}

/// In-memory store for tests and headless environments.
#[derive(Default)]
pub struct MemoryKeyStore {
    map: Mutex<HashMap<String, Vec<u8>>>,
}

impl DeviceKeyStore for MemoryKeyStore {
    fn store(&self, account: &str, secret: &[u8]) -> Result<(), KeychainError> {
        self.map.lock().unwrap().insert(account.to_string(), secret.to_vec());
        Ok(())
    }
    fn load(&self, account: &str) -> Result<Vec<u8>, KeychainError> {
        self.map
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .ok_or(KeychainError::NotFound)
    }
    fn delete(&self, account: &str) -> Result<(), KeychainError> {
        self.map.lock().unwrap().remove(account);
        Ok(())
    }
}

/// Real OS keychain backend (enabled with the `os-keychain` feature).
#[cfg(feature = "os-keychain")]
pub struct OsKeyStore {
    service: String,
}

#[cfg(feature = "os-keychain")]
impl OsKeyStore {
    pub fn new(service: &str) -> Self {
        Self { service: service.to_string() }
    }
    fn entry(&self, account: &str) -> Result<keyring::Entry, KeychainError> {
        keyring::Entry::new(&self.service, account).map_err(|e| KeychainError::Backend(e.to_string()))
    }
}

#[cfg(feature = "os-keychain")]
impl DeviceKeyStore for OsKeyStore {
    fn store(&self, account: &str, secret: &[u8]) -> Result<(), KeychainError> {
        self.entry(account)?
            .set_secret(secret)
            .map_err(|e| KeychainError::Backend(e.to_string()))
    }
    fn load(&self, account: &str) -> Result<Vec<u8>, KeychainError> {
        self.entry(account)?.get_secret().map_err(|_| KeychainError::NotFound)
    }
    fn delete(&self, account: &str) -> Result<(), KeychainError> {
        self.entry(account)?
            .delete_credential()
            .map_err(|e| KeychainError::Backend(e.to_string()))
    }
}
