# 02 — Threat Model

## 2.1 Assets

| Asset | Where it lives | If disclosed |
| ----- | -------------- | ------------ |
| Master password | user's head; transient in client memory | full account compromise |
| MK, WK | client memory only, while unlocked | derive identity keys → all vaults |
| Identity/signing private keys | wrapped under WK + recovery key (server stores ciphertext); plaintext in client memory while unlocked | unwrap every VK granted to the user; forge signatures |
| Recovery key | shown once to user; never to server | unwrap identity key → all vaults |
| VK (per vault) | wrapped per member; plaintext in member memory while unlocked | read/derive all items in that vault |
| IK (per item) | wrapped under VK on each item | read one item |
| Item plaintext | client memory while unlocked | the secret itself |
| Device private keys | OS keychain (desktop) / memory (web) | impersonate that device in approval flows |
| Non-content metadata | server, cleartext | traffic analysis (see §2.5) |

## 2.2 Trust boundaries

```
  user's head ─┐
               │  (master password, recovery key — never leave the client)
   client ─────┤  derives & holds all keys; only place plaintext exists
               │  ── authenticated transport (TLS) ──
   server ─────┘  blind store: salts, wrapped keys, ciphertext, metadata. No decryption key.
```

The server boundary is the strong one: we assume the server, its DBAs, its backups, and its
operators are hostile *for confidentiality* and design so they learn nothing decryptable.
The client boundary is softer and honestly bounded (§2.4).

## 2.3 STRIDE summary

| Adversary | Defended | Not defended |
| --------- | -------- | ------------ |
| Malicious server / DBA / backup thief | Sees only ciphertext, salts, authHash, wrapped keys. Cannot decrypt without MK or recovery key. With signed mutations (doc 10), cannot forge content or membership undetectably. | Traffic analysis (§2.5); can withhold/rollback updates — *detectable* via signed vault-head, not preventable. |
| Network MITM | TLS + AEAD; device approval has an out-of-band SAS (doc 06 §6.3). | — |
| XSS in the web client | CSP/Trusted Types reduce surface; keys kept in a single closure, never persisted (doc 12). | **While unlocked, XSS can exfiltrate decrypted data + held keys.** Fundamental JS limit. |
| Stolen *locked* device | At rest: keychain + SQLCipher; auto-lock; no plaintext persisted. | A stolen *unlocked* device until auto-lock fires. |
| Malicious dependency / supply chain | Lockfile pinning, SRI, minimal vault deps, `pnpm audit`/`cargo audit` in CI. | A compromise of a core crypto lib itself. |
| Vault **admin** | — | Admins hold the VK → can read all vault content and grant access to colluders. Inherent to shared encryption; not a server-trust issue (doc 07 §7.3). |
| **Revoked** member | VK rotation denies *future* reads (doc 07 §7.5). | Anything they already decrypted/cached. Treat exposed secrets as compromised. |
| viewer attempting writes | Server RBAC rejects; peers detect unauthorized writes via signatures. | Not *cryptographically* prevented from encrypting — a viewer holds the VK. |
| Lost master pw **and** recovery key | (by design) | **Permanent, unrecoverable loss.** No escrow, no reset (except opt-in org escrow, doc 14). |

## 2.4 Client-compromise assumptions (stated explicitly)

A tamperproof client is impossible. We assume:

- **Any code running in an unlocked client can read every secret that client has unlocked.**
  That includes XSS in the web app, a malicious browser extension with host permissions, a
  trojaned desktop binary, or malware running as the same OS user.
- The keychain and SQLCipher protect data **at rest**, not against a running malicious
  process with the user's privileges.
- In the browser, JS cannot guarantee secret erasure: the GC may copy `Uint8Array` buffers,
  there is no `mlock`, and secrets can hit swap. Zeroization in JS is best-effort.
- The Rust/Tauri core is materially stronger (keys in `Zeroizing` memory, the WebView never
  holds the VK), but still not proof against same-user malware.

**Therefore the design reduces *server* trust to zero, but cannot reduce *client* trust to
zero.** Our levers are: minimize the unlock window (auto-lock, doc 12), minimize the
unlocked surface (decrypt per-field in Rust where possible), and make tampering *detectable*
(signed mutations, doc 10) even when it can't be prevented.

## 2.5 Metadata-leakage analysis

The server stores **zero** searchable plaintext. But non-content metadata is unavoidable for
sync to function, and it leaks. We enumerate it honestly.

