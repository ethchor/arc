import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { MetricsService } from "./metrics.service";

/**
 * Global interceptor — records `arc_http_request_duration_seconds` per request. Route
 * label uses the Express route pattern (`/vaults/:id/items`) not the literal path so
 * cardinality stays bounded (one bucket per route, not per `:id`).
 *
 * Why an interceptor and not the pino-http access log? pino captures the *line*; this
 * captures the *histogram bucket* that Prometheus aggregates. They serve different
 * dashboards — keep both.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const http = context.switchToHttp();
    const req = http.getRequest<{ method: string; route?: { path: string }; url: string }>();
    const res = http.getResponse<{ statusCode: number }>();

    return next.handle().pipe(
      tap({
        next: () => this.record(req, res, start),
        error: () => this.record(req, res, start),
      }),
    );
  }

  private record(
    req: { method: string; route?: { path: string }; url: string },
    res: { statusCode: number },
    start: bigint,
  ): void {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    // Use the matched route path (low cardinality) when available; fall back to "/unmatched".
    const route = req.route?.path ?? "/unmatched";
    this.metrics.httpRequest
      .labels(req.method, route, String(res.statusCode))
      .observe(seconds);
  }
}
