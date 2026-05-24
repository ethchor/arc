import { argon2id, hkdfSha256, sha256 } from "./primitives";
import { concat, fromB64u, toB64u, utf8 } from "./bytes";

export interface ArgonProfile {
  profile: string;
  /** memory cost in KiB */
  m: number;
  t: number;
  p: number;
  version: number;
}

/**
 * Argon2id profiles (docs/03 §3.1). `desktop` is the target; `mobile` is the reduced
 * profile for low-RAM/WASM contexts; `test` is for fast unit tests ONLY — never ship it.
 */
export const ARGON_PROFILES = {
  desktop: { profile: "desktop", m: 262144, t: 3, p: 1, version: 1 },
  mobile: { profile: "mobile", m: 65536, t: 4, p: 1, version: 1 },
  test: { profile: "test", m: 256, t: 1, p: 1, version: 1 },
} satisfies Record<string, ArgonProfile>;

export type ArgonProfileName = keyof typeof ARGON_PROFILES;

const DKLEN = 32;

/** MK = Argon2id(master password, salt_mk). */
export function deriveMasterKey(
  password: string | Uint8Array,
  saltMk: Uint8Array,
  params: ArgonProfile,
): Uint8Array {
  const pw = typeof password === "string" ? utf8(password) : password;
  return argon2id(pw, saltMk, { m: params.m, t: params.t, p: params.p, dkLen: DKLEN });
}

/** Split MK into the auth seed and the wrapping key via two HKDF branches (docs/03 §3.3). */
export function splitMasterKey(mk: Uint8Array): { authSeed: Uint8Array; wk: Uint8Array } {
  const empty = new Uint8Array(0);
  return {
    authSeed: hkdfSha256(mk, empty, "arc/auth/v1", 32),
    wk: hkdfSha256(mk, empty, "arc/wrap/v1", 32),
  };
}

/** Client-side authHash = Argon2id(auth seed, salt_auth). Sent to the server (rate-limit gate). */
export function deriveAuthHash(
  authSeed: Uint8Array,
  saltAuth: Uint8Array,
  params: ArgonProfile,
): Uint8Array {
  return argon2id(authSeed, saltAuth, { m: params.m, t: params.t, p: params.p, dkLen: DKLEN });
}

export function deriveRecoveryWrapKey(recoveryRaw: Uint8Array): Uint8Array {
  return hkdfSha256(recoveryRaw, new Uint8Array(0), "arc/recovery/v1", 32);
}

export function derivePasskeyWrapKey(prfOutput: Uint8Array): Uint8Array {
  return hkdfSha256(prfOutput, new Uint8Array(0), "arc/passkey/v1", 32);
}

/**
 * Server-side re-stretch of the client authHash before storage/compare (docs/03 §3.2,
 * docs/06 §6.3). The expensive Argon2id is already in the client chain, so a fast keyed
 * hash here is sufficient: a DB leak then exposes only a value that still requires the
 * full client Argon2id chain per master-password guess. Returns base64url.
 */
export function serverHashAuth(authHashB64: string, serverSaltB64: string): string {
  return toB64u(sha256(concat(fromB64u(serverSaltB64), fromB64u(authHashB64))));
}