| Leaked metadata | What it reveals | Mitigation |
| --------------- | --------------- | ---------- |
| Item count per vault | rough size of a person's/team's secret set | optional decoy/pad items (`[future]`); accepted otherwise |
| Ciphertext length | item size class (a long secure note vs a short password) | **length bucketing / padding** to fixed size classes (e.g. 256/1k/4k/16k) — `[planned]`, on by default for item payloads |
| `type` field (login/card/note/…) | category distribution | make `type` optional; when omitted, store `type=null` (a small UX cost) — `[spec]` |
| `updatedAt` / `seq` / access timing | activity patterns, working hours, "they just rotated a credential" | unavoidable for sync; coarse timestamps at rest (`[planned]`); no per-read server log unless telemetry opt-in (doc 11) |
| Membership graph (`vault_memberships`) | who is on which team/vault | inherent to server-mediated sharing; minimize by not exposing membership to non-members (doc 09 RBAC) |
| Folder structure (`folderId`, parent links) | organizational shape | folder *names* are encrypted; structure (the tree) is metadata — accepted |
| Identity public-key directory lookups | who is looking up whom to share | rate-limit + audit; accepted (needed to wrap a VK to a recipient) |
| Device count / `lastSeenAt` | how many devices, when last active | accepted; useful to the user anyway |

**Blind-index anti-pattern:** we deliberately do **not** add deterministic-encryption
"blind index" tokens for server-side search. They leak equality (which items share a value)
and are an easy footgun. Search stays client-side over decrypted items.

**Padding policy:** payload length bucketing is the one mitigation we turn on by default
because it is cheap and meaningfully blunts size fingerprinting. The envelope (doc 04)
carries an explicit `pad` length so decryption can strip it deterministically.

LOW-F (audit) — bucket boundary, explicit. Below 256 KiB inputs snap to the next fixed
bucket in `{64, 256, 1024, 4096, 16384, 65536, 262144}`. **Above 256 KiB the bucket
grows linearly in 256 KiB steps** (`ceil(len / 262144) * 262144`) — a 1.5 MiB attachment
becomes a 1.75 MiB envelope, a 4 MiB attachment becomes a 4 MiB envelope, etc. The
boundary is intentional: sub-linear buckets above 256 KiB either explode the catalog or
telegraph the actual length via which bucket was chosen, so we accept the constant-size
leak of "rounded up to the next 256 KiB" in exchange for a fixed storage-cost model that
attachment quotas can plan against. The Rust core and any future SDK MUST replicate the
exact same step function (the on-wire `pad` value is part of the deterministic envelope
contract; see `packages/arc-crypto/src/envelope.ts::padTarget` + the regression test
that pins the boundary in `packages/arc-crypto/test/crypto.test.ts`).

## 2.6 Expanded adversaries: machine identities, delegation, enterprise

These extend the model for the developer/team surface (full design in doc 14).

| Adversary / scenario | Defended | Not defended |
| -------------------- | -------- | ------------ |
| **Stolen service-account key** (CI token, machine identity private key) | Scoped to specific vault(s); revocable by deleting its grant + rotating VK; all uses are audit-logged; key injected from a secrets manager, never committed. | Until revoked, the holder has exactly the access that identity was granted. Treat its vaults' secrets as exposed and rotate them. |
| **Over-broad CI/CD access** | Per-environment vaults; least-privilege grants; short-lived tokens preferred over long-lived. | A pipeline configured with a too-broad grant is a policy failure, not a crypto one. |
| **Delegated / break-glass access** | Time-boxed grant with server-enforced `expiresAt`; audit-logged; requires admin action. | Expiry is **server-enforced, not cryptographic** — a hostile server could ignore `expiresAt`. A delegate who copied secrets during the window keeps them. |
| **Malicious / compromised admin** | Signed admin actions (doc 10) make membership/grant changes attributable and tamper-evident to peers. | An admin legitimately holds the VK and can read everything and grant colluders. Inherent. Mitigate operationally: limit admins, audit, alert on grant changes. |
| **Enterprise automation / org-managed vaults** | Org governance (doc 14): role policy, audit feed, optional escrow that is explicit and surfaced to members. | Opt-in escrow deliberately weakens pure ZK for those vaults — by design and disclosed. |
| **Insider at the provider with org-escrow access** | Escrow is per-org, opt-in, surfaced; non-escrowed vaults remain pure ZK. | For escrowed vaults, the org (and whoever holds the org recovery key) can decrypt. This is the stated tradeoff of escrow. |

## 2.7 What we explicitly do not claim

- We do not claim viewers are *cryptographically* prevented from producing ciphertext.
- We do not claim revocation retroactively erases what a member already read.
- We do not claim the client is safe once an attacker runs code inside an unlocked session.
- We do not claim to hide coarse metadata (counts/sizes/timing) from the server beyond §2.5.
- We do not claim delegated-access expiry is cryptographically enforced.

Stating these plainly is part of the security posture: users and integrators can reason
about residual risk instead of trusting marketing.
