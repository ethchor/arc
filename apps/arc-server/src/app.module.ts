import { Module } from "@nestjs/common";
import { TypeOrmModule, type TypeOrmModuleOptions } from "@nestjs/typeorm";
import { entities } from "./database/entities";
import { AuthModule } from "./auth/auth.module";
import { VaultModule } from "./vault/vault.module";

/**
 * Postgres when DATABASE_URL is set (production); otherwise an in-memory sql.js database
 * (dev/test only — not persisted). `synchronize` is enabled outside production; production
 * Postgres should run migrations instead.
 */
export function buildDataSourceOptions(): TypeOrmModuleOptions {
  const url = process.env.DATABASE_URL;
  if (url) {
    return {
      type: "postgres",
      url,
      entities,
      synchronize: process.env.NODE_ENV !== "production",
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
