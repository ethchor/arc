import { Controller, Get, Header, Optional, Res } from "@nestjs/common";
import { EnginesService } from "../engines/engines.service";
import { MetricsService } from "./metrics.service";

/** Narrow `Response` shape so we don't pull a workspace dep on `@types/express`. */
interface ResLike {
  send(body: string): void;
}

/**
 * Prometheus scrape endpoint. Intentionally **un-guarded** — Prometheus scrapes don't
 * authenticate with bearer tokens; access control lives at the network layer (the metrics
 * port is bound to the internal interface in production deployments). If a deployment
 * wants auth, it puts an nginx/envoy front in the way.
 *
 * Path: `/metrics`. Standard 0.0.4 exposition format with the proper content type.
 *
 * EnginesService is injected as `@Optional()` because ObservabilityModule loads before
 * EnginesModule and we don't want a circular DI graph; the active-leases gauge falls
 * back to "skip the snapshot" when EnginesService isn't available yet.
 */
@Controller("metrics")
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Optional() private readonly engines?: EnginesService,
  ) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async scrape(@Res() res: ResLike): Promise<void> {
    // Sample the LeaseManager *just before* rendering so the gauge is point-in-time
    // current. Reset the gauge first so engine types whose count dropped to 0 don't
    // hold their stale value forever.
    if (this.engines) {
      this.metrics.activeLeases.reset();
      for (const [engine, count] of this.engines.activeLeasesByEngine()) {
        this.metrics.activeLeases.labels(engine).set(count);
      }
    }
    const body = await this.metrics.render();
    res.send(body);
  }
}
