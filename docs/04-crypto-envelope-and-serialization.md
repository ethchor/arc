# 04 — Crypto Envelope & Canonical Serialization

This doc pins the protocol to the byte level so that **TypeScript and Rust clients produce
identical ciphertext containers and identical signed bytes**. Two failures we are
preventing: (1) inability to roll algorithms forward without a flag day, and (2) a signature
that verifies in one language and fails in another because the two serialized JSON
differently.

## 4.1 Goals

- One container shape for every ciphertext and every signature ("the envelope").
- Explicit algorithm/version fields so we can deprecate and migrate (crypto agility).
- A single, unambiguous canonical byte encoding for anything that is hashed or signed.
- Worked test vectors so implementers can self-check.

## 4.2 The envelope

Every encrypted blob is stored/transmitted as an **envelope**, not as a bare ciphertext.
Logical shape:

```jsonc
{
  "v":   1,                  // envelope schema version (integer, monotonic)
  "alg": "XC20P",            // AEAD algorithm id (registry §4.7)
  "kdf": null,               // KDF id when this envelope is password-derived; else null
  "kv":  3,                  // keyVersion of the wrapping key that produced "ct"
  "aad": "v:1|...",          // canonical AAD string actually bound (doc 03 §3.4)
  "n":   "<base64u nonce>",  // 24-byte nonce, base64url, no padding
  "ct":  "<base64u bytes>",  // ciphertext + 16-byte Poly1305 tag
  "pad": 0,                  // plaintext padding length stripped after decrypt (doc 02 §2.5)
  "sig": null                // optional detached signature envelope (§4.5), else null
}
```

Notes:

- `alg` and `kdf` are **string ids from a registry** (§4.7), never raw parameters, so a
  reader rejects unknown algorithms loudly rather than guessing.
- `kv` lets a reader pick the right wrapping-key version during/after rotation (doc 05/07).
- `aad` is stored explicitly so verification uses exactly the bytes that were bound; the
  reader still independently recomputes the expected AAD and compares (defense against a
  server rewriting `aad`).
- For password-derived envelopes (rare — most data is wrapped under keys, not passwords),
  `kdf` names the Argon2id profile and the relevant salt lives alongside in the keyset.

### Signature-only envelope

A detached signature (no ciphertext) uses a sibling shape:

```jsonc
{
  "v": 1,
  "alg": "Ed25519",
  "kid": "<signing key id>",   // which signing key; supports key rotation (doc 05)
  "payload": "<what was signed: a canonical-bytes digest reference>",
  "sig": "<base64u signature>"
}
```

## 4.3 AAD string construction

AAD (doc 03 §3.4) is built as a **canonical, length-prefixed** field join to avoid
delimiter-injection ambiguity (e.g. an id that itself contains `|`). Normative construction:

```
AAD = "arc-aad/1\n" + join("\n", [ tag(field) for each field ])
tag(name, value) = name + ":" + len(utf8(value)) + ":" + utf8(value)
```

Example for an item payload:

```
arc-aad/1
vaultId:36:550e8400-e29b-41d4-a716-446655440000
itemId:36:7c9e6679-7425-40de-944b-e07fc1f90ae7
version:1:4
keyVersion:1:3
```

Both TS and Rust build this identical string. Because each field is length-prefixed, no
field value can forge the boundary of another.

## 4.4 Canonical item plaintext

Item plaintext is a JSON object. Before encryption it is serialized with the **same
canonical form** used for signing (§4.5) so re-encryption is deterministic and testable.

Item schema (consumer + developer shapes share the envelope; `type` discriminates):

```jsonc
{
  "type": "login",            // login | card | note | identity | totp | secret | env | cert
  "title": "GitHub",
  "fields": {                 // type-specific; example for "login"
    "username": "...",
    "password": "...",
    "url": "https://github.com",
    "totpSecret": "..."
  },
  "custom": [ { "label": "...", "value": "...", "hidden": true } ],
  "notes": "..."
}
```

Developer/secret items use `type:"secret"|"env"|"cert"` with a `fields` map of key→value (an
env bundle) or a PEM/DER blob. The point is one canonical encoder serves every type.

## 4.5 Canonical serialization for signing — decision

