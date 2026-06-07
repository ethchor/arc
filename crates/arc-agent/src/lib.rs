//! Workload sidecar for arc. Reads a YAML config describing what secrets to fetch and where
//! to write them, then either runs once (init-container mode) or stays running and refreshes
//! before TTL (sidecar mode).
//!
//! See `src/config.rs` for the YAML schema and `bin/arc-agent` for the CLI.

pub mod arc;
pub mod config;
pub mod on_change;
pub mod runner;
pub mod sink;
pub mod template;
