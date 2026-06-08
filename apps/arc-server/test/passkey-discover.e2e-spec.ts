/**
 * Discoverable (username-less) passkey unlock — ADR-008. Exercises the new
 * `/vault/passkey/discover-challenge` + `/vault/passkey/discover-unlock` endpoints
 * end-to-end through the real Nest app + SDK. The fake authenticator here sets the
 * `userHandle` on its assertion (the real registration encodes `String(userId)` as the
 * user handle), so the server can resolve who is signing without a userId on the wire.
 *
 * Asserts:
 *  1. A *fresh* client with **no email** runs the discover flow and ends up both signed in
 *     (accessToken set) and unlocked (identity keys in memory). It can list its vaults and
 *     read a pre-existing item.
 *  2. The server rejects an assertion whose challenge was never issued (anti-replay).
 *  3. The server rejects an assertion whose `userHandle` is missing.
 *  4. The server rejects an assertion whose `userHandle` references an unknown user.
 *  5. Registration emits `residentKey: "required"` so future registrations are discoverable.
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
import { VaultClient, type PasskeyAuthenticator } from "@arc/sdk";
import { AppModule } from "../src/app.module";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

function b64url(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

// --- CBOR encoders (just the subset we emit), mirrored from passkey.e2e-spec ---
function cborUint(n: number): Buffer {
  if (n < 24) return Buffer.from([n]);
  if (n < 256) return Buffer.from([24, n]);
  if (n < 65536) return Buffer.from([25, (n >> 8) & 0xff, n & 0xff]);
  throw new Error("cborUint range");
}
function cborNegInt(value: number): Buffer {
  const n = -1 - value;
  if (n < 24) return Buffer.from([0x20 | n]);
  if (n < 256) return Buffer.from([0x38, n]);
  throw new Error("cborNegInt range");
}
function cborBytes(b: Uint8Array): Buffer {
  const len = b.length;
  let header: Buffer;
  if (len < 24) header = Buffer.from([0x40 | len]);
  else if (len < 256) header = Buffer.from([0x58, len]);
  else if (len < 65536) header = Buffer.from([0x59, (len >> 8) & 0xff, len & 0xff]);
  else throw new Error("cborBytes range");
  return Buffer.concat([header, Buffer.from(b)]);
}
function cborText(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  if (b.length < 24) return Buffer.concat([Buffer.from([0x60 | b.length]), b]);
  return Buffer.concat([Buffer.from([0x78, b.length]), b]);
}
function cborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  const header = 0xa0 | entries.length;
  return Buffer.concat([Buffer.from([header]), ...entries.flat()]);
}

/**
 * Stateful fake authenticator with discoverable-credential semantics. Records the userId
 * given at registration (the server encodes it into `userID` for us), and replays it as
 * `userHandle` on every subsequent assertion — exactly what a real resident credential
 * does. Yields a real ES256 attestation/assertion `@simplewebauthn` verifies.
 */
