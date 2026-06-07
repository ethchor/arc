/**
 * Self-contained WebAuthn authenticator for tests: ES256 (P-256 + SHA-256), `fmt: "none"`.
 * Produces real attestation + assertion responses that `@simplewebauthn/server` verifies
 * end-to-end — no test-only bypass. Extracted so multiple e2e suites (passkey unlock,
 * Engine-C push-consent approvals) can share one real authenticator.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";

export const RP_ID = "localhost";
export const ORIGIN = "http://localhost:5173";

export function b64url(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

function cborUint(n: number): Buffer {
  if (n < 24) return Buffer.from([n]);
  if (n < 256) return Buffer.from([24, n]);
  if (n < 65536) return Buffer.from([25, (n >> 8) & 0xff, n & 0xff]);
  throw new Error("cborUint: out of supported range");
}

function cborNegInt(value: number): Buffer {
  const n = -1 - value;
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

function cborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  const header = 0xa0 | entries.length;
  return Buffer.concat([Buffer.from([header]), ...entries.flat()]);
}

export class FakeAuthenticator {
  readonly credentialId: Buffer;
  readonly aaguid = Buffer.alloc(16);
  private signCount = 0;
  private readonly privateKey: KeyObject;
  private readonly pubKeyRaw: Buffer;

  constructor() {
    this.credentialId = randomBytes(32);
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = kp.privateKey;
    const spki = kp.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    this.pubKeyRaw = spki.subarray(spki.length - 65);
  }

  registration(challenge: string): { id: string; attestationObject: string; clientDataJSON: string } {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN, crossOrigin: false }),
      "utf8",
    );
    const rpIdHash = createHash("sha256").update(RP_ID).digest();
    const flags = 0x01 | 0x04 | 0x40;
    const counter = Buffer.alloc(4);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length, 0);
    const x = this.pubKeyRaw.subarray(1, 33);
    const y = this.pubKeyRaw.subarray(33, 65);
    const coseKey = cborMap([
      [cborUint(1), cborUint(2)],
      [cborUint(3), cborNegInt(-7)],
      [cborNegInt(-1), cborUint(1)],
      [cborNegInt(-2), cborBytes(x)],
      [cborNegInt(-3), cborBytes(y)],
    ]);
    const authData = Buffer.concat([
      rpIdHash, Buffer.from([flags]), counter, this.aaguid, credIdLen, this.credentialId, coseKey,
    ]);
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

  assertion(challenge: string): { id: string; authenticatorData: string; clientDataJSON: string; signature: string } {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
      "utf8",
    );
    const rpIdHash = createHash("sha256").update(RP_ID).digest();
    const flags = 0x01 | 0x04;
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
}

/** Opaque wrap envelope the passkey register endpoint requires (the approval flow ignores it). */
export function stubEnvelope() {
  return { v: 1, suite: "xchacha20-poly1305", n: "00", ct: "00", tag: "00", aad: "00" };
}
