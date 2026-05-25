//! In-memory vault session (docs/12 §12.2). Holds unlocked key material in `Zeroizing`
//! buffers that are wiped on drop / lock, and enforces idle auto-lock. Time is passed in
//! (`now` as unix seconds) so the logic is deterministic and testable; the Tauri shell
//! supplies the real clock.

use std::collections::HashMap;

use arc_vault_crypto::{
    decrypt_item, encrypt_item, seal_open_envelope, seal_to_envelope, EncryptedItem, Envelope,
};
use zeroize::Zeroizing;

#[derive(Debug, PartialEq, Eq)]
pub enum SessionError {
    Locked,
    NoSuchVault,
    Crypto,
}

pub struct Session {
    veks: HashMap<String, (Zeroizing<[u8; 32]>, u64)>,
    identity: Option<Zeroizing<[u8; 32]>>,
    autolock_secs: u64,
    last_active: u64,
    locked: bool,
}

impl Session {
    pub fn new(autolock_secs: u64, now: u64) -> Self {
        Self {
            veks: HashMap::new(),
            identity: None,
            autolock_secs,
            last_active: now,
            locked: false,
        }
    }

    pub fn is_locked(&self, now: u64) -> bool {
        self.locked || now.saturating_sub(self.last_active) >= self.autolock_secs
    }

    pub fn touch(&mut self, now: u64) {
        if !self.locked {
            self.last_active = now;
        }
    }

    pub fn set_autolock(&mut self, secs: u64) {
        self.autolock_secs = secs;
    }

    /// Wipe all key material (the Zeroizing buffers zero on drop) and mark locked.
    pub fn lock(&mut self) {
        self.veks.clear();
        self.identity = None;
        self.locked = true;
    }

    pub fn set_identity(&mut self, identity_priv: [u8; 32], now: u64) {
        self.identity = Some(Zeroizing::new(identity_priv));
        self.locked = false;
        self.last_active = now;
    }

    pub fn add_vault_key(&mut self, vault_id: &str, vek: [u8; 32], key_version: u64, now: u64) {
        self.veks.insert(vault_id.to_string(), (Zeroizing::new(vek), key_version));
        self.locked = false;
        self.last_active = now;
    }

    fn vek(&self, vault_id: &str, now: u64) -> Result<(&[u8; 32], u64), SessionError> {
        if self.is_locked(now) {
            return Err(SessionError::Locked);
        }
        let (vek, kv) = self.veks.get(vault_id).ok_or(SessionError::NoSuchVault)?;
        let key: &[u8; 32] = vek;
        Ok((key, *kv))
    }

    pub fn encrypt_item(
        &self,
        vault_id: &str,
        item_id: &str,
        version: u64,
        now: u64,
        plaintext: &[u8],
    ) -> Result<EncryptedItem, SessionError> {
        let (vek, kv) = self.vek(vault_id, now)?;
        Ok(encrypt_item(vek, vault_id, item_id, version, kv, plaintext))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn decrypt_item(
        &self,
        vault_id: &str,
        item_id: &str,
        version: u64,
        key_version: u64,
        now: u64,
        ciphertext: &Envelope,
        wrapped_item_key: &Envelope,
    ) -> Result<Vec<u8>, SessionError> {
        let (vek, _) = self.vek(vault_id, now)?;
        decrypt_item(vek, vault_id, item_id, version, key_version, ciphertext, wrapped_item_key)
            .map_err(|_| SessionError::Crypto)
    }

    /// Wrap a vault's VEK to a new device's public key for approval transfer (docs/06 §6.3).
    pub fn wrap_vek_for_device(
        &self,
        vault_id: &str,
        device_pub: &[u8; 32],
        now: u64,
    ) -> Result<Envelope, SessionError> {
        let (vek, _) = self.vek(vault_id, now)?;
        Ok(seal_to_envelope(device_pub, vek))
    }
}

/// Open a device-targeted VEK grant with this device's private key.
pub fn open_vek_from_device(
    device_priv: &[u8; 32],
    device_pub: &[u8; 32],
    env: &Envelope,
) -> Result<[u8; 32], SessionError> {
    let v = seal_open_envelope(device_priv, device_pub, env).map_err(|_| SessionError::Crypto)?;
    v.try_into().map_err(|_| SessionError::Crypto)
}
