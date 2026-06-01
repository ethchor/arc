import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
  ValidationPipe,
} from "@nestjs/common";
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsString,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { scope, type Capability } from "@arc/grants";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CapabilityGuard } from "./capability.guard";
import { GrantsService } from "./grants.service";

const CAPABILITIES = ["create", "read", "update", "delete", "list", "sudo"] as const;

class ScopeDto {
  @IsString()
  pathPrefix!: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(CAPABILITIES, { each: true })
  capabilities!: Capability[];
}

class UpsertPolicyDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScopeDto)
  scopes!: ScopeDto[];
}

class AttachDto {
  @IsString()
  @MinLength(1)
  subject!: string;
}

/**
 * Admin API for Engine-A grants. Lives under `/v1/sys/policy`, so it's gated by the same
 * `CapabilityGuard` as every other `/v1/*` route — managing policies requires
 * create/read/delete capability on `sys/policy/` (a `root`/`sudo` subject has it). That's
 * deliberate: the ACL surface protects itself. The bootstrap path is `ARC_ROOT_USERS` (see
 * {@link GrantsService.onModuleInit}), which seeds a sudo subject so deny-mode is usable.
 *
 * A dedicated `ValidationPipe` is attached here (rather than relying solely on the global
 * one) so the nested `ScopeDto[]` whitelist + transform always runs even if a caller mounts
 * this controller in a context without the global pipe.
 */
@UseGuards(JwtAuthGuard, CapabilityGuard)
@Controller("v1/sys/policy")
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  @Get()
  async list() {
    return { data: await this.grants.listPolicies() };
  }

  @Post()
  async upsert(@Body(new ValidationPipe({ transform: true, whitelist: true })) dto: UpsertPolicyDto) {
    await this.grants.upsertPolicy({
      name: dto.name,
      scopes: dto.scopes.map((s) => scope(s.pathPrefix, s.capabilities)),
    });
    return { data: { name: dto.name, scopes: dto.scopes.length } };
  }

  @Delete(":name")
  @HttpCode(204)
  async remove(@Param("name") name: string) {
    await this.grants.removePolicy(name);
  }

  @Post(":name/attach")
  async attach(
    @Param("name") name: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) dto: AttachDto,
  ) {
    try {
      await this.grants.attach(dto.subject, name);
    } catch (err) {
      // The store throws a plain Error("unknown policy: <name>") for a missing policy —
      // surface it as a 404 rather than a 500.
      if (err instanceof Error && /unknown policy/.test(err.message)) {
        throw new NotFoundException({ errors: [err.message] });
      }
      throw err;
    }
    return { data: { subject: dto.subject, policy: name } };
  }

  @Post(":name/detach")
  @HttpCode(204)
  async detach(
    @Param("name") name: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) dto: AttachDto,
  ) {
    await this.grants.detach(dto.subject, name);
  }
}
