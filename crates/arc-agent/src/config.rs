//! YAML config schema for arc-agent. One file describes how to authenticate, what to fetch,
//! where to write it, and what to do when secrets change.
//!
//! ```yaml
//! arc:
//!   server: https://arc:3001
//!   auth:
//!     type: kubernetes
//!     mount: kubernetes      # defaults to "kubernetes"
//!     role: web              # role configured on that mount
//!     # token_file defaults to the in-cluster SA token path
//!
//! sinks:
//!   - id: db-config
//!     template_file: /etc/arc/templates/db.conf.tmpl
//!     output_path: /etc/app/db.conf
//!     # File mode for the rendered file (octal). Default 0600.
//!     mode: "0640"
//!     source:
//!       type: kv_get
//!       mount: secret          # defaults to "secret"
//!       path: app/prod/db
//!     refresh_interval_seconds: 300
//!     on_change:
//!       command: ["/usr/local/bin/reload-config"]
//!
//!   - id: aws-creds
//!     template_file: /etc/arc/templates/aws.tmpl
//!     output_path: /etc/app/aws.env
//!     source:
//!       type: dynamic_creds
//!       mount: aws
//!       role: deployer
//!       ttl_seconds: 900
//!     refresh_lead_seconds: 60
//!     on_change:
//!       signal: SIGHUP
//!       pid_file: /var/run/app.pid
//! ```

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub arc: ArcConfig,
    #[serde(default)]
    pub sinks: Vec<SinkConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArcConfig {
    pub server: String,
    pub auth: AuthConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthConfig {
    /// Present a Kubernetes ServiceAccount token to `POST /v1/auth/<mount>/login`.
    Kubernetes {
        #[serde(default = "default_k8s_mount")]
        mount: String,
        role: String,
        /// Override the default `/var/run/secrets/...` location.
        #[serde(default)]
        token_file: Option<PathBuf>,
    },
}

fn default_k8s_mount() -> String {
    "kubernetes".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SinkConfig {
    pub id: String,
    pub template_file: PathBuf,
    pub output_path: PathBuf,
    /// Octal mode string, e.g. "0640". Default "0600".
    #[serde(default = "default_mode")]
    pub mode: String,
    pub source: SourceConfig,
    /// For KV sinks: how often to re-read and re-render. Default 300.
    #[serde(default = "default_refresh_interval")]
    pub refresh_interval_seconds: u64,
    /// For dynamic-credential sinks: how many seconds before lease expiry to re-issue.
    #[serde(default = "default_refresh_lead")]
    pub refresh_lead_seconds: u64,
    #[serde(default)]
    pub on_change: Option<OnChange>,
}

fn default_mode() -> String {
    "0600".to_string()
}

fn default_refresh_interval() -> u64 {
    300
}

fn default_refresh_lead() -> u64 {
    60
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SourceConfig {
    /// Read a versioned KV v2 secret.
    KvGet {
        #[serde(default = "default_kv_mount")]
        mount: String,
        path: String,
        #[serde(default)]
        version: Option<u64>,
    },
    /// Issue a dynamic credential from a plugin mount.
    DynamicCreds {
        mount: String,
        role: String,
        #[serde(default)]
        ttl_seconds: Option<u64>,
    },
}

fn default_kv_mount() -> String {
    "secret".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnChange {
    /// Execute this command after a successful write.
    #[serde(default)]
    pub command: Option<Vec<String>>,
    /// Or send a signal to the PID in `pid_file`.
    #[serde(default)]
    pub signal: Option<String>,
    #[serde(default)]
    pub pid_file: Option<PathBuf>,
}

impl Config {
    pub fn parse(yaml: &str) -> Result<Self, serde_yaml::Error> {
        serde_yaml::from_str(yaml)
    }

    pub fn load_from_file(path: &std::path::Path) -> Result<Self, ConfigError> {
        let yaml = std::fs::read_to_string(path)
            .map_err(|e| ConfigError::Io(path.to_path_buf(), e))?;
        Self::parse(&yaml).map_err(ConfigError::Parse)
    }

    /// Best-effort structural validation beyond what serde catches.
    pub fn validate(&self) -> Result<(), ConfigError> {
        let mut seen = std::collections::HashSet::new();
        for s in &self.sinks {
            if !seen.insert(&s.id) {
                return Err(ConfigError::DuplicateSinkId(s.id.clone()));
            }
            if s.refresh_interval_seconds == 0 {
                return Err(ConfigError::InvalidValue(format!(
                    "sink {}: refresh_interval_seconds must be > 0",
                    s.id
                )));
            }
            if let Some(oc) = &s.on_change {
                let has_cmd = oc.command.as_ref().is_some_and(|c| !c.is_empty());
                let has_sig = oc.signal.is_some() && oc.pid_file.is_some();
                if !has_cmd && !has_sig {
                    return Err(ConfigError::InvalidValue(format!(
                        "sink {}: on_change must set either `command` or both `signal` + `pid_file`",
                        s.id
                    )));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("config: failed to read {0}: {1}")]
    Io(PathBuf, std::io::Error),
    #[error("config: parse failed: {0}")]
    Parse(#[from] serde_yaml::Error),
    #[error("config: duplicate sink id {0}")]
    DuplicateSinkId(String),
    #[error("config: {0}")]
    InvalidValue(String),
}
