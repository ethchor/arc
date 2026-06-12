//! MED-H (supply-chain audit): emit a Rust-generated `pq-seal` envelope as JSON on
//! stdout. The companion TypeScript test (`packages/arc-crypto/test/rust-pq-parity.test.ts`)
//! spawns this binary, parses its output, and asserts that the TS `pqSealOpen` extracts
//! the byte-for-byte plaintext we put in. That closes the reverse-direction parity gap —
//! the existing KAT vector only exercises TS→Rust open, not Rust→TS open.
//!
//! Wire shape on stdout:
//!
//! ```json
//! {
//!   "x25519Priv": "<hex>",
//!   "mlkemPriv": "<hex>",       // 2400-byte expanded form, matches @noble/post-quantum
//!   "aad": "vault/x#kv1",
//!   "plaintextHex": "<hex>",
//!   "envelope": { ... v1 envelope as `arc_vault_crypto::Envelope` serializes ... }
//! }
//! ```
//!
//! Run: `cargo run --manifest-path crates/vault-crypto-rs/Cargo.toml --example gen_pq_vector`

use arc_vault_crypto::{
    pq_seal_to_envelope, x25519_keypair, x25519_public_from_secret, HybridPub,
};
use ml_kem::{
    kem::{Generate, KeyExport},
    ExpandedKeyEncoding, MlKem768,
};
use serde_json::json;

fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

fn main() {
    // Fresh hybrid keypair. Determinism isn't needed — the TS open path verifies
    // *content*, not bytes (the wire envelope changes every run because pq-seal picks
    // an ephemeral X25519 key and a fresh nonce).
    let (x25519_priv, x25519_pub) = x25519_keypair();
    let dk = ml_kem::DecapsulationKey::<MlKem768>::generate();
    let mlkem_pub_arr = dk.encapsulation_key().to_bytes();
    #[allow(deprecated)]
    let mlkem_priv_arr = dk.to_expanded_bytes();

    let plaintext: &[u8] = b"med-h-cross-stack-payload-XYZ";
    let aad = "vault/x#kv1";

    let mlkem_pub: [u8; 1184] = mlkem_pub_arr.as_slice().try_into().expect("ml-kem pub len");
    let envelope = pq_seal_to_envelope(
        HybridPub {
            x25519: &x25519_pub,
            mlkem: &mlkem_pub,
        },
        plaintext,
        aad,
    );

    // Pinning the x25519 pub from the priv lets the TS side double-check we exported the
    // right private half — a swap (e.g. priv from someone else, pub of this run) would
    // produce a non-opening envelope and we want that failure to be a hard parity bug,
    // not a passing test against a mismatched-pair vector.
    let expected_x25519_pub = x25519_public_from_secret(&x25519_priv);
    assert_eq!(expected_x25519_pub, x25519_pub);

    let out = json!({
        "x25519Priv": to_hex(&x25519_priv),
        "x25519Pub": to_hex(&x25519_pub),
        "mlkemPriv": to_hex(mlkem_priv_arr.as_slice()),
        "mlkemPub": to_hex(mlkem_pub_arr.as_slice()),
        "aad": aad,
        "plaintextHex": to_hex(plaintext),
        "envelope": envelope,
    });
    // Single line so the TS side can JSON.parse without worrying about the cargo prelude
    // line that `cargo run` emits ahead of the example's stdout.
    println!("{}", serde_json::to_string(&out).unwrap());
}
