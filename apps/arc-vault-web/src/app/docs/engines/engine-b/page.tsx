import { Callout } from "../../components/callout";
import { CodeBlock } from "../../components/code-block";
import { DocsPrevNext } from "../../components/docs-prev-next";
import { highlightAll } from "../../components/highlight";

export const metadata = { title: "Engine B — end-to-end vault · arc docs" };

const snippets = {
  enroll: {
    code: `import { VaultClient } from "@arc/sdk";

const client = new VaultClient({ baseUrl: "http://localhost:3001", profile: "test" });
await client.devLogin("alice@example.com");
const { recoveryKey } = await client.enroll("correct horse battery staple");
// Show recoveryKey to the user once — it can re-enroll them under a new
// master password without rotating their cryptographic identity (ADR-006).`,
    lang: "typescript",
  },
  unlockAndItem: {
    code: `// Same machine, later session.
await client.devLogin("alice@example.com");
await client.unlock("correct horse battery staple");

const vault = await client.createVault("personal", "Personal");
await client.putItem(
  vault.id,
  { type: "login", username: "alice@example.com", password: "s3cret!" },
  { type: "login" },
);

// Pull everything back — every item is decrypted client-side.
const items = await client.pullItems(vault.id, { since: 0 });`,
    lang: "typescript",
  },
  share: {
    code: `// ADR-007: share a single item with a single user.
// arc pqSeal-wraps the item key to the recipient's hybrid identity (X25519
// + ML-KEM-768), so the share is post-quantum hybrid by default.
await client.shareItem(vault.id, item.id, {
  granteeEmail: "bob@example.com",
  permission: "view",
});`,
    lang: "typescript",
  },
  passkey: {
    code: `// Discoverable passkey — one biometric tap, zero typing (ADR-008).
const reg = await client.beginPasskeyRegistration();
// ...drive navigator.credentials.create() on the registration options...
await client.finishPasskeyRegistration(reg.id, attestation);

// Next session, no email or master password required.
const fresh = new VaultClient({ baseUrl: "http://localhost:3001" });
await fresh.beginDiscoverableUnlock();
await fresh.finishDiscoverableUnlock(assertion);`,
    lang: "typescript",
  },
};

export default async function EngineBPage() {
  const h = await highlightAll(snippets);
  return (
    <>
      <h1>Engine B — end-to-end encrypted vault</h1>
      <p>
        Engine B is the Bitwarden-class vault re-built on top of arc-server. Passwords, TOTP
        codes, secure notes, item-level sharing, multi-device — all client-encrypted. The
        server stores ciphertext envelopes and the metadata needed to route them; it never
        sees a master password, a derived key, or any plaintext.
      </p>

      <h2>What the SDK does for you</h2>
      <ul>
        <li>
          <strong>Argon2id</strong> on the master password → MK, then HKDF → identity / signing /
          wrapping keys (audit LOW-B enforces a server-side floor: production refuses anything
          below the <code>mobile</code> profile).
        </li>
        <li>
          <strong>X25519 + Ed25519</strong> identity + signing keys, plus an{" "}
          <strong>ML-KEM-768</strong> hybrid half — every grant a recipient receives is
          post-quantum-safe by default (ADR-002).
        </li>
        <li>
          <strong>XChaCha20-Poly1305</strong> for every payload, with 24-byte random nonces.
        </li>
        <li>
          <strong>RFC 8785 JCS</strong> canonical serialisation so the Rust verifier
          (<code>vault-crypto-rs</code>) and the TS impl produce byte-identical signatures.
        </li>
      </ul>

      <h2>Examples</h2>
      <h3>Enroll a new account</h3>
      <CodeBlock html={h.enroll} raw={snippets.enroll.code} language="typescript" />
      <Callout kind="warning" title="Recovery key (once)">
        The recovery key is generated and shown <em>once</em>. Lose it + the master password,
        and the data is unrecoverable — arc has no master decryption ability by construction.
        ADR-006 walks through the recovery wrap so you can re-enroll under a new master
        password without rotating identity keys.
      </Callout>

      <h3>Unlock and store an item</h3>
      <CodeBlock html={h.unlockAndItem} raw={snippets.unlockAndItem.code} language="typescript" />

      <h3>Item-level sharing (ADR-007)</h3>
      <CodeBlock html={h.share} raw={snippets.share.code} language="typescript" />
      <p>
        Item-level sharing wraps the per-item key (IK) for the recipient's hybrid identity
        with <code>pqSeal</code>. The recipient decrypts one item without becoming a vault
        member or seeing the vault key. Permissions are <code>view</code> /{" "}
        <code>edit</code>, with optional TTL.
      </p>

      <h3>Passkey unlock</h3>
      <CodeBlock html={h.passkey} raw={snippets.passkey.code} language="typescript" />
      <p>
        Discoverable WebAuthn PRF — one tap, zero typing. The PRF output is the input to the
        wrap key that unwraps the identity private key, so the passkey can replace the master
        password without weakening the wrap.
      </p>

      <Callout kind="info" title="Multi-device + hybrid SAS (LOW-D)">
        Each device gets its own X25519 + ML-KEM hybrid keypair. The verification code an
        approving device shows the user now binds <em>both</em> halves of the new device's
        pair (audit LOW-D), so a MITM that swapped the ML-KEM key on the wire would change
        the SAS the human compares. Legacy X25519-only devices fall back to the
        <code>fingerprint(x25519, 3)</code> shape — display chrome doesn't need a version
        flag.
      </Callout>

      <DocsPrevNext href="/docs/engines/engine-b" />
    </>
  );
}
