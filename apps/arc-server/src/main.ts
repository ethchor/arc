import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";

async function bootstrap() {
  // bufferLogs holds Nest's startup logs until the pino Logger is wired so the boot
  // lines come out in the same JSON shape (with request-id, level, time) as every
  // request log.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet()); // security response headers (HSTS, nosniff, frameguard, ...)
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:3000,tauri://localhost").split(","),
  });
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;
  await app.listen(port);
  app.get(Logger).log(`arc-vault API listening on :${port}`, "Bootstrap");
}

void bootstrap();
