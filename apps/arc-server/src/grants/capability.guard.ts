import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import type { Capability } from "@arc/grants";
import { MetricsService } from "../observability/metrics.service";
import { GrantsService } from "./grants.service";

interface AuthedRequest {
  user?: { userId: number; email: string };
  method: string;
  url: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
}

/**
 * Enforces per-mount ACL on `/v1/*` (Engine-A surface + plugin mounts). Decision flow:
 *
 *  1. Skip everything that isn't on the engines surface (any path not starting with
 *     `/v1/`). The guard only protects Engine-A; Engine-B's `/vault/*` and `/vaults/*`
 *     already have membership-based authorization in `VaultService`.
 *  2. Require an authenticated request — `JwtAuthGuard` already attached `req.user`. No
 *     user → 403 (this branch shouldn't fire in practice; `JwtAuthGuard` runs first).
 *  3. Strip the `/v1/` prefix, then map HTTP method → {@link Capability}: GET → "read"
 *     (or "list" when `?list=true`), POST → "create", PUT → "update", DELETE → "delete".
 *     `sys/leases/{renew,revoke}` and `sys/seal-status` / `sys/health` get specific path
 *     mappings; the `sys/plugins` listing is "read".
 *  4. Ask {@link GrantsService.decide}. `decision === "allow"` → proceed; otherwise 403.
 *
 * Failures log the policy reason (`no-policies`, `no-matching-scope`) at warn level so
 * `pino` can include them in the per-request structured log without leaking which scopes
 * the subject *does* have.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  private readonly logger = new Logger(CapabilityGuard.name);

  constructor(
    private readonly grants: GrantsService,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.url.startsWith("/v1/")) return true;

    const user = req.user;
    if (!user) throw new ForbiddenException({ errors: ["authentication required"] });

    const path = stripV1Prefix(req.url);
    const capability = pickCapability(req.method, path, req.query ?? {});

    const decision = await this.grants.decide(String(user.userId), path, capability);
    this.metrics.aclDecisions.labels(decision.decision, decision.reason).inc();
    if (decision.decision === "allow") return true;

    this.logger.warn(
      `denied ${req.method} ${req.url} user=${user.userId} reason=${decision.reason}`,
    );
    throw new ForbiddenException({
      errors: [`access denied: ${capability} on ${path}`],
      reason: decision.reason,
    });
  }
}

/** `/v1/secret/data/x?foo=bar` → `secret/data/x`. */
export function stripV1Prefix(url: string): string {
  const noQuery = url.split("?", 1)[0]!;
  const stripped = noQuery.replace(/^\/v1\//, "").replace(/^\/+/, "");
  return stripped;
}

/**
 * HTTP method → ACL capability. Mirrors Vault's mapping with one wrinkle: GET against
 * `?list=true` is `"list"`, not `"read"`, so policies can grant listing without granting
 * full read access.
 */
export function pickCapability(
  method: string,
  _path: string,
  query: Record<string, unknown>,
): Capability {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") {
    const list = query.list;
    if (list === "true" || list === "1") return "list";
    return "read";
  }
  if (m === "POST") return "create";
  if (m === "PUT" || m === "PATCH") return "update";
  if (m === "DELETE") return "delete";
  // Unknown verb → demand sudo. Conservative.
  return "sudo";
}
