import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CapabilityGuard } from "../grants/capability.guard";
import { EnginesService } from "./engines.service";
import { joinSplatStrict } from "./path-canon";

/**
 * Engine-A surface. All paths live under `/v1/...` to match the wire shape OpenBao (and
 * therefore existing Vault SDKs) speak — that way a caller's existing
 * `vault kv put secret/foo @bar.json` and language-SDK clients hit arc-server unchanged.
 *
 * The two `/v1/sys/*` endpoints are explicit; everything else routes through the wildcard
 * dispatcher which resolves the mount via {@link EnginesService.resolve} and dispatches
 * by engine type. Path-to-regexp v8 (Express 5 / Nest 11) wildcard syntax: `*splat`, which
 * captures the remaining segments as an array.
 *
 * Auth is the same JWT guard {@link VaultController} uses — Engine-A access requires a
 * normal arc session. Per-mount ACL (read/write capabilities scoped by grant) is the
 * follow-up commit when `@arc/grants` lands; today an authenticated user can hit any
 * mounted engine.
 */
/**
 * `@UseGuards(JwtAuthGuard, CapabilityGuard)` — order matters. JwtAuthGuard runs first and
 * attaches `req.user`; CapabilityGuard then reads it to check per-mount ACL via
 * {@link GrantsService}. With `ARC_DEFAULT_POLICY=allow` (the dev default) a user without
 * any attached policies still gets through.
 */
@UseGuards(JwtAuthGuard, CapabilityGuard)
@Controller("v1")
export class EnginesController {
  constructor(private readonly engines: EnginesService) {}

  @Get("sys/seal-status")
  async sealStatus() {
    try {
      return await this.engines.sealStatus();
    } catch (err) {
      this.engines.translateError(err);
    }
  }

  @Get("sys/health")
  async health() {
    try {
      return await this.engines.health();
    } catch (err) {
      this.engines.translateError(err);
    }
  }

  @Get("sys/mounts")
  async mounts() {
    return { data: await this.engines.listMounts() };
  }

  /**
   * Suggested arc-grants policy documents for each plugin mount that declared
   * capabilities in its manifest (ADR-005 Phase 5b runtime gate). Admins POST the returned
   * documents to `/v1/sys/policy` to grant a subject exactly the surface its plugin uses
   * — no need to hand-derive the verb set from the plugin's source.
   */
  @Get("sys/policy-templates")
  policyTemplates() {
    return { data: this.engines.policyTemplates() };
  }

  /**
   * Vault's lease-renewal endpoint. Body: `{ lease_id, increment? }`. The increment is
   * seconds; arc accepts a bare integer (no Vault TTL string forms here — clients of this
   * endpoint already know they're talking to the renew API).
   */
  @Post("sys/leases/renew")
  async renewLease(@Body() body: { lease_id?: unknown; increment?: unknown } = {}) {
    if (typeof body.lease_id !== "string" || body.lease_id.length === 0) {
      throw new BadRequestException({ errors: ["`lease_id` is required"] });
    }
    let increment: number | undefined;
    if (body.increment !== undefined) {
      const n = Number(body.increment);
      if (!Number.isFinite(n) || n <= 0) {
        throw new BadRequestException({ errors: ["`increment` must be a positive number"] });
      }
      increment = n;
    }
    try {
      return await this.engines.renewLease(body.lease_id, increment);
    } catch (err) {
      this.engines.translateError(err);
    }
  }

  /** `PUT /v1/sys/leases/revoke/<id>` per Vault's HTTP API. 204 on success. */
  @Put("sys/leases/revoke/:leaseId")
  @HttpCode(204)
  async revokeLeaseByPath(@Param("leaseId") leaseId: string) {
    try {
      await this.engines.revokeLease(leaseId);
    } catch (err) {
      this.engines.translateError(err);
    }
  }

  /** Body form: `POST /v1/sys/leases/revoke { lease_id }`. 204 on success. */
  @Post("sys/leases/revoke")
  @HttpCode(204)
  async revokeLeaseByBody(@Body() body: { lease_id?: unknown } = {}) {
    if (typeof body.lease_id !== "string" || body.lease_id.length === 0) {
      throw new BadRequestException({ errors: ["`lease_id` is required"] });
    }
    try {
      await this.engines.revokeLease(body.lease_id);
    } catch (err) {
      this.engines.translateError(err);
    }
  }

  @Get("*splat")
  async dispatchGet(
    @Param("splat") splat: string[] | string,
    @Query() query: Record<string, string | string[] | undefined>,
  ) {
    try {
      return await this.engines.get(joinSplat(splat), query);
    } catch (err) {
      this.engines.translateError(err);
    }
  }

  @Post("*splat")
  async dispatchPost(
    @Param("splat") splat: string[] | string,
    @Body() body: Record<string, unknown> = {},
  ) {
    try {
      return await this.engines.post(joinSplat(splat), body);
    } catch (err) {
      this.engines.translateError(err);
    }
  }

  @Delete("*splat")
  @HttpCode(204)
  async dispatchDelete(@Param("splat") splat: string[] | string) {
    try {
      await this.engines.delete(joinSplat(splat));
    } catch (err) {
      this.engines.translateError(err);
    }
  }
}

/**
 * Express 5 + path-to-regexp 8 give `*splat` as an array of path segments. The legacy
 * `joinSplat` joined naively, which let `..` / `.` / empty segments through the controller —
 * combined with the ACL guard's `startsWith` prefix match and `fetch`'s built-in `..`
 * collapse, a `secret/`-authorized caller could reach `sys/seal-status` by sending
 * `/v1/secret/data/../../sys/seal-status`. {@link joinSplatStrict} validates the segments
 * and throws {@link EnginePathError} on any traversal marker.
 */
function joinSplat(splat: string[] | string): string {
  return joinSplatStrict(splat);
}
