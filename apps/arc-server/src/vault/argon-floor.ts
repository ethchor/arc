import { BadRequestException, Logger } from "@nestjs/common";

/**
 * LOW-B (audit): the server used to accept whatever `argonParams` an enrolling client
 * uploaded — including the `test` profile (m=256 KiB, t=1) that's intended for unit
 * tests only. A misconfigured client (or a malicious one) could enroll with weak KDF
 * parameters, leaving the authHash + WK-wrap defenses degraded forever after.
 *
 * Floor model:
 *   - production: at least the `mobile` profile (m=65536 KiB = 64 MiB, t=2, p=1).
 *     Mobile is the LOWEST production-acceptable point per docs/03 §3.1.
 *   - non-production: floor is dropped to (m=128, t=1) so the existing `test` profile
 *     keeps working for jest / vitest. Override via env vars (see below) for staging
 *     runs that want production-strict KDF without being NODE_ENV=production.
 *
 * Env overrides (any platform):
 *   - ARC_ARGON_MIN_M      KiB integer (e.g. 65536 for 64 MiB; 262144 for the desktop profile)
 *   - ARC_ARGON_MIN_T      iteration count (>= 1)
 *
 * The wire DTO carries `{ profile, m, t, p, version }` — output length (`dkLen`) is
 * hardcoded to 32 server-side in `deriveMasterKey`/`deriveAuthHash`, so it isn't part of
 * the floor check.
 *
 * Pattern matches CRIT-B (`buildDefaultMode`) and MED-D (`resolveManifestRequired`):
 * env-aware default that fails closed in production, lenient in dev.
 */

export interface ArgonFloor {
  m: number;
  t: number;
  p: number;
}

export function resolveArgonFloor(): ArgonFloor {
  const isProd = process.env.NODE_ENV === "production";
  const m = parseIntEnv("ARC_ARGON_MIN_M", isProd ? 65_536 : 128);
  const t = parseIntEnv("ARC_ARGON_MIN_T", isProd ? 2 : 1);
  return { m, t, p: 1 };
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    new Logger("argon-floor").warn(
      `${name}=${JSON.stringify(raw)} not a positive integer — falling back to ${fallback}`,
    );
    return fallback;
  }
  return n;
}

/**
 * Validate caller-supplied `argonParams` against the configured floor. Throws
 * `BadRequestException({ error: "argon_below_floor", floor, observed })` on any
 * violation so the SDK can surface a clear error to the user (e.g. "your client is
 * configured with weak Argon2id parameters; upgrade your build").
 *
 * Loose typing matches the wire DTO (`Record<string, unknown>`); a malformed shape
 * trips the same 400 with a `missing_field` reason so the caller knows it isn't a
 * "too weak" issue but a "doesn't look like Argon params at all" one.
 */
export function assertArgonParamsAboveFloor(
  argonParams: Record<string, unknown>,
  floor: ArgonFloor = resolveArgonFloor(),
): void {
  const m = toPositiveInt(argonParams.m, "m");
  const t = toPositiveInt(argonParams.t, "t");
  const p = toPositiveInt(argonParams.p, "p");

  if (m < floor.m || t < floor.t || p < floor.p) {
    throw new BadRequestException({
      error: "argon_below_floor",
      floor: { m: floor.m, t: floor.t, p: floor.p },
      observed: { m, t, p },
    });
  }
}

function toPositiveInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new BadRequestException({
      error: "argon_params_malformed",
      field,
      observed: v,
    });
  }
  return v;
}
