/**
 * OpenTelemetry tracing bootstrap. Initialized **before** the Nest app via
 * `setupTelemetry()` from `main.ts` — auto-instrumentations have to wrap require() before
 * `@nestjs/core` and its transitive deps load, otherwise they don't see the wrapped
 * symbols.
 *
 * Gating: the SDK only starts when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Without it the
 * function is a no-op so dev / test boots don't pay the SDK cost. Production deployments
 * set the endpoint (e.g. `http://otel-collector:4318`) and pick up traces automatically.
 *
 * What gets instrumented (via `getNodeAutoInstrumentations`): HTTP server + outgoing
 * fetch/undici, Express (Nest's adapter), pg + sqlite drivers, pino, and dns. Each can
 * be turned off via `OTEL_NODE_DISABLED_INSTRUMENTATIONS` per the spec.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

let sdk: NodeSDK | null = null;

/**
 * Initialize OTel tracing if `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Returns the SDK or
 * `null` for "not configured / disabled". Idempotent.
 */
export function setupTelemetry(): NodeSDK | null {
  if (sdk) return sdk;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return null;

  // Verbose OTel diag is opt-in via env to avoid noise in production logs.
  if (process.env.OTEL_LOG_LEVEL === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const serviceName = process.env.OTEL_SERVICE_NAME ?? "arc-server";
  const serviceVersion = process.env.OTEL_SERVICE_VERSION ?? "0.0.0";

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    traceExporter: new OTLPTraceExporter({
      url: endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/+$/, "")}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Pino is already wired through nestjs-pino; the OTel pino plugin just enriches
        // log records with trace_id/span_id. Cheap, useful for correlating logs ↔ traces.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  return sdk;
}

/** Shut the SDK down — call from a SIGTERM handler so spans drain before exit. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
}