function makeDiscoverableAuthenticator(): {
  authn: PasskeyAuthenticator;
  setUserHandle: (h: string) => void;
} {
  const credentialId = randomBytes(32);
  const aaguid = Buffer.alloc(16);
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateKey: KeyObject = kp.privateKey;
  const spki = kp.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const pubKeyRaw = spki.subarray(spki.length - 65);
  const prfSeed = randomBytes(32);
  const prf = (salt: Uint8Array): Uint8Array =>
    createHash("sha256").update(prfSeed).update(salt).digest();
  let signCount = 0;
  let userHandleB64: string | null = null;

  const authn: PasskeyAuthenticator = {
    async create(opts) {
      // Server encodes `userID` as `new TextEncoder().encode(String(userId))`, which lands
      // in `opts.user.id` on the wire (already base64url-encoded by @simplewebauthn).
      // Capture it so subsequent `get()` calls can replay it as userHandle verbatim.
      userHandleB64 = opts.user.id;
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin: ORIGIN, crossOrigin: false }),
        "utf8",
      );
      const rpIdHash = createHash("sha256").update(RP_ID).digest();
      const flags = 0x01 | 0x04 | 0x40;
      const counter = Buffer.alloc(4);
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(credentialId.length, 0);
      const x = pubKeyRaw.subarray(1, 33);
      const y = pubKeyRaw.subarray(33, 65);
      const coseKey = cborMap([
        [cborUint(1), cborUint(2)],
        [cborUint(3), cborNegInt(-7)],
        [cborNegInt(-1), cborUint(1)],
        [cborNegInt(-2), cborBytes(x)],
        [cborNegInt(-3), cborBytes(y)],
      ]);
      const authData = Buffer.concat([
        rpIdHash, Buffer.from([flags]), counter, aaguid, credIdLen, credentialId, coseKey,
      ]);
      const attestationObject = cborMap([
        [cborText("fmt"), cborText("none")],
        [cborText("attStmt"), cborMap([])],
        [cborText("authData"), cborBytes(authData)],
      ]);
      return {
        attestation: {
          id: b64url(credentialId),
          rawId: b64url(credentialId),
          type: "public-key",
          response: {
            attestationObject: b64url(attestationObject),
            clientDataJSON: b64url(clientDataJSON),
          },
          clientExtensionResults: {},
        },
        prfOutput: prf(opts.prfFirst),
      };
    },
    async get(opts) {
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin: ORIGIN, crossOrigin: false }),
        "utf8",
      );
      const rpIdHash = createHash("sha256").update(RP_ID).digest();
      const flags = 0x01 | 0x04;
      signCount += 1;
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(signCount, 0);
      const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
      const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
      const signer = createSign("sha256");
      signer.update(Buffer.concat([authenticatorData, clientDataHash]));
      signer.end();
      const signature = signer.sign(privateKey);
      return {
        assertion: {
          id: b64url(credentialId),
          rawId: b64url(credentialId),
          type: "public-key",
          response: {
            authenticatorData: b64url(authenticatorData),
            clientDataJSON: b64url(clientDataJSON),
            signature: b64url(signature),
            ...(userHandleB64 ? { userHandle: userHandleB64 } : {}),
          },
          clientExtensionResults: {},
        },
        prfOutput: prf(opts.prfFirst),
      };
    },
  };
  return { authn, setUserHandle: (h) => { userHandleB64 = h; } };
}

const stubEnvelope = () => ({ v: 1, suite: "xchacha20-poly1305", n: "00", ct: "00", tag: "00", aad: "00" });

