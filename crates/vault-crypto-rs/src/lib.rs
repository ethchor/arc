//! Rust core of the arc-vault zero-knowledge crypto protocol.
//!
//! This mirrors `packages/vault-crypto` (TypeScript) byte-for-byte: same Argon2id params,
//! same HKDF branch labels, same length-prefixed AAD, same RFC 8785 / I-JSON canonical
//! serialization, same XChaCha20-Poly1305 AEAD, and the same anonymous sealed box
//! (X25519 + HKDF-SHA256 + XChaCha20-Poly1305). Parity is enforced by `tests/parity.rs`,
//! which loads the shared `vectors/kat.json` produced by the TS core (docs/15 §15.1).

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde_json::Value;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

/// MK = Argon2id(password, salt). `m` is memory cost in KiB.
pub fn argon2id(password: &[u8], salt: &[u8], m: u32, t: u32, p: u32, out_len: usize) -> Vec<u8> {
    let params = Params::new(m, t, p, Some(out_len)).expect("valid argon2 params");
    let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = vec![0u8; out_len];
    a2.hash_password_into(password, salt, &mut out).expect("argon2 hash");
    out
}

pub struct Split {
    pub auth_seed: [u8; 32],
    pub wk: [u8; 32],
}

/// Split MK into the auth seed and wrapping key via two HKDF branches (empty salt, to
/// match the TS core's empty-salt HKDF — both reduce to a 64-byte zero HMAC key block).
pub fn split_master_key(mk: &[u8]) -> Split {
    let hk = Hkdf::<Sha256>::new(Some(b""), mk);
    let mut auth_seed = [0u8; 32];
    hk.expand(b"arc/auth/v1", &mut auth_seed).unwrap();
    let mut wk = [0u8; 32];
    hk.expand(b"arc/wrap/v1", &mut wk).unwrap();
    Split { auth_seed, wk }
}

/// Canonical, length-prefixed AAD string (docs/04 §4.3).
pub fn build_aad(fields: &[(&str, &str)]) -> String {
    let mut s = String::from("arc-aad/1");
    for (name, value) in fields {
        s.push('\n');
        s.push_str(name);
        s.push(':');
        s.push_str(&value.as_bytes().len().to_string());
        s.push(':');
        s.push_str(value);
    }
    s
}

pub fn aead_encrypt(key: &[u8; 32], nonce: &[u8; 24], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plaintext, aad })
        .expect("aead encrypt")
}

pub fn aead_decrypt(
    key: &[u8; 32],
    nonce: &[u8; 24],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, ()> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ciphertext, aad })
        .map_err(|_| ())
}

pub fn ed25519_sign(priv32: &[u8; 32], msg: &[u8]) -> [u8; 64] {
    SigningKey::from_bytes(priv32).sign(msg).to_bytes()
}

pub fn ed25519_public(priv32: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(priv32).verifying_key().to_bytes()
}

pub fn ed25519_verify(pub32: &[u8; 32], msg: &[u8], sig64: &[u8; 64]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(pub32) else {
        return false;
    };
    vk.verify(msg, &Signature::from_bytes(sig64)).is_ok()
}

/// RFC 8785 / I-JSON canonical serialization (docs/04 §4.5). Integers only; object keys
/// sorted by UTF-16 code units to match the TS core's default string sort.
pub fn jcs(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                n.to_string()
            } else {
                panic!("jcs: only integer numbers are permitted (I-JSON)")
            }
        }
        Value::String(s) => serde_json::to_string(s).unwrap(),
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().map(jcs).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", serde_json::to_string(k).unwrap(), jcs(&map[*k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

// --- anonymous sealed box (X25519 + HKDF-SHA256 + XChaCha20-Poly1305) ---

fn seal_key(shared: &[u8; 32], eph_pub: &[u8; 32], recipient_pub: &[u8; 32]) -> [u8; 32] {
    let mut salt = Vec::with_capacity(64);
    salt.extend_from_slice(eph_pub);
    salt.extend_from_slice(recipient_pub);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut key = [0u8; 32];
    hk.expand(b"arc/seal/v1", &mut key).unwrap();
    key
}

pub fn x25519_keypair() -> ([u8; 32], [u8; 32]) {
    let sk = StaticSecret::random_from_rng(OsRng);
    let pk = PublicKey::from(&sk);
    (sk.to_bytes(), pk.to_bytes())
}

pub fn x25519_public_from_secret(secret: &[u8; 32]) -> [u8; 32] {
    PublicKey::from(&StaticSecret::from(*secret)).to_bytes()
}

pub struct Sealed {
    pub eph_pub: [u8; 32],
    pub nonce: [u8; 24],
    pub ct: Vec<u8>,
}

pub fn seal(recipient_pub: &[u8; 32], plaintext: &[u8]) -> Sealed {
    let eph = StaticSecret::random_from_rng(OsRng);
    let eph_pub = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient_pub));
    let key = seal_key(shared.as_bytes(), eph_pub.as_bytes(), recipient_pub);
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = aead_encrypt(&key, &nonce, plaintext, b"");
    Sealed { eph_pub: eph_pub.to_bytes(), nonce, ct }
}

pub fn seal_open(
    recipient_priv: &[u8; 32],
    recipient_pub: &[u8; 32],
    eph_pub: &[u8; 32],
    nonce: &[u8; 24],
    ct: &[u8],
) -> Result<Vec<u8>, ()> {
    let sk = StaticSecret::from(*recipient_priv);
    let shared = sk.diffie_hellman(&PublicKey::from(*eph_pub));
    let key = seal_key(shared.as_bytes(), eph_pub, recipient_pub);
    aead_decrypt(&key, nonce, ct, b"")
}

