/**
 * Standalone DataSource for the TypeORM CLI (used by the `migration:generate` /
 * `migration:run` / `migration:revert` scripts). NestJS doesn't need this file — its
 * own DataSource is built in `app.module.ts`. We keep the two in sync by sharing the
 * same `entities` list and the same migrations directory.
 *
 * Usage (e.g. when an entity changes):
 *
 *   DATABASE_URL=postgres://user:pw@localhost/arc pnpm --filter @arc/server \
 *     migration:generate src/migrations/<name>
 *
 *   DATABASE_URL=...                                pnpm --filter @arc/server \
 *     migration:run
 */
import "reflect-metadata";
import { DataSource } from "typeorm";
import { entities } from "./entities";
import { InitSchema1717200000000 } from "../migrations/1717200000000-init-schema";
import { GrantsSchema1717300000000 } from "../migrations/1717300000000-grants-schema";
import { PasskeySchema1717400000000 } from "../migrations/1717400000000-passkey-schema";
import { GrantsGroupsSchema1717500000000 } from "../migrations/1717500000000-grants-groups-schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("typeorm.config.ts: DATABASE_URL is required for CLI migration commands");
}

export default new DataSource({
  type: "postgres",
  url,
  entities,
  migrations: [
    InitSchema1717200000000,
    GrantsSchema1717300000000,
    PasskeySchema1717400000000,
    GrantsGroupsSchema1717500000000,
  ],
});
