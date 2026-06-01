import { normalizeMount } from "@arc/leasing";
import type {
  TransitCiphertext,
  TransitCreateKeyOptions,
  TransitDecryptOptions,
  TransitEncryptOptions,
  TransitEngine,
} from "@arc/secrets-engine";
import type { OpenBaoClient, OpenBaoResponse } from "./client";

const strip = (path: string): string => path.replace(/^\/+/, "");

/**
 * Encryption-as-a-service backed by OpenBao's `transit` engine. Maps arc's clean
 * {@link TransitEngine} contract onto OpenBao's
 * `<mount>/keys/<name>`, `<mount>/encrypt/<name>`, `<mount>/decrypt/<name>` HTTP layout.
 *
 * Bytes are base64-encoded for the wire (OpenBao requirement); the API surfaces plain
 * `Uint8Array` so callers don't have to think about the encoding. Ciphertext stays as
 * the opaque `vault:vN:...` string OpenBao returns — it carries the key version internally
 * and is the same format Vault clients expect, so transit-encrypted data is portable
 * between OpenBao instances.
 */
export class OpenBaoTransitEngine implements TransitEngine {
  readonly type = "transit" as const;
  readonly mount: string;

  constructor(
    private readonly client: OpenBaoClient,
    mount = "transit",
  ) {
    this.mount = normalizeMount(mount);
  }

  async createKey(keyName: string, opts: TransitCreateKeyOptions = {}): Promise<void> {
    const body: Record<string, unknown> = {
      type: opts.algorithm ?? "aes256-gcm96",
      exportable: opts.exportable ?? false,
    };
    // OpenBao returns 204 for fresh creates and 200 for "already exists" — both are fine.
    await this.client.write(`${this.mount}keys/${strip(keyName)}`, body);
  }

  async encrypt(
    keyName: string,
    plaintext: Uint8Array,
    opts: TransitEncryptOptions = {},
  ): Promise<TransitCiphertext> {
    const body: Record<string, unknown> = { plaintext: bytesToB64(plaintext) };
    if (opts.contextBase64 !== undefined) body.context = opts.contextBase64;
    const res = await this.client.write(`${this.mount}encrypt/${strip(keyName)}`, body);
    const ciphertext = (res.data as { ciphertext?: unknown } | undefined)?.ciphertext;
    if (typeof ciphertext !== "string") {
      throw new TransitProtocolError("expected `ciphertext` in transit/encrypt response");
    }
    return { ciphertext, keyVersion: parseKeyVersion(ciphertext) };
  }

  async decrypt(
    keyName: string,
    ciphertext: string,
    opts: TransitDecryptOptions = {},
  ): Promise<Uint8Array> {
    const body: Record<string, unknown> = { ciphertext };
    if (opts.contextBase64 !== undefined) body.context = opts.contextBase64;
    const res = await this.client.write(`${this.mount}decrypt/${strip(keyName)}`, body);
    const b64 = (res.data as { plaintext?: unknown } | undefined)?.plaintext;
    if (typeof b64 !== "string") {
      throw new TransitProtocolError("expected `plaintext` in transit/decrypt response");
    }
    return b64ToBytes(b64);
  }

  async rotateKey(keyName: string): Promise<{ latestVersion: number }> {
    await this.client.write(`${this.mount}keys/${strip(keyName)}/rotate`, {});
    const res = (await this.client.read(`${this.mount}keys/${strip(keyName)}`)) as OpenBaoResponse;
    const latest = Number((res.data as { latest_version?: unknown } | undefined)?.latest_version);
    if (!Number.isFinite(latest) || latest < 1) {
      throw new TransitProtocolError("expected `latest_version` in transit/keys response");
    }
    return { latestVersion: latest };
  }
}

/**
 * `vault:v<N>:<b64>` carries the key version OpenBao used to encrypt. Extracting it lets
 * a caller see when a rotation has stranded older ciphertext without having to round-trip
 * through decrypt.
 */
function parseKeyVersion(ciphertext: string): number {
  const m = /^vault:v(\d+):/.exec(ciphertext);
  if (!m) throw new TransitProtocolError(`unexpected transit ciphertext format: ${ciphertext.slice(0, 16)}…`);
  return Number(m[1]);
}

// Standard base64 (the wire format OpenBao's transit engine accepts). Different from the
// base64url used inside arc envelopes — kept inline so this file has zero deps beyond the
// secrets-engine contract + the adapter client.
function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class TransitProtocolError extends Error {
  constructor(message: string) {
    super(`transit protocol error: ${message}`);
    this.name = "TransitProtocolError";
  }
}