describe("discoverable (username-less) passkey unlock (ADR-008)", () => {
  const savedEnv = { rp: process.env.ARC_PASSKEY_RP_ID, origin: process.env.ARC_PASSKEY_ORIGIN };
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.ARC_PASSKEY_RP_ID = RP_ID;
    process.env.ARC_PASSKEY_ORIGIN = ORIGIN;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const addr = app.getHttpServer().address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
    if (savedEnv.rp === undefined) delete process.env.ARC_PASSKEY_RP_ID; else process.env.ARC_PASSKEY_RP_ID = savedEnv.rp;
    if (savedEnv.origin === undefined) delete process.env.ARC_PASSKEY_ORIGIN; else process.env.ARC_PASSKEY_ORIGIN = savedEnv.origin;
  });

  /** Enroll a user + register a discoverable passkey. Returns the authenticator + the user's id. */
  async function setupUserWithPasskey(email: string) {
    const A = new VaultClient({ baseUrl, profile: "test" });
    const { userId } = await A.devLogin(email);
    await A.enroll("master-pw-for-" + email);
    const { authn } = makeDiscoverableAuthenticator();
    await A.registerPasskey(authn, "test-passkey");
    return { client: A, userId, authn };
  }

  it("signInWithDiscoverablePasskey: fresh client with no email becomes signed in (not yet unlocked)", async () => {
    const { authn } = await setupUserWithPasskey("disc-signin@example.com");

    const B = new VaultClient({ baseUrl, profile: "test" });
    const { userId, email } = await B.signInWithDiscoverablePasskey(authn);
    expect(email).toBe("disc-signin@example.com");
    expect(userId).toBeGreaterThan(0);

    // Signed in: can hit authenticated endpoints. Not unlocked: keyset is fetchable, but
    // listVaults would need a session — that's expected.
    const passkeys = await B.listPasskeys();
    expect(passkeys.length).toBe(1);
  });

  it("signInAndUnlockWithPasskey: end-to-end, no email, reads a pre-existing item", async () => {
    const { client: A, authn } = await setupUserWithPasskey("disc-happy@example.com");
    const vault = await A.createVault("team");
    await A.putItem(vault.id, { type: "secret", key: "K", value: "shared-secret-value" }, { type: "secret" });

    // Fresh client — no devLogin, no email — runs sign-in + unlock atomically.
    const B = new VaultClient({ baseUrl, profile: "test" });
    const { email } = await B.signInAndUnlockWithPasskey(authn);
    expect(email).toBe("disc-happy@example.com");

    await B.listVaults();
    const pulled = await B.pull(vault.id, 0);
    expect(pulled.items[0]!.data).toMatchObject({ value: "shared-secret-value" });
  });

  it("rejects an assertion whose challenge was never issued (anti-replay)", async () => {
    const { authn } = await setupUserWithPasskey("disc-replay@example.com");
    // Skip /discover-challenge — fabricate a challenge ourselves.
    const fakeOpts: Parameters<PasskeyAuthenticator["get"]>[0] = {
      challenge: b64url(randomBytes(32)),
      allowCredentials: [],
      rpId: RP_ID,
      userVerification: "required",
      timeout: 60_000,
      prfSalt: "",
      prfFirst: new Uint8Array(0),
    };
    const assertion = await authn.get(fakeOpts);
    const r = await request(baseUrl)
      .post("/vault/passkey/discover-unlock")
      .send({ assertion: assertion.assertion as Record<string, unknown> })
      .expect(401);
    expect(r.body.message).toMatch(/no pending discoverable unlock/i);
  });

  it("rejects an assertion missing userHandle", async () => {
    const { authn, setUserHandle } = (() => {
      const made = makeDiscoverableAuthenticator();
      return { authn: made.authn, setUserHandle: made.setUserHandle };
    })();
    // Register so the credential exists server-side, then strip the userHandle before asserting.
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("disc-no-handle@example.com");
    await A.enroll("pw");
    await A.registerPasskey(authn, "t");

    const ch = await request(baseUrl).post("/vault/passkey/discover-challenge").expect(201);
    setUserHandle(null as unknown as string);
    // Set the handle reference to "null"-ish: the authenticator only emits userHandle when
    // its local value is set. We force-clear it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (authn as any).get.toString;  // (no-op; the authenticator now omits the field)
    // The simplest way to assert the "missing userHandle" path is to directly POST an
    // assertion shape without that field. We re-derive the assertion through the helper
    // but strip the field on the wire below.
    const assertion = await authn.get({ challenge: ch.body.challenge, allowCredentials: [], rpId: RP_ID, userVerification: "required", timeout: 60_000, prfSalt: "", prfFirst: new Uint8Array(0) });
    // Remove userHandle from the response body if the helper somehow included it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete ((assertion.assertion as any).response as { userHandle?: string }).userHandle;
    const r = await request(baseUrl)
      .post("/vault/passkey/discover-unlock")
      .send({ assertion: assertion.assertion as Record<string, unknown> })
      .expect(401);
    expect(r.body.message).toMatch(/missing userHandle/i);
  });

  it("rejects an assertion whose userHandle references an unknown user", async () => {
    const { authn, setUserHandle } = (() => {
      const made = makeDiscoverableAuthenticator();
      return { authn: made.authn, setUserHandle: made.setUserHandle };
    })();
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("disc-bad-handle@example.com");
    await A.enroll("pw");
    await A.registerPasskey(authn, "t");

    // Forge the user handle to point at a numerically-impossible user.
    setUserHandle(b64url(Buffer.from("999999999", "utf8")));
    const ch = await request(baseUrl).post("/vault/passkey/discover-challenge").expect(201);
    const assertion = await authn.get({ challenge: ch.body.challenge, allowCredentials: [], rpId: RP_ID, userVerification: "required", timeout: 60_000, prfSalt: "", prfFirst: new Uint8Array(0) });
    const r = await request(baseUrl)
      .post("/vault/passkey/discover-unlock")
      .send({ assertion: assertion.assertion as Record<string, unknown> })
      .expect(401);
    expect(r.body.message).toMatch(/passkey not registered/i);
  });

  it("registration option emits residentKey: required (future passkeys are discoverable)", async () => {
    const A = new VaultClient({ baseUrl, profile: "test" });
    await A.devLogin("disc-resident-flag@example.com");
    await A.enroll("pw");
    const token = (await A.devLogin("disc-resident-flag@example.com")).token;
    const opts = await request(baseUrl)
      .post("/vault/passkey/register-challenge")
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    expect(opts.body.authenticatorSelection?.residentKey).toBe("required");
  });
});

void stubEnvelope; // referenced in case future tests need it
