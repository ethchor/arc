//! Post-render hooks. Two flavors, mutually exclusive per sink (validated in config):
//!
//!   - `command: ["sh", "-c", "systemctl reload app"]` — fork + exec, exit code is logged
//!   - `signal: SIGHUP` + `pid_file: /var/run/app.pid` — read pid, send signal

use std::path::Path;
use tokio::process::Command;

use crate::config::OnChange;

#[derive(Debug, thiserror::Error)]
pub enum OnChangeError {
    #[error("on_change: command failed to spawn: {0}")]
    Spawn(std::io::Error),
    #[error("on_change: command exited with status {0}")]
    NonZeroExit(i32),
    #[error("on_change: pid_file {path} read error: {source}")]
    PidRead {
        path: std::path::PathBuf,
        source: std::io::Error,
    },
    #[error("on_change: pid_file contained invalid pid: {0}")]
    InvalidPid(String),
    #[error("on_change: unsupported signal {0}")]
    UnknownSignal(String),
    #[error("on_change: kill({pid}, {sig}) failed: {source}")]
    KillFailed {
        pid: i32,
        sig: i32,
        source: std::io::Error,
    },
    #[error("on_change: misconfigured — neither `command` nor `signal`+`pid_file` provided")]
    Misconfigured,
}

pub async fn trigger_on_change(oc: &OnChange) -> Result<(), OnChangeError> {
    if let Some(cmd) = &oc.command {
        return run_command(cmd).await;
    }
    if let (Some(sig), Some(pid_file)) = (&oc.signal, &oc.pid_file) {
        return send_signal(sig, pid_file).await;
    }
    Err(OnChangeError::Misconfigured)
}

async fn run_command(cmd: &[String]) -> Result<(), OnChangeError> {
    let mut argv = cmd.iter();
    let exe = match argv.next() {
        Some(e) => e,
        None => return Err(OnChangeError::Misconfigured),
    };
    let status = Command::new(exe)
        .args(argv)
        .status()
        .await
        .map_err(OnChangeError::Spawn)?;
    if !status.success() {
        return Err(OnChangeError::NonZeroExit(status.code().unwrap_or(-1)));
    }
    Ok(())
}

async fn send_signal(name: &str, pid_file: &Path) -> Result<(), OnChangeError> {
    let pid_text = tokio::fs::read_to_string(pid_file)
        .await
        .map_err(|e| OnChangeError::PidRead {
            path: pid_file.to_path_buf(),
            source: e,
        })?;
    let pid: i32 = pid_text
        .trim()
        .parse()
        .map_err(|_| OnChangeError::InvalidPid(pid_text.trim().to_string()))?;
    let sig = signal_for_name(name)?;
    // SAFETY: libc::kill is the canonical signal send; valid pid + signal numbers.
    let rc = unsafe { libc::kill(pid, sig) };
    if rc != 0 {
        return Err(OnChangeError::KillFailed {
            pid,
            sig,
            source: std::io::Error::last_os_error(),
        });
    }
    Ok(())
}

fn signal_for_name(name: &str) -> Result<i32, OnChangeError> {
    let canonical = name.trim().to_uppercase();
    Ok(match canonical.as_str() {
        "SIGHUP" | "HUP" => libc::SIGHUP,
        "SIGUSR1" | "USR1" => libc::SIGUSR1,
        "SIGUSR2" | "USR2" => libc::SIGUSR2,
        "SIGTERM" | "TERM" => libc::SIGTERM,
        "SIGINT" | "INT" => libc::SIGINT,
        _ => return Err(OnChangeError::UnknownSignal(name.to_string())),
    })
}
