/**
 * End-to-end coverage of the passkey unlock flow. Boots the real app + `PasskeyService`,
 * then drives a full register → unlock → re-unlock cycle using a self-contained
 * `FakeAuthenticator` that produces real WebAuthn responses (real ES256 signatures over
 * real authData, real CBOR-encoded attestation objects). `@simplewebauthn/server`'s
 * verification runs end-to-end — there are no `verify=true` stubs.
 *
 * What's covered:
 *  1. Registration challenge → fake authenticator creates an attestation → server stores
 *     the credential + the client-supplied wrap envelopes.
 *  2. Listing returns the new credential; deleting removes it.
 *  3. Unlock challenge → fake authenticator signs the challenge → server verifies + returns
 *     the wrapped identity envelopes (the same ones the client uploaded).
 *  4. Counter regression on a second unlock is rejected (anti-clone behavior).
 *  5. Unlock for a user with no passkeys returns 404.
 *  6. Invalid assertion (wrong signature) is rejected.
 *
 * The fake authenticator only implements what we need: ES256 (alg -7), `fmt: "none"`
 * attestation, no PRF extension (the PRF wrap envelopes are opaque blobs to the server
 * here — the unwrap step is client-side and unit-tested in arc-crypto).
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  createHash,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { AppModule } from "../src/app.module";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

// ---- Test bootstrap helpers -----------------------------------------------------------

async function login(server: unknown, email: string): Promise<string> {
  const res = await request(server as Parameters<typeof request>[0])
    .post("/auth/dev-login")
    .send({ email })
    .expect(201);
  return (res.body as { accessToken: string }).accessToken;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/**
 * Minimal vault enroll body — only the columns the server requires NOT NULL. The passkey
 * flow doesn't read these envelopes (it stores its own wraps); they're just here so the
 * `PasskeyService.beginRegistration` "not enrolled" check passes.
 */
function enrollDto() {
  const envelope = {
    v: 1,
    suite: "xchacha20-poly1305",
    n: "00",
    ct: "00",
    tag: "00",
    aad: "00",
  };
  return {
    saltMk: "AAA",
    saltAuth: "BBB",
    argonParams: { m: 19456, t: 2, p: 1 },
    authHash: "00",
    identityPublicKey: "AA",
    identityPublicKeyMlkem: "BB",
    signingPublicKey: "CC",
    identitySelfAttestation: "00",
    encIdentityPriv: envelope,
    encIdentityPrivMlkem: envelope,
    encSigningPriv: envelope,
    encIdentityPrivRecovery: envelope,
    encIdentityPrivMlkemRecovery: envelope,
    ownerGrant: envelope,
  };
}

// ---- CBOR helpers (just the subset we emit) -------------------------------------------

function b64url(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

function cborUint(n: number): Buffer {
  if (n < 24) return Buffer.from([n]);
  if (n < 256) return Buffer.from([24, n]);
  if (n < 65536) return Buffer.from([25, (n >> 8) & 0xff, n & 0xff]);
  throw new Error("cborUint: out of supported range");
}

/** Major type 1 (negative int). Value is -1 - n (RFC 8949 §3.1). */
function cborNegInt(value: number): Buffer {
  const n = -1 - value; // e.g. value=-7 → n=6
  if (n < 24) return Buffer.from([0x20 | n]);
  if (n < 256) return Buffer.from([0x38, n]);
  throw new Error("cborNegInt: out of supported range");
}

function cborBytes(b: Uint8Array): Buffer {
  const len = b.length;
  let header: Buffer;
  if (len < 24) header = Buffer.from([0x40 | len]);
  else if (len < 256) header = Buffer.from([0x58, len]);
  else if (len < 65536) header = Buffer.from([0x59, (len >> 8) & 0xff, len & 0xff]);
  else throw new Error("cborBytes: out of supported range");
  return Buffer.concat([header, Buffer.from(b)]);
}

function cborText(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  if (b.length < 24) return Buffer.concat([Buffer.from([0x60 | b.length]), b]);
  return Buffer.concat([Buffer.from([0x78, b.length]), b]);
}

/** Encode a map with the entries in the given order. CTAP2 canonical CBOR isn't required
 *  for `fmt:"none"` (server doesn't re-encode + hash the attestationObject for none),
 *  so plain map encoding is fine. */
function cborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  const header = 0xa0 | entries.length;
  return Buffer.concat([Buffer.from([header]), ...entries.flat()]);
}

// ---- Fake authenticator ---------------------------------------------------------------

/**
 * Minimal WebAuthn authenticator: ES256 (P-256 + SHA-256), `fmt: "none"`. Produces real
 * signatures the server can verify with `@simplewebauthn/server` — there's no test-only
 * bypass anywhere.
 */
class FakeAuthenticator {
  readonly credentialId: Buffer;
  readonly aaguid = Buffer.alloc(16); // all-zero AAGUID is allowed for fmt: "none"
  private signCount = 0;
  private readonly privateKey: KeyObject;
  /** Raw 65-byte uncompressed SEC1 point `0x04 || X(32) || Y(32)`. */
  private readonly pubKeyRaw: Buffer;

