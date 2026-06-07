//! arc-agent CLI.
//!
//! Two run modes:
//!   - `arc-agent run --config /etc/arc-agent.yaml --once`  — fetch, render, exit. For
//!     init containers.
//!   - `arc-agent run --config /etc/arc-agent.yaml`         — fetch, render, then schedule
//!     refreshes. For long-running sidecars.

use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};

use arc_agent::arc::{ArcClient, FileTokenSource};
use arc_agent::config::{AuthConfig, Config};
use arc_agent::runner::Runner;
use arc_agent::sink::Sink;

#[derive(Debug, Parser)]
#[command(name = "arc-agent", version, about = "Workload sidecar for arc.")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Run the agent (one pass or stay running).
    Run {
        /// Path to the YAML config file.
        #[arg(short, long, env = "ARC_AGENT_CONFIG")]
        config: PathBuf,
        /// Exit after one full pass over every sink. Useful for init containers.
        #[arg(long)]
        once: bool,
    },
    /// Validate a config file without contacting arc-server.
    Validate {
        #[arg(short, long)]
        config: PathBuf,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .init();

    let cli = Cli::parse();
    let exit_code = match cli.cmd {
        Cmd::Run { config, once } => run(config, once).await,
        Cmd::Validate { config } => validate(config),
    };
    std::process::exit(exit_code);
}

fn validate(path: PathBuf) -> i32 {
    let cfg = match Config::load_from_file(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[arc-agent] config error: {e}");
            return 2;
        }
    };
    if let Err(e) = cfg.validate() {
        eprintln!("[arc-agent] config error: {e}");
        return 2;
    }
    println!("[arc-agent] config OK ({} sinks)", cfg.sinks.len());
    0
}

async fn run(path: PathBuf, once: bool) -> i32 {
    let cfg = match Config::load_from_file(&path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[arc-agent] config error: {e}");
            return 2;
        }
    };
    if let Err(e) = cfg.validate() {
        eprintln!("[arc-agent] config error: {e}");
        return 2;
    }

    let token_source: Arc<dyn arc_agent::arc::TokenSource> = match &cfg.arc.auth {
        AuthConfig::Kubernetes { token_file, .. } => Arc::new(FileTokenSource {
            path: token_file
                .clone()
                .unwrap_or_else(|| PathBuf::from("/var/run/secrets/kubernetes.io/serviceaccount/token")),
        }),
    };
    let client = Arc::new(ArcClient::new(
        cfg.arc.server.clone(),
        cfg.arc.auth.clone(),
        token_source,
    ));

    // Cold-start sanity check.
    if let Err(e) = client.login().await {
        eprintln!("[arc-agent] login failed: {e}");
        return 1;
    }
    tracing::info!(server = %cfg.arc.server, sinks = cfg.sinks.len(), "logged in, starting");

    let sinks: Vec<Sink> = cfg.sinks.into_iter().map(Sink::new).collect();
    let runner = Runner::new(client.clone(), sinks);

    if once {
        let outcome = runner.tick_all().await;
        return if outcome.any_failed() { 1 } else { 0 };
    }

    let shutdown = async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        let mut int = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
            .expect("install SIGINT handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    };

    runner.run_forever(shutdown).await;
    0
}