**Decision: RFC 8785 (JSON Canonicalization Scheme, JCS) is the canonical form for all
signed JSON.** Anything that is hashed or signed (mutation tuples doc 10, grant tuples,
signed vault-head) is first serialized with JCS, then UTF-8 encoded, then hashed/signed.

Why JCS over alternatives:

| Option | Pro | Con | Verdict |
| ------ | --- | --- | ------- |
| **RFC 8785 JCS** | deterministic key sort + number rules; mature libs in TS & Rust; human-readable for debugging | numbers limited to I-JSON range | **chosen** |
| Canonical CBOR (RFC 8949 §4.2 / CDE) | compact, binary-clean, no number ambiguity | less debuggable; ecosystem split on "canonical" rules | **alternative**, see below |
| Ad-hoc "sort keys + `JSON.stringify`" | trivial | does not normalize numbers, unicode escapes, or whitespace consistently across langs | rejected (the exact footgun we're avoiding) |

**Escape hatch / agility:** the envelope's `v` and the signed payload's algorithm id let us
introduce **canonical CBOR** later as a second serialization (`"ser":"cbor-cde"`) without
breaking existing signatures. Constrain all signed objects to **I-JSON** (RFC 7493): no
floats where integers are meant, no `NaN`/`Infinity`, UTF-8 only, unique keys. Mutation/grant
tuples use only strings and integers specifically so JCS number edge-cases never arise.

### Normative signing procedure

```
bytes      = utf8( JCS( object ) )
digest     = SHA-256( bytes )            // doc 10 tuples sign the digest
signature  = Ed25519_sign( signing_priv, digest )
```

Verification recomputes `JCS(object)` from the received fields (not from a stored string),
re-digests, and verifies — so a server cannot smuggle in bytes that differ from the
semantic object.

## 4.6 Test vectors (Known-Answer Tests)

To guarantee TS↔Rust parity, the spec ships a `vectors/` fixture set (created during
implementation) that **both** cores must reproduce exactly:

1. **Argon2id KAT** — `(password, salt, m, t, p)` → MK hex. One per supported param profile.
2. **HKDF split** — `MK` → `(auth seed, WK)` for each `info` label.
3. **AAD construction** — fixed field set → exact AAD string bytes (hex).
4. **JCS** — a set of objects (nested, unicode, integers, reordered keys) → canonical bytes
   (hex). Includes the RFC 8785 reference examples.
5. **AEAD seal/open** — `(key, nonce, aad, plaintext)` → ciphertext+tag; plus a tamper case
   (flipped byte) that must fail to open.
6. **Sign/verify** — `(signing key, object)` → signature; plus a wrong-key negative case.
7. **Envelope round-trip** — encode → decode → re-encode is byte-stable.

CI runs the TS suite and the Rust suite against the **same** `vectors/` files (doc 15).

## 4.7 Algorithm registry (current)

| Field | Id | Meaning |
| ----- | -- | ------- |
| `alg` (AEAD) | `XC20P` | XChaCha20-Poly1305, 24 B nonce, 16 B tag |
| `alg` (sig) | `Ed25519` | Ed25519 detached signature |
| `kdf` | `argon2id-1` | Argon2id, params in `argonParams` (profile-tagged) |
| seal | `box-seal-x25519` | `crypto_box_seal` (X25519 + XSalsa20-Poly1305) |
| box | `box-x25519` | `crypto_box` (authenticated) |
| `ser` (implicit `jcs`) | `jcs` | RFC 8785 canonical JSON |

Adding an algorithm = new id + bump nothing existing; readers reject ids they don't know.
Removing/deprecating an algorithm = mark deprecated here, re-wrap affected envelopes
(doc 05 §5.3), then refuse to *produce* it while still *reading* it for a deprecation window.

## 4.8 Crypto-agility rules

- Never overwrite an `alg`/`kdf` id's meaning; only add new ids.
- A reader must reject an envelope whose `v` or `alg` it does not understand (fail closed).
- Migrations are re-wraps recorded by bumping `kv`/version, never silent in-place edits.
- The minimum-supported envelope `v` is published; clients below it are forced to update
  before they can decrypt newer data.