  constructor() {
    this.credentialId = randomBytes(32);
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = kp.privateKey;
    // Export the public key in raw uncompressed form so we can carry X / Y straight into
    // the COSE map.
    const spki = kp.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    // SPKI for P-256 ends with the 65-byte uncompressed point; grab the last 65 bytes.
    this.pubKeyRaw = spki.subarray(spki.length - 65);
  }

  registration(challenge: string): { id: string; attestationObject: string; clientDataJSON: string } {
    const clientData = {
      type: "webauthn.create",
      challenge,
      origin: ORIGIN,
      crossOrigin: false,
    };
    const clientDataJSON = Buffer.from(JSON.stringify(clientData), "utf8");

    const rpIdHash = createHash("sha256").update(RP_ID).digest();
    const flags = 0x01 | 0x04 | 0x40; // UP | UV | AT (attested credential data)
    const counter = Buffer.alloc(4); // 0 — first signCount

    // Attested credential data: AAGUID(16) || credIdLen(2BE) || credId(N) || COSEKey
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length, 0);

    const x = this.pubKeyRaw.subarray(1, 33);
    const y = this.pubKeyRaw.subarray(33, 65);
    // COSE_Key { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
    const coseKey = cborMap([
      [cborUint(1), cborUint(2)],
      [cborUint(3), cborNegInt(-7)],
      [cborNegInt(-1), cborUint(1)],
      [cborNegInt(-2), cborBytes(x)],
      [cborNegInt(-3), cborBytes(y)],
    ]);

    const authData = Buffer.concat([
      rpIdHash,
      Buffer.from([flags]),
      counter,
      this.aaguid,
      credIdLen,
      this.credentialId,
      coseKey,
    ]);

    // attestationObject = { fmt: "none", attStmt: {}, authData }
    const attestationObject = cborMap([
      [cborText("fmt"), cborText("none")],
      [cborText("attStmt"), cborMap([])],
      [cborText("authData"), cborBytes(authData)],
    ]);

    return {
      id: b64url(this.credentialId),
      attestationObject: b64url(attestationObject),
      clientDataJSON: b64url(clientDataJSON),
    };
  }

  assertion(challenge: string): {
    id: string;
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
  } {
    const clientData = {
      type: "webauthn.get",
      challenge,
      origin: ORIGIN,
      crossOrigin: false,
    };
    const clientDataJSON = Buffer.from(JSON.stringify(clientData), "utf8");

    const rpIdHash = createHash("sha256").update(RP_ID).digest();
    const flags = 0x01 | 0x04; // UP | UV
    this.signCount += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.signCount, 0);
    const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);

    const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
    const signer = createSign("sha256");
    signer.update(Buffer.concat([authenticatorData, clientDataHash]));
    signer.end();
    const signature = signer.sign(this.privateKey);

    return {
      id: b64url(this.credentialId),
      authenticatorData: b64url(authenticatorData),
      clientDataJSON: b64url(clientDataJSON),
      signature: b64url(signature),
    };
  }

  /** Helper to roll back the sign counter — used for the "regression rejected" test. */
  rewindSignCount(): void {
    this.signCount = 0;
  }
}

const stubEnvelope = (tag: string) => ({
  v: 1,
  suite: "xchacha20-poly1305",
  n: "00",
  ct: tag,
  tag: "00",
  aad: "00",
});

// ---- Tests -----------------------------------------------------------------------------

