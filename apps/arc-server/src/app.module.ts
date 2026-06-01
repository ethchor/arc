import { Module } from "@nestjs/common";
import { TypeOrmModule, type TypeOrmModuleOptions } from "@nestjs/typeorm";
import { entities } from "./database/entities";
import { InitSchema1717200000000 } from "./migrations/1717200000000-init-schema";
import { AuthModule } from "./auth/auth.module";
import { VaultModule } from "./vault/vault.module";

const migrations = [InitSchema1717200000000];

/**
 * Postgres when DATABASE_URL is set (production); otherwise an in-memory sql.js database
 * (dev/test only — not persisted).
 *
 * Production posture (NODE_ENV === 'production'): synchronize is OFF and migrations run
 * automatically on boot. Schema changes ship as new migration files in src/migrations/.
 * In other environments synchronize stays on for fast iteration.
 */
export function buildDataSourceOptions(): TypeOrmModuleOptions {
  const url = process.env.DATABASE_URL;
  const isProd = process.env.NODE_ENV === "production";
  if (url) {
    return {
      type: "postgres",
      url,
      entities,
      migrations,
      // Prod: migrations are the only schema authority. Dev: synchronize is fine and
      // skips the migration runner entirely so it doesn't try to insert into
      // `migrations` while the schema is changing under us.
      synchronize: !isProd,
      migrationsRun: isProd,
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
  imports: [TypeOrmModule.forRoot(buildDataSourceOptions()), AuthModule, VaultModule],
})
export class AppModule {}
