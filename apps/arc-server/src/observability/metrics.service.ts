import { Injectable } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Single Prometheus registry for the whole arc-server process. `collectDefaultMetrics`
 * adds Node + process metrics (CPU, memory, event loop lag, GC). We register a small set
 * of arc-specific counters/histograms on top: vault ops, lease lifecycle, ACL decisions,
 * plugin issue calls.
 *
 * Service is constructed once at module bootstrap. Counters are incremented from the
 * business-logic services directly (vault.service, engines.service, capability.guard) —
 * direct `inc()` calls keep the surface tiny and avoid hidden decorator magic.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly vaultOps: Counter<"op" | "result">;
  readonly leases: Counter<"engine" | "op">;
  readonly aclDecisions: Counter<"decision" | "reason">;
  readonly pluginIssue: Counter<"plugin" | "role" | "result">;
  readonly httpRequest: Histogram<"method" | "route" | "status">;
  readonly activeLeases: Gauge<"engine">;

  constructor() {
    // App version + git-sha-like info as a single gauge so dashboards can show "we're
    // running this build" without scraping arbitrary env. Static value = 1.
    collectDefaultMetrics({ register: this.registry, prefix: "arc_" });

    this.vaultOps = new Counter({
      name: "arc_vault_operations_total",
      help: "Engine-B vault operations by type and outcome.",
      labelNames: ["op", "result"] as const,
      registers: [this.registry],
    });

    this.leases = new Counter({
      name: "arc_leases_total",
      help: "Lease lifecycle events. `op` is one of issue / renew / revoke / expire.",
      labelNames: ["engine", "op"] as const,
      registers: [this.registry],
    });

    this.aclDecisions = new Counter({
      name: "arc_acl_decisions_total",
      help: "CapabilityGuard decisions on /v1/*. `reason` mirrors the PolicyEngine's detailed reason.",
      labelNames: ["decision", "reason"] as const,
      registers: [this.registry],
    });

    this.pluginIssue = new Counter({
      name: "arc_plugin_issue_total",
      help: "SecretsPlugin issue() calls. `result` is success / error.",
      labelNames: ["plugin", "role", "result"] as const,
      registers: [this.registry],
    });

    this.httpRequest = new Histogram({
      name: "arc_http_request_duration_seconds",
      help: "Server-side HTTP request latency.",
      labelNames: ["method", "route", "status"] as const,
      // 1ms → 8s; covers fast cache hits to slow OpenBao round-trips.
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],
      registers: [this.registry],
    });

    this.activeLeases = new Gauge({
      name: "arc_active_leases",
      help: "Active (not-yet-expired, not-revoked) leases per engine, sampled from LeaseManager.",
      labelNames: ["engine"] as const,
      registers: [this.registry],
    });
  }

  /** Snapshot of the registry — used by the `/metrics` controller. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
