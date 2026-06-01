import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { EnginesService } from "./engines.service";

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
@UseGuards(JwtAuthGuard)
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
 * Express 5 + path-to-regexp 8 give `*splat` as an array of path segments. Older versions
 * (or string fallbacks for plain captures) give a single string. Normalize to a flat path.
 */
function joinSplat(splat: string[] | string): string {
  if (Array.isArray(splat)) return splat.join("/");
  return splat.replace(/^\/+/, "");
}
