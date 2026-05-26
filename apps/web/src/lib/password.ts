const SETS = {
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{};:,.?",
};

export interface GenOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
}

export const DEFAULT_GEN: GenOptions = {
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
};

/** Cryptographically-random password from the selected character sets. */
export function generatePassword(opts: Partial<GenOptions> = {}): string {
  const o = { ...DEFAULT_GEN, ...opts };
  let pool = "";
  if (o.lower) pool += SETS.lower;
  if (o.upper) pool += SETS.upper;
  if (o.digits) pool += SETS.digits;
  if (o.symbols) pool += SETS.symbols;
  if (!pool) pool = SETS.lower;

  const random = new Uint32Array(o.length);
  crypto.getRandomValues(random);
  let out = "";
  for (let i = 0; i < o.length; i++) {
    out += pool[random[i]! % pool.length];
  }
  return out;
}