describe("passkey unlock e2e", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let token: string;
  const authenticator = new FakeAuthenticator();

  beforeAll(async () => {
    const saved = {
      RP_ID: process.env.ARC_PASSKEY_RP_ID,
      ORIGIN: process.env.ARC_PASSKEY_ORIGIN,
    };
    process.env.ARC_PASSKEY_RP_ID = RP_ID;
    process.env.ARC_PASSKEY_ORIGIN = ORIGIN;
    try {
      const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = mod.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
      await app.init();
      server = app.getHttpServer();
      token = await login(server, "passkey-e2e@example.com");
      await request(server).post("/vault/enroll").set(auth(token)).send(enrollDto()).expect(201);
    } finally {
      if (saved.RP_ID === undefined) delete process.env.ARC_PASSKEY_RP_ID;
      else process.env.ARC_PASSKEY_RP_ID = saved.RP_ID;
      if (saved.ORIGIN === undefined) delete process.env.ARC_PASSKEY_ORIGIN;
      else process.env.ARC_PASSKEY_ORIGIN = saved.ORIGIN;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it("register → list shows the new credential with its label", async () => {
    const opts = await request(server)
      .post("/vault/passkey/register-challenge")
      .set(auth(token))
      .expect(201);
    expect(opts.body.challenge).toBeTruthy();
    expect(opts.body.prfSalt).toBeTruthy();
    expect(opts.body.rp.id).toBe(RP_ID);

    const att = authenticator.registration(opts.body.challenge as string);
    const reg = await request(server)
      .post("/vault/passkey/register")
      .set(auth(token))
      .send({
        registration: {
          id: att.id,
          rawId: att.id,
          type: "public-key",
          response: {
            attestationObject: att.attestationObject,
            clientDataJSON: att.clientDataJSON,
          },
          clientExtensionResults: {},
        },
        encIdentityPrivPasskey: stubEnvelope("identity-x25519-prf-wrap"),
        encIdentityPrivMlkemPasskey: stubEnvelope("identity-mlkem-prf-wrap"),
        encSigningPrivPasskey: stubEnvelope("signing-prf-wrap"),
        label: "MacBook Touch ID",
      })
      .expect(201);
    expect(reg.body.credentialId).toBe(att.id);

    const list = await request(server).get("/vault/passkeys").set(auth(token)).expect(200);
    const entries = list.body as Array<{ credentialId: string; label: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.credentialId).toBe(att.id);
    expect(entries[0]!.label).toBe("MacBook Touch ID");
  });

  it("unlock-challenge → unlock returns the stored wrap envelopes (server never sees the PRF output)", async () => {
    const ch = await request(server)
      .post("/vault/passkey/unlock-challenge")
      .set(auth(token))
      .expect(201);
    expect(ch.body.challenge).toBeTruthy();
    expect(ch.body.prfSalt).toBeTruthy();
    expect(Array.isArray(ch.body.allowCredentials)).toBe(true);
    expect((ch.body.allowCredentials as Array<{ id: string }>)[0]!.id).toBeTruthy();

    const ast = authenticator.assertion(ch.body.challenge as string);
    const unlocked = await request(server)
      .post("/vault/passkey/unlock")
      .set(auth(token))
      .send({
        assertion: {
          id: ast.id,
          rawId: ast.id,
          type: "public-key",
          response: {
            authenticatorData: ast.authenticatorData,
            clientDataJSON: ast.clientDataJSON,
            signature: ast.signature,
          },
          clientExtensionResults: {},
        },
      })
      .expect(201);
    expect(unlocked.body.credentialId).toBe(ast.id);
    // Server returns the same envelopes the client uploaded at register time.
    expect(unlocked.body.encIdentityPrivPasskey.ct).toBe("identity-x25519-prf-wrap");
    expect(unlocked.body.encIdentityPrivMlkemPasskey.ct).toBe("identity-mlkem-prf-wrap");
    expect(unlocked.body.encSigningPrivPasskey.ct).toBe("signing-prf-wrap");
  });

  it("rejects an unlock that replays an earlier signCount (anti-clone)", async () => {
    const ch = await request(server)
      .post("/vault/passkey/unlock-challenge")
      .set(auth(token))
      .expect(201);
    // Roll the authenticator's counter back below what the server has stored — this is
    // the classic cloned-authenticator detection path: a second instance with stale state.
    authenticator.rewindSignCount();
    const ast = authenticator.assertion(ch.body.challenge as string);
    await request(server)
      .post("/vault/passkey/unlock")
      .set(auth(token))
      .send({
        assertion: {
          id: ast.id,
          rawId: ast.id,
          type: "public-key",
          response: {
            authenticatorData: ast.authenticatorData,
            clientDataJSON: ast.clientDataJSON,
            signature: ast.signature,
          },
          clientExtensionResults: {},
        },
      })
      .expect(401);
  });

  it("unlock-challenge returns 404 for a user with no registered passkeys", async () => {
    const fresh = await login(server, "no-passkeys@example.com");
    await request(server).post("/vault/enroll").set(auth(fresh)).send(enrollDto()).expect(201);
    await request(server).post("/vault/passkey/unlock-challenge").set(auth(fresh)).expect(404);
  });

  it("rejects an assertion with a corrupted signature", async () => {
    const ch = await request(server)
      .post("/vault/passkey/unlock-challenge")
      .set(auth(token))
      .expect(201);
    const ast = authenticator.assertion(ch.body.challenge as string);
    // Flip a byte in the signature.
    const sigBytes = Buffer.from(ast.signature, "base64url");
    sigBytes[0] = (sigBytes[0]! ^ 0xff) & 0xff;
    const badSig = sigBytes.toString("base64url");
    await request(server)
      .post("/vault/passkey/unlock")
      .set(auth(token))
      .send({
        assertion: {
          id: ast.id,
          rawId: ast.id,
          type: "public-key",
          response: {
            authenticatorData: ast.authenticatorData,
            clientDataJSON: ast.clientDataJSON,
            signature: badSig,
          },
          clientExtensionResults: {},
        },
      })
      .expect(401);
  });

  it("delete removes the credential; subsequent unlock-challenge then 404s", async () => {
    const list = await request(server).get("/vault/passkeys").set(auth(token)).expect(200);
    const id = (list.body as Array<{ id: string }>)[0]!.id;
    await request(server).delete(`/vault/passkeys/${id}`).set(auth(token)).expect(200);
    await request(server).post("/vault/passkey/unlock-challenge").set(auth(token)).expect(404);
  });
});
