/**
 * JSON-serialisable value. arc binds AAD as canonical JSON (RFC 8785 JCS) so this is
 * deliberately narrow: integer-only numbers, no `undefined`, no class instances.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };
