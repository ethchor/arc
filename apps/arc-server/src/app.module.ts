import { Module } from "@nestjs/common";
import { TypeOrmModule, type TypeOrmModuleOptions } from "@nestjs/typeorm";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "node:crypto";
import { entities } from "./database/entities";
import { InitSchema1717200000000 } from "./migrations/1717200000000-init-schema";
import { AuthModule } from "./auth/auth.module";
import { EnginesModule } from "./engines/engines.module";
import { VaultModule } from "./vault/vault.module";

const migrations = [InitSchema1717200000000];

/**
 * pino-http config: structured JSON in prod (one log line per request, correlation id
 * propagated as `x-request-id`), human-friendly pretty-print in dev. Health-style noisy
 * paths could be silenced here once they exist.
 */
function buildLoggerOptions() {
  const isProd = process.env.NODE_ENV === "production";
  return {
    pinoHttp: {
      level: process.env.LOG_LEVEL ?? (isProd ? "info" : "debug"),
      // Honor an upstream request id (load balancer / proxy) and fall back to a fresh
      // UUID per request. The id is auto-injected into every log line emitted within
      // the request scope.
      genReqId: (
        req: { headers: Record<string, string | string[] | undefined> },
        res: { setHeader: (k: string, v: string) => void },
      ) => {
        const existing = req.headers["x-request-id"];
        const id = typeof existing === "string" && existing.length > 0 ? existing : randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      // Strip ciphertext / wrap envelopes from request bodies before they reach the log
      // sink — they aren't useful for debugging and they bloat the volume.
      serializers: {
        req(req: { method: string; url: string; id?: string }) {
          return { method: req.method, url: req.url, id: req.id };
        },
      },
      ...(isProd
        ? {}
        : {
            transport: {
              target: "pino-pretty",
              options: { singleLine: true, colorize: true, translateTime: "SYS:HH:MM:ss.l" },
            },
          }),
    },
  };
}

/**
 * Three data-source profiles, each chosen explicitly by environment:
 *
 * - `production`: requires `DATABASE_URL`. `synchronize` is hard-off; migrations are the
 *   only schema authority. Boot fails loudly if `DATABASE_URL` is missing — we'd rather
 *   refuse to start than silently fall back to an in-memory store and lose every write.
 * - `development` with `DATABASE_URL`: real Postgres, `synchronize: true` so entity
 *   tweaks land instantly. No migrations run (avoids fighting the synchronize path).
 * - `development` / `test` without `DATABASE_URL`: sql.js, in-memory, `synchronize: true`.
 *   This is what `pnpm --filter @arc/server test` uses and what `npm run start` falls
 *   back to so a fresh contributor can hack without a Postgres install.
 */
export function buildDataSourceOptions(): TypeOrmModuleOptions {
  const url = process.env.DATABASE_URL;
  const env = process.env.NODE_ENV ?? "development";

  if (env === "production") {
    if (!url) {
      throw new Error(
        "DATABASE_URL is required when NODE_ENV=production. Set it to a Postgres URL " +
          "(synchronize is hard-off in prod; migrations run automatically on boot).",
      );
    }
    return {
      type: "postgres",
      url,
      entities,
      migrations,
      synchronize: false,
      migrationsRun: true,
    };
  }

  if (url) {
    return {
      type: "postgres",
      url,
      entities,
      migrations,
      synchronize: true,
      migrationsRun: false,
    };
  }

  return {
    type: "sqljs",
    autoSave: false,
    entities,
    synchronize: true,
  };
}

@Module({
  imports: [
    LoggerModule.forRoot(buildLoggerOptions()),
    TypeOrmModule.forRoot(buildDataSourceOptions()),
    AuthModule,
    VaultModule,
    EnginesModule,
  ],
})
export class AppModule {}
