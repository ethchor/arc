import { utf8 } from "./bytes";

export type AadField = [name: string, value: string];

/**
 * Canonical, length-prefixed Associated Data string (docs/04 §4.3).
 *
 *   AAD = "arc-aad/1\n" + join("\n", [ name + ":" + len(utf8(value)) + ":" + value ])
 *
 * Length-prefixing each field prevents a value that contains the delimiter from forging
 * a field boundary. Both TS and Rust build this identical string.
 */
export function buildAad(fields: AadField[]): string {
  const lines = fields.map(([name, value]) => `${name}:${utf8(value).length}:${value}`);
  return "arc-aad/1\n" + lines.join("\n");
}
