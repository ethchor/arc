//! Thin wrapper around [`tera`] for sink rendering. Each sink owns its own template (no
//! cross-sink imports) so a typo in one sink can't break the others.
//!
//! Templates have access to two variables:
//!   - `data`   — the JSON object returned by arc (KV `data.data`, or dynamic creds `data`).
//!   - `meta`   — for KV reads: `{ version }`. For dynamic creds: `{ lease_id, lease_duration }`.
//!
//! Example template:
//!
//! ```jinja2
//! DATABASE_URL=postgres://{{ data.username }}:{{ data.password }}@{{ data.host }}/{{ data.db }}
//! # version={{ meta.version }}
//! ```

use serde::Serialize;
use tera::Context;

#[derive(Debug, thiserror::Error)]
pub enum TemplateError {
    #[error("template: {0}")]
    Render(#[from] tera::Error),
}

/// Render `template_source` with the given `data` and `meta` JSON.
///
/// Autoescape is **disabled** — these templates render `.env` / `.conf` / `.ini` / `.yaml`
/// files, not HTML. With autoescape on, characters like `/` become `&#x2F;` and the
/// resulting config file is broken (lease IDs, URLs, paths all get mangled).
pub fn render(
    template_source: &str,
    data: &serde_json::Value,
    meta: &serde_json::Value,
) -> Result<String, TemplateError> {
    let mut ctx = Context::new();
    ctx.insert("data", data);
    ctx.insert("meta", meta);
    let rendered = tera::Tera::one_off(template_source, &ctx, false)?;
    Ok(rendered)
}

/// Convenience: render with a strongly-typed `meta` struct.
pub fn render_typed<M: Serialize>(
    template_source: &str,
    data: &serde_json::Value,
    meta: &M,
) -> Result<String, TemplateError> {
    let meta_json = serde_json::to_value(meta).unwrap_or(serde_json::Value::Null);
    render(template_source, data, &meta_json)
}
