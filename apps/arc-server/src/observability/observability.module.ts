import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { HttpMetricsInterceptor } from "./http-metrics.interceptor";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";

/**
 * `@Global` so any service (vault, engines, capability guard) can `@Inject(MetricsService)`
 * without re-importing this module. The `APP_INTERCEPTOR` registration wires the HTTP
 * timing interceptor across every route.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [MetricsService],
})
export class ObservabilityModule {}
