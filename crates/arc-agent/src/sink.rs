//! Sink state machine. Each sink owns its own template, output path, and (for dynamic
//! sinks) the current lease. `tick` is the single entry point — call it whenever the
//! scheduler thinks the sink might need work.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::arc::{ArcClient, ArcError};
use crate::config::{SinkConfig, SourceConfig};
use crate::on_change::{trigger_on_change, OnChangeError};
use crate::template::{render, TemplateError};

#[derive(Debug, thiserror::Error)]
pub enum SinkError {
    #[error(transparent)]
    Arc(#[from] ArcError),
    #[error(transparent)]
    Template(#[from] TemplateError),
    #[error("sink {sink}: failed to read template file {path}: {source}")]
    TemplateRead {
        sink: String,
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("sink {sink}: failed to write output: {source}")]
    OutputWrite { sink: String, source: std::io::Error },
    #[error("sink {sink}: invalid mode '{mode}': {reason}")]
    InvalidMode {
        sink: String,
        mode: String,
        reason: String,
    },
    #[error(transparent)]
    OnChange(#[from] OnChangeError),
}

/// Result of one tick — surfaces to the runner so it can log + schedule the next pass.
#[derive(Debug)]
pub struct TickOutcome {
    pub changed: bool,
    pub next_tick_at: Instant,
}

#[derive(Debug, Serialize)]
struct KvMeta {
    version: Option<u64>,
}

#[derive(Debug, Serialize)]
struct DynamicMeta {
    lease_id: String,
    lease_duration: u64,
}

/// One sink. Constructed per-tick (cheap) so the runner can rebuild on config reload.
pub struct Sink {
    pub cfg: SinkConfig,
    /// Last rendered output, used to decide whether to fire `on_change` again.
    pub last_rendered: Option<String>,
    /// For dynamic sinks: when the current lease expires.
    pub lease_expires_at: Option<Instant>,
    pub lease_id: Option<String>,
}

impl Sink {
    pub fn new(cfg: SinkConfig) -> Self {
        Self {
            cfg,
            last_rendered: None,
            lease_expires_at: None,
            lease_id: None,
        }
    }

    /// Reconcile this sink against arc. Returns the next time it should be ticked.
    pub async fn tick(&mut self, arc: &ArcClient) -> Result<TickOutcome, SinkError> {
        let template_source = tokio::fs::read_to_string(&self.cfg.template_file)
            .await
            .map_err(|e| SinkError::TemplateRead {
                sink: self.cfg.id.clone(),
                path: self.cfg.template_file.clone(),
                source: e,
            })?;

        let (rendered, next_tick_at, new_lease_id) = match &self.cfg.source {
            SourceConfig::KvGet {
                mount,
                path,
                version,
            } => {
                let kv = arc.kv_get(mount, path, *version).await?;
                let meta = KvMeta {
                    version: kv.data.metadata.version,
                };
                let rendered = render(&template_source, &kv.data.data, &serde_json::to_value(&meta).unwrap())?;
                let next = Instant::now() + Duration::from_secs(self.cfg.refresh_interval_seconds);
                (rendered, next, None)
            }
            SourceConfig::DynamicCreds {
                mount,
                role,
                ttl_seconds,
            } => {
                // Only re-issue when the current lease would expire within the refresh lead.
                let lead = Duration::from_secs(self.cfg.refresh_lead_seconds);
                let needs_issue = match self.lease_expires_at {
                    Some(exp) => exp.saturating_duration_since(Instant::now()) <= lead,
                    None => true,
                };
                if !needs_issue {
                    // No-op tick — schedule for just before expiry.
                    let exp = self.lease_expires_at.expect("checked above");
                    let next = exp - lead;
                    return Ok(TickOutcome {
                        changed: false,
                        next_tick_at: next.max(Instant::now() + Duration::from_secs(1)),
                    });
                }
                let issued = arc.issue_dynamic(mount, role, *ttl_seconds).await?;
                let meta = DynamicMeta {
                    lease_id: issued.lease_id.clone(),
                    lease_duration: issued.lease_duration,
                };
                let rendered = render(&template_source, &issued.data, &serde_json::to_value(&meta).unwrap())?;
                let new_expires =
                    Instant::now() + Duration::from_secs(issued.lease_duration);
                self.lease_expires_at = Some(new_expires);
                // schedule next tick to just before expiry.
                let next = new_expires - lead;
                let next = next.max(Instant::now() + Duration::from_secs(1));

                // Best-effort revoke of the previous lease (don't fail the sink on it).
                if let Some(prev) = self.lease_id.take() {
                    if prev != issued.lease_id {
                        let arc2 = arc.clone();
                        tokio::spawn(async move {
                            let _ = arc2.revoke_lease(&prev).await;
                        });
                    }
                }
                (rendered, next, Some(issued.lease_id))
            }
        };

        let changed = self.last_rendered.as_deref() != Some(rendered.as_str());
        if changed {
            write_atomic(&self.cfg.output_path, &rendered, parse_mode(&self.cfg.id, &self.cfg.mode)?)
                .await
                .map_err(|e| SinkError::OutputWrite {
                    sink: self.cfg.id.clone(),
                    source: e,
                })?;
            self.last_rendered = Some(rendered);
            if let Some(oc) = &self.cfg.on_change {
                trigger_on_change(oc).await?;
            }
        }

        if let Some(id) = new_lease_id {
            self.lease_id = Some(id);
        }

        Ok(TickOutcome { changed, next_tick_at })
    }
}

fn parse_mode(sink: &str, mode: &str) -> Result<u32, SinkError> {
    // Tolerate "0640", "640", "0o640".
    let stripped = mode.trim_start_matches("0o").trim_start_matches('0');
    if stripped.is_empty() {
        return Ok(0o600);
    }
    u32::from_str_radix(stripped, 8).map_err(|e| SinkError::InvalidMode {
        sink: sink.into(),
        mode: mode.into(),
        reason: e.to_string(),
    })
}

/// Write `content` to `path` atomically (write to temp + rename) with the desired mode.
async fn write_atomic(path: &Path, content: &str, mode: u32) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            tokio::fs::create_dir_all(parent).await?;
        }
    }
    // Temp file in the same directory so rename is atomic on POSIX.
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf).unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let file_name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "arc-agent.out".into());
    let tmp = dir.join(format!(".{}.tmp", file_name));

    let mut f = tokio::fs::File::create(&tmp).await?;
    f.write_all(content.as_bytes()).await?;
    f.sync_all().await?;
    drop(f);
    let perm = std::fs::Permissions::from_mode(mode);
    tokio::fs::set_permissions(&tmp, perm).await?;
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}
