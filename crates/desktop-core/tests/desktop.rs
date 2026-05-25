use arc_vault_crypto::{random32, x25519_keypair};
use arc_vault_desktop_core::{open_vek_from_device, CachedItem, CipherCache, DeviceKeyStore, MemoryKeyStore, Session};

#[test]
fn session_encrypts_decrypts_and_auto_locks() {
    let mut s = Session::new(300, 1000);
    let vek = random32();
    s.add_vault_key("v1", vek, 1, 1000);

    let enc = s.encrypt_item("v1", "i1", 1, 1000, b"top-secret").unwrap();
    let pt = s
        .decrypt_item("v1", "i1", 1, 1, 1000, &enc.ciphertext, &enc.wrapped_item_key)
        .unwrap();
    assert_eq!(pt, b"top-secret");

    assert!(!s.is_locked(1000));
    assert!(!s.is_locked(1299));
    assert!(s.is_locked(1300)); // idle past autolock window

    // a session past its auto-lock refuses crypto
    let mut s2 = Session::new(10, 0);
    s2.add_vault_key("v1", vek, 1, 0);
    assert!(s2.encrypt_item("v1", "i1", 1, 100, b"x").is_err());
}

#[test]
fn explicit_lock_wipes_keys() {
    let mut s = Session::new(300, 0);
    s.add_vault_key("v1", random32(), 1, 0);
    s.lock();
    assert!(s.encrypt_item("v1", "i1", 1, 0, b"x").is_err());
    assert!(s.is_locked(0));
}

#[test]
fn device_vek_transfer_round_trips() {
    let mut s = Session::new(300, 0);
    let vek = random32();
    s.add_vault_key("v1", vek, 1, 0);
    let (device_priv, device_pub) = x25519_keypair();
    let grant = s.wrap_vek_for_device("v1", &device_pub, 0).unwrap();
    assert_eq!(open_vek_from_device(&device_priv, &device_pub, &grant).unwrap(), vek);
}

#[test]
fn cipher_cache_round_trips_and_decrypts() {
    let mut s = Session::new(300, 0);
    let vek = random32();
    s.add_vault_key("v1", vek, 1, 0);
    let enc = s.encrypt_item("v1", "i1", 1, 0, b"cached-secret").unwrap();

    let cache = CipherCache::open_in_memory().unwrap();
    cache
        .upsert(
            "v1",
            &CachedItem {
                item_id: "i1".into(),
                ciphertext: enc.ciphertext.clone(),
                wrapped_item_key: enc.wrapped_item_key.clone(),
                version: 1,
                key_version: 1,
                seq: 1,
            },
        )
        .unwrap();

    assert_eq!(cache.max_seq("v1").unwrap(), 1);
    let got = cache.get("v1", "i1").unwrap().unwrap();
    let pt = s
        .decrypt_item("v1", "i1", 1, 1, 0, &got.ciphertext, &got.wrapped_item_key)
        .unwrap();
    assert_eq!(pt, b"cached-secret");
    assert_eq!(cache.list("v1").unwrap().len(), 1);
}

#[test]
fn memory_keystore_round_trips() {
    let ks = MemoryKeyStore::default();
    ks.store("device-priv", b"the-device-key").unwrap();
    assert_eq!(ks.load("device-priv").unwrap(), b"the-device-key");
    ks.delete("device-priv").unwrap();
    assert!(ks.load("device-priv").is_err());
}
