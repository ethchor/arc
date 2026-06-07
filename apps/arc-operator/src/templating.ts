/**
 * Tiny `{{ .field }}` substitution. Intentionally narrow:
 *  - only top-level fields (`.field`, `.snake_case`) — no expressions, no nesting.
 *  - reference to a missing field throws so we never silently produce a Secret with
 *    `{{ .password }}` baked into it.
 *
 * If someone needs branches/loops, escalate to Go-template-on-server or pull in handlebars
 * — but for "render a connection string from a KV map", this is enough.
 */
const TOKEN = /\{\{\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function renderTemplate(
  template: string,
  source: Record<string, unknown>,
  context: string,
): string {
  return template.replace(TOKEN, (_match, field: string) => {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      throw new Error(`template ${context}: field "${field}" not present in source`);
    }
    const v = source[field];
    return v === null || v === undefined ? "" : String(v);
  });
}

/**
 * Apply a `{ secretKey → template }` map (from `spec.target.template`) against a source.
 * When the template map is absent, return the source verbatim (after stringifying values).
 */
export function projectFields(
  template: Record<string, string> | undefined,
  source: Record<string, unknown>,
  context: string,
): Record<string, string> {
  if (!template) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(source)) out[k] = v === null || v === undefined ? "" : String(v);
    return out;
  }
  const out: Record<string, string> = {};
  for (const [secretKey, tmpl] of Object.entries(template)) {
    out[secretKey] = renderTemplate(tmpl, source, `${context}.${secretKey}`);
  }
  return out;
}