// --- versioned envelope (mirrors packages/vault-crypto/src/envelope.ts) ---

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

fn b64u_encode(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}
fn b64u_decode(s: &str) -> Result<Vec<u8>, ()> {
    URL_SAFE_NO_PAD.decode(s).map_err(|_| ())
}

pub fn random32() -> [u8; 32] {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b
}

const BUCKETS: [usize; 7] = [64, 256, 1024, 4096, 16384, 65536, 262144];
fn pad_target(len: usize) -> usize {
    for b in BUCKETS {
        if len <= b {
            return b;
        }
    }
    len.div_ceil(262144) * 262144
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Envelope {
    pub v: u32,
    pub alg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kdf: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kv: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aad: Option<String>,
    pub n: String,
    pub ct: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ep: Option<String>,
    #[serde(default)]
    pub pad: u32,
}

pub fn aead_seal_envelope(
    key: &[u8; 32],
    plaintext: &[u8],
    aad: &str,
    kv: Option<u32>,
    do_pad: bool,
) -> Envelope {
    let (buf, pad) = if do_pad {
        let t = pad_target(plaintext.len());
        let mut v = vec![0u8; t];
        v[..plaintext.len()].copy_from_slice(plaintext);
        (v, (t - plaintext.len()) as u32)
    } else {
        (plaintext.to_vec(), 0)
    };
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let ct = aead_encrypt(key, &nonce, &buf, aad.as_bytes());
    Envelope {
        v: 1,
        alg: "XC20P".into(),
        kdf: None,
        kv,
        aad: Some(aad.to_string()),
        n: b64u_encode(&nonce),
        ct: b64u_encode(&ct),
        ep: None,
        pad,
    }
}

pub fn aead_open_envelope(key: &[u8; 32], env: &Envelope, expected_aad: &str) -> Result<Vec<u8>, ()> {
    if env.v != 1 || env.alg != "XC20P" {
        return Err(());
    }
    if let Some(a) = &env.aad {
        if a != expected_aad {
            return Err(());
        }
    }
    let nonce: [u8; 24] = b64u_decode(&env.n)?.try_into().map_err(|_| ())?;
    let ct = b64u_decode(&env.ct)?;
    let buf = aead_decrypt(key, &nonce, &ct, expected_aad.as_bytes())?;
    let pad = env.pad as usize;
    if pad > buf.len() {
        return Err(());
    }
    Ok(buf[..buf.len() - pad].to_vec())
}

pub fn seal_to_envelope(recipient_pub: &[u8; 32], plaintext: &[u8]) -> Envelope {
    let s = seal(recipient_pub, plaintext);
    Envelope {
        v: 1,
        alg: "seal-x25519-hkdf-xc20p".into(),
        kdf: None,
        kv: None,
        aad: None,
        n: b64u_encode(&s.nonce),
        ct: b64u_encode(&s.ct),
        ep: Some(b64u_encode(&s.eph_pub)),
        pad: 0,
    }
}

pub fn seal_open_envelope(
    recipient_priv: &[u8; 32],
    recipient_pub: &[u8; 32],
    env: &Envelope,
) -> Result<Vec<u8>, ()> {
    let ep: [u8; 32] = b64u_decode(env.ep.as_deref().ok_or(())?)?.try_into().map_err(|_| ())?;
    let nonce: [u8; 24] = b64u_decode(&env.n)?.try_into().map_err(|_| ())?;
    let ct = b64u_decode(&env.ct)?;
    seal_open(recipient_priv, recipient_pub, &ep, &nonce, &ct)
}

// --- item encrypt/decrypt (IK under VEK; payload under IK) ---

fn item_payload_aad(vault_id: &str, item_id: &str, version: u64) -> String {
    build_aad(&[("vaultId", vault_id), ("itemId", item_id), ("version", &version.to_string())])
}
fn item_key_aad(vault_id: &str, item_id: &str, key_version: u64) -> String {
    build_aad(&[
        ("vaultId", vault_id),
        ("itemId", item_id),
        ("scope", "ik"),
        ("keyVersion", &key_version.to_string()),
    ])
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedItem {
    pub ciphertext: Envelope,
    pub wrapped_item_key: Envelope,
}

pub fn encrypt_item(
    vek: &[u8; 32],
    vault_id: &str,
    item_id: &str,
    version: u64,
    key_version: u64,
    plaintext: &[u8],
) -> EncryptedItem {
    let ik = random32();
    let ciphertext = aead_seal_envelope(
        &ik,
        plaintext,
        &item_payload_aad(vault_id, item_id, version),
        Some(key_version as u32),
        true,
    );
    let wrapped_item_key = aead_seal_envelope(
        vek,
        &ik,
        &item_key_aad(vault_id, item_id, key_version),
        Some(key_version as u32),
        false,
    );
    EncryptedItem { ciphertext, wrapped_item_key }
}

pub fn decrypt_item(
    vek: &[u8; 32],
    vault_id: &str,
    item_id: &str,
    version: u64,
    key_version: u64,
    ciphertext: &Envelope,
    wrapped_item_key: &Envelope,
) -> Result<Vec<u8>, ()> {
    let ik_vec = aead_open_envelope(vek, wrapped_item_key, &item_key_aad(vault_id, item_id, key_version))?;
    let ik: [u8; 32] = ik_vec.try_into().map_err(|_| ())?;
    aead_open_envelope(&ik, ciphertext, &item_payload_aad(vault_id, item_id, version))
}
