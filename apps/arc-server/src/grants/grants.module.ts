import { Global, Logger, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CachingPolicyStore, type DefaultMode, type MutablePolicyStore } from "@arc/grants";
import { PolicyAttachmentEntity, PolicyEntity } from "../database/entities";
import { CapabilityGuard } from "./capability.guard";
import { GrantsController } from "./grants.controller";
import { GRANTS_DEFAULT_MODE, GrantsService, POLICY_STORE } from "./grants.service";
import { TypeOrmPolicyStore } from "./typeorm-policy-store";

/** Token under which the raw (un-cached) TypeORM store is provided, so it can be wrapped. */
const TYPEORM_POLICY_STORE = Symbol("TYPEORM_POLICY_STORE");

/**
 * Read `ARC_DEFAULT_POLICY` once at boot. `"allow"` (the default) keeps dev/test working
 * while ACL admin tooling lands; production deployments should set `"deny"` once they have
 * the policy bootstrap they need (see `ARC_ROOT_USERS`).
 */
export function buildDefaultMode(): DefaultMode {
  const raw = (process.env.ARC_DEFAULT_POLICY ?? "allow").toLowerCase();
  if (raw === "deny") return "deny";
  if (raw !== "allow") {
    new Logger("GrantsModule").warn(
      `ARC_DEFAULT_POLICY=${raw} is not 'allow' or 'deny'; defaulting to 'allow'`,
    );
  }
  return "allow";
}

/**
 * Read `ARC_POLICY_CACHE_TTL_MS` at boot. Defaults to 30_000ms — a comfortable window for
 * read-heavy traffic without making attach/detach feel laggy (mutations invalidate
 * immediately so the wait only applies to direct DB edits). Set to 0 to disable caching
 * entirely (every `/v1` request goes through to the DB).
 */
export function buildCacheTtlMs(): number {
  const raw = process.env.ARC_POLICY_CACHE_TTL_MS;
  if (raw === undefined) return 30_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    new Logger("GrantsModule").warn(
      `ARC_POLICY_CACHE_TTL_MS=${raw} is not a non-negative number; defaulting to 30000`,
    );
    return 30_000;
  }
  return Math.floor(n);
}

/**
 * `@Global` so the engines + plugins controllers can `@UseGuards(JwtAuthGuard,
 * CapabilityGuard)` without re-importing this module. Per-controller registration is the
 * right level — a global `APP_GUARD` would run *before* the controller-level `JwtAuthGuard`,
 * so the capability guard wouldn't see `req.user`. `@UseGuards` respects the listed order,
 * so `JwtAuthGuard` populates `req.user` before `CapabilityGuard` reads it.
 *
 * `POLICY_STORE` is the `MutablePolicyStore` the service sees — a
 * {@link CachingPolicyStore} wrapping the Postgres-backed {@link TypeOrmPolicyStore}. The
 * cache eliminates the two indexed queries `CapabilityGuard` would otherwise do on every
 * `/v1/*` request; mutations through the wrapped store invalidate the right entries
 * immediately so admin edits are visible on the next read.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PolicyEntity, PolicyAttachmentEntity])],
  controllers: [GrantsController],
  providers: [
    { provide: GRANTS_DEFAULT_MODE, useFactory: buildDefaultMode },
    { provide: TYPEORM_POLICY_STORE, useClass: TypeOrmPolicyStore },
    {
      provide: POLICY_STORE,
      useFactory: (inner: MutablePolicyStore) =>
        new CachingPolicyStore({ store: inner, ttlMs: buildCacheTtlMs() }),
      inject: [TYPEORM_POLICY_STORE],
    },
    GrantsService,
    CapabilityGuard,
  ],
  exports: [GrantsService, CapabilityGuard],
})
export class GrantsModule {}
