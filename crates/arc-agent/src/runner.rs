//! Long-running scheduler. Each sink has its own next-tick time; we sleep until the
//! soonest one. Sinks failing don't block other sinks — failures are logged with
//! `tracing::error!` and the failing sink reschedules with a backoff.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::arc::ArcClient;
use crate::sink::Sink;

pub struct Runner {
    pub arc: Arc<ArcClient>,
    pub sinks: Vec<Arc<Mutex<Sink>>>,
    pub error_backoff: Duration,
}

impl Runner {
    pub fn new(arc: Arc<ArcClient>, sinks: Vec<Sink>) -> Self {
        Self {
            arc,
            sinks: sinks.into_iter().map(|s| Arc::new(Mutex::new(s))).collect(),
            error_backoff: Duration::from_secs(15),
        }
    }

    /// Run one tick per sink immediately. Returns the next-tick map and surfaces the first
    /// error if every sink failed (which is the right signal for `arc-agent run --once` to
    /// exit non-zero).
    pub async fn tick_all(&self) -> RunOutcome {
        let mut outcomes = Vec::with_capacity(self.sinks.len());
        for sink in &self.sinks {
            let mut guard = sink.lock().await;
            let id = guard.cfg.id.clone();
            let result = guard.tick(&self.arc).await;
            match result {
                Ok(o) => {
                    tracing::info!(sink = %id, changed = o.changed, "ticked");
                    outcomes.push(SinkOutcome {
                        sink_id: id,
                        next_tick_at: o.next_tick_at,
                        changed: o.changed,
                        error: None,
                    });
                }
                Err(e) => {
                    let msg = e.to_string();
                    tracing::error!(sink = %id, error = %msg, "tick failed");
                    outcomes.push(SinkOutcome {
                        sink_id: id,
                        next_tick_at: Instant::now() + self.error_backoff,
                        changed: false,
                        error: Some(msg),
                    });
                }
            }
        }
        RunOutcome { sinks: outcomes }
    }

    /// Long-running mode. Sleeps until the next-tick of any sink, then re-runs that one.
    /// `shutdown` is checked between sleeps so SIGTERM can drain.
    pub async fn run_forever<F>(self, shutdown: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        // Initial pass — schedule everything.
        let initial = self.tick_all().await;
        let mut schedule = initial.sinks.into_iter().map(|s| (s.sink_id, s.next_tick_at)).collect::<Vec<_>>();
        tokio::pin!(shutdown);

        loop {
            // Choose the soonest next-tick.
            let now = Instant::now();
            let earliest = schedule.iter().min_by_key(|(_, t)| *t).map(|(_, t)| *t);
            let sleep_for = match earliest {
                Some(t) => t.saturating_duration_since(now).max(Duration::from_millis(100)),
                None => Duration::from_secs(60),
            };
            tokio::select! {
                () = &mut shutdown => {
                    tracing::info!("shutdown signal received");
                    return;
                }
                _ = tokio::time::sleep(sleep_for) => {}
            }

            // Run every sink whose next_tick_at is now in the past.
            let now = Instant::now();
            let due_ids: Vec<String> = schedule
                .iter()
                .filter(|(_, t)| *t <= now)
                .map(|(id, _)| id.clone())
                .collect();

            for sink in &self.sinks {
                let mut guard = sink.lock().await;
                if !due_ids.contains(&guard.cfg.id) {
                    continue;
                }
                let id = guard.cfg.id.clone();
                let next_tick = match guard.tick(&self.arc).await {
                    Ok(o) => {
                        tracing::info!(sink = %id, changed = o.changed, "ticked");
                        o.next_tick_at
                    }
                    Err(e) => {
                        tracing::error!(sink = %id, error = %e, "tick failed");
                        Instant::now() + self.error_backoff
                    }
                };
                for entry in schedule.iter_mut() {
                    if entry.0 == id {
                        entry.1 = next_tick;
                        break;
                    }
                }
            }
        }
    }
}

#[derive(Debug)]
pub struct SinkOutcome {
    pub sink_id: String,
    pub next_tick_at: Instant,
    pub changed: bool,
    pub error: Option<String>,
}

#[derive(Debug)]
pub struct RunOutcome {
    pub sinks: Vec<SinkOutcome>,
}

impl RunOutcome {
    pub fn any_failed(&self) -> bool {
        self.sinks.iter().any(|s| s.error.is_some())
    }
    pub fn all_failed(&self) -> bool {
        !self.sinks.is_empty() && self.sinks.iter().all(|s| s.error.is_some())
    }
}
