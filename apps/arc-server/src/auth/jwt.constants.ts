import { randomBytes } from "node:crypto";

/**
 * Resolve the JWT secret once. Required in production; in dev/test we generate an
 * ephemeral random secret (stable for the process lifetime). There is deliberately NO
 * hardcoded fallback string (docs/15 §15.4).
 */
function resolveSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production");
  }
  // eslint-disable-next-line no-console
  console.warn("[arc-vault] JWT_SECRET not set; using an ephemeral random secret (dev/test only).");
  return randomBytes(32).toString("hex");
}

export const JWT_SECRET = resolveSecret();
export const getJwtSecret = (): string => JWT_SECRET;
