import type { JsonValue } from "./types";
import { VaultCryptoError } from "./types";

/**
 * RFC 8785 (JSON Canonicalization Scheme), constrained to I-JSON (RFC 7493).
 *
 * This is the single canonical byte form for everything that is hashed or signed
 * (mutation tuples, grant tuples, signed vault-head — docs/04 and docs/10) and for
 * deterministic item serialization. The TS and Rust cores MUST agree byte-for-byte.
 *
 * Constraints (enforced): numbers must be finite integers (signed tuples use only
 * strings and integers, so JCS float edge-cases never arise); object keys are sorted
 * by UTF-16 code units (JS default string sort), which matches RFC 8785; string
 * escaping matches ECMAScript JSON string production (i.e. JSON.stringify).
 */
export function jcs(value: JsonValue): string {
  return serialize(value);
}

function serialize(v: JsonValue): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    const n = v as number;
    if (!Number.isFinite(n)) throw new VaultCryptoError("jcs: non-finite number");
    if (!Number.isInteger(n)) {
      throw new VaultCryptoError("jcs: only integer numbers are permitted (I-JSON)");
    }
    // Integers serialize canonically via String(); avoids -0 and exponent forms.
    return String(n === 0 ? 0 : n);
  }
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(serialize).join(",") + "]";
  if (t === "object") {
    const obj = v as { [k: string]: JsonValue };
    const keys = Object.keys(obj).sort(); // default sort = UTF-16 code-unit order (RFC 8785)
    const parts: string[] = [];
    for (const k of keys) parts.push(JSON.stringify(k) + ":" + serialize(obj[k]!));
    return "{" + parts.join(",") + "}";
  }
  throw new VaultCryptoError(`jcs: unsupported type ${t}`);
}
