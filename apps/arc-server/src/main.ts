import "reflect-metadata";
// OTel must be initialized BEFORE the Nest app + its transitive deps are required,
// otherwise the auto-instrumentations don't see the modules to wrap. The function is a
// no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so dev / test boots don't pay the
// SDK cost.
import { setupTelemetry, shutdownTelemetry } from "./observability/telemetry";
setupTelemetry();

import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";

async function bootstrap() {
  // bufferLogs holds Nest's startup logs until the pino Logger is wired so the boot
  // lines come out in the same JSON shape (with request-id, level, time) as every
  // request log.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet()); // security response headers (HSTS, nosniff, frameguard, ...)
  // Raise the JSON body limit to fit an encrypted attachment (≤ 25 MiB ciphertext,
  // base64-inflated to ~34 MiB; round up to 40 MiB for headroom). The per-attachment cap
  // is enforced in code (`VaultService.uploadAttachment`) — this only sets the parser's
  // ceiling.
  app.use(json({ limit: "40mb" }));
  app.use(urlencoded({ extended: true, limit: "40mb" }));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:3002,tauri://localhost").split(","),
  });

  // Drain spans + flush metrics on graceful shutdown so a SIGTERM during a deploy
  // doesn't lose the last few seconds of traces.
  app.enableShutdownHooks();
  process.on("SIGTERM", () => void shutdownTelemetry());
  process.on("SIGINT", () => void shutdownTelemetry());

  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port);
  app.get(Logger).log(`arc-vault API listening on :${port}`, "Bootstrap");
}

void bootstrap();
