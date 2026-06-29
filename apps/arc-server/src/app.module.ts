import { Module } from "@nestjs/common";
import { TypeOrmModule, type TypeOrmModuleOptions } from "@nestjs/typeorm";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "node:crypto";
import { entities } from "./database/entities";
import { InitSchema1717200000000 } from "./migrations/1717200000000-init-schema";
import { GrantsSchema1717300000000 } from "./migrations/1717300000000-grants-schema";
import { PasskeySchema1717400000000 } from "./migrations/1717400000000-passkey-schema";
import { GrantsGroupsSchema1717500000000 } from "./migrations/1717500000000-grants-groups-schema";
import { AttachmentsSchema1717600000000 } from "./migrations/1717600000000-attachments-schema";
import { DeviceHybridKey1717700000000 } from "./migrations/1717700000000-device-hybrid-key";
import { VaultUi1717800000000 } from "./migrations/1717800000000-vault-ui";
import { AgentIdentity1717900000000 } from "./migrations/1717900000000-agent-identity";
import { AgentTasksIntents1718000000000 } from "./migrations/1718000000000-agent-tasks-intents";
import { PendingApprovals1718100000000 } from "./migrations/1718100000000-pending-approvals";
import { SigningRecovery1718200000000 } from "./migrations/1718200000000-signing-recovery";
import { ItemShares1718300000000 } from "./migrations/1718300000000-item-shares";
import { AgentIntentDigestUnique1718500000000 } from "./migrations/1718500000000-agent-intent-digest-unique";
import { AgentTokenEpoch1718600000000 } from "./migrations/1718600000000-agent-token-epoch";
import { WorkflowsSchema1718700000000 } from "./migrations/1718700000000-workflows-schema";
import { VaultLeasesSchema1718800000000 } from "./migrations/1718800000000-vault-leases-schema";
import { VaultItemVersionsSchema1718900000000 } from "./migrations/1718900000000-vault-item-versions-schema";
import { AgentsModule } from "./agents/agents.module";
import { AuthModule } from "./auth/auth.module";
import { AuthMethodsModule } from "./auth-methods/auth-methods.module";
import { EnginesModule } from "./engines/engines.module";
import { GrantsModule } from "./grants/grants.module";
import { ObservabilityModule } from "./observability/observability.module";
import { PluginsAdminModule } from "./plugins/plugins-admin.module";
import { PluginsModule } from "./plugins/plugins.module";
import { VaultModule } from "./vault/vault.module";
import { WorkflowsModule } from "./workflows/workflows.module";

const migrations = [
  InitSchema1717200000000,
  GrantsSchema1717300000000,
  PasskeySchema1717400000000,
  GrantsGroupsSchema1717500000000,
  AttachmentsSchema1717600000000,
  DeviceHybridKey1717700000000,
  VaultUi1717800000000,
  AgentIdentity1717900000000,
  AgentTasksIntents1718000000000,
  PendingApprovals1718100000000,
  SigningRecovery1718200000000,
  ItemShares1718300000000,
  AgentIntentDigestUnique1718500000000,
  AgentTokenEpoch1718600000000,
  WorkflowsSchema1718700000000,
  VaultLeasesSchema1718800000000,
  VaultItemVersionsSchema1718900000000,
];

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
    ObservabilityModule,
    AuthModule,
    GrantsModule,
    VaultModule,
    // AuthMethodsModule must precede EnginesModule: its POST /v1/auth/<mount>/login route has
    // to register ahead of the engines `/v1/*` catch-all (and it intentionally doesn't import
    // EnginesModule, so it isn't pulled in transitively first).
    AuthMethodsModule,
    // PluginsAdminModule (ADR-009) must precede EnginesModule for the same reason: its
    // POST/DELETE /v1/sys/plugins/mounts routes need to register ahead of the engines
    // `/v1/*` catch-all. It intentionally doesn't import PluginsModule directly — it gets
    // PluginsService via PluginsModule's @Global() registration, so the transitive
    // EnginesModule dep stays in PluginsModule's slot below.
    PluginsAdminModule,
    EnginesModule,
    // WorkflowsModule must register before AgentsModule so AgentsModule can inject
    // WorkflowExecutorService into AgentTasksService. Controller routes (`/vaults/:id/workflows`)
    // sit under their own path and don't conflict with the `/v1/*` catch-all.
    WorkflowsModule,
    // AgentsModule imports EnginesModule (for the shared lease registry), so it must come
    // *after* EnginesModule here — otherwise EnginesModule resolves transitively at the
    // agents position and its `/v1/*` catch-all would register ahead of `/v1/auth/*`.
    AgentsModule,
    PluginsModule,
  ],
})
export class AppModule {}
