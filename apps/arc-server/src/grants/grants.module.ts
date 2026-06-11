import { Global, Logger, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CachingPolicyStore, type DefaultMode, type MutablePolicyStore } from "@arc/grants";
import {
  PolicyAttachmentEntity,
  PolicyEntity,
  PolicyGroupAttachmentEntity,
  PolicyGroupMembershipEntity,
} from "../database/entities";
import { CapabilityGuard } from "./capability.guard";
import { GrantsController } from "./grants.controller";
import { GroupsController } from "./groups.controller";
import { GRANTS_DEFAULT_MODE, GrantsService, POLICY_STORE } from "./grants.service";
import { TypeOrmPolicyStore } from "./typeorm-policy-store";

/** Token under which the raw (un-cached) TypeORM store is provided, so it can be wrapped. */
const TYPEORM_POLICY_STORE = Symbol("TYPEORM_POLICY_STORE");

/**
 * Read `ARC_DEFAULT_POLICY` once at boot — the Engine-A fail-open vs fail-closed posture
 * for a subject with no attached policy.
 *
 * Contract:
 *  - explicit `deny` / `allow` always wins (case-insensitive), in any environment;
 *  - **unset → fail closed (`deny`) when `NODE_ENV=production`**, else `allow` for dev/test
 *    ergonomics while ACL admin tooling is set up;
 *  - an invalid value falls back to the same environment-appropriate default and warns.
 *
 * This is the difference between "a production deploy that forgot the env var locks Engine-A
 * down until an admin is bootstrapped (`ARC_ROOT_USERS`)" and the old behavior — "that same
 * deploy silently grants every authenticated user full Engine-A authority." Fail closed.
 */
export function buildDefaultMode(): DefaultMode {
  const isProd = process.env.NODE_ENV === "production";
  const raw = process.env.ARC_DEFAULT_POLICY?.toLowerCase();
  if (raw === "deny") return "deny";
  if (raw === "allow") return "allow";

  const fallback: DefaultMode = isProd ? "deny" : "allow";
  const log = new Logger("GrantsModule");
  if (raw !== undefined) {
    log.warn(`ARC_DEFAULT_POLICY=${raw} is not 'allow' or 'deny'; defaulting to '${fallback}'`);
  } else if (isProd) {
    // Make the implicit fail-closed legible: an operator who forgot the env var needs to
    // know *why* Engine-A is locked down and how to open it deliberately.
    log.log(
      "ARC_DEFAULT_POLICY unset with NODE_ENV=production → defaulting to 'deny' (fail-closed). " +
        "Set ARC_ROOT_USERS to bootstrap an admin, or ARC_DEFAULT_POLICY=allow to opt out.",
    );
  }
  return fallback;
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
  imports: [
    TypeOrmModule.forFeature([
      PolicyEntity,
      PolicyAttachmentEntity,
      PolicyGroupMembershipEntity,
      PolicyGroupAttachmentEntity,
    ]),
  ],
  controllers: [GrantsController, GroupsController],
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
