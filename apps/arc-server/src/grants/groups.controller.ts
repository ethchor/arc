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
import { IsString, MinLength } from "class-validator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CapabilityGuard } from "./capability.guard";
import { GrantsService } from "./grants.service";

class SubjectDto {
  @IsString()
  @MinLength(1)
  subject!: string;
}

class PolicyNameDto {
  @IsString()
  @MinLength(1)
  policyName!: string;
}

/**
 * Group admin API. Lives under `/v1/sys/groups/`, gated by the same
 * `JwtAuthGuard + CapabilityGuard` chain as the rest of `/v1/*` — so managing groups
 * requires create/read/delete capability on `sys/groups/` (a sudo subject like the
 * seeded `root` policy has it).
 *
 * Routes:
 *   GET    /v1/sys/groups/:group                       → { members[], policies[] }
 *   POST   /v1/sys/groups/:group/members  { subject }  → add subject to group
 *   POST   /v1/sys/groups/:group/members/remove { subject } → 204
 *   POST   /v1/sys/groups/:group/policies { policyName } → attach policy to group
 *   DELETE /v1/sys/groups/:group/policies/:policyName  → 204 (detach)
 *
 * Groups are opaque string identifiers — no "create group" endpoint, the group exists
 * the moment something attaches to it (matches the in-memory store's semantics).
 */
@UseGuards(JwtAuthGuard, CapabilityGuard)
@Controller("v1/sys/groups")
export class GroupsController {
  constructor(private readonly grants: GrantsService) {}

  @Get(":group")
  async describe(@Param("group") group: string) {
    const [members, policies] = await Promise.all([
      this.grants.listSubjectsInGroup(group),
      this.grants.listGroupPolicies(group),
    ]);
    return { data: { group, members, policies } };
  }

  @Post(":group/members")
  async addMember(
    @Param("group") group: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) dto: SubjectDto,
  ) {
    await this.grants.addToGroup(dto.subject, group);
    return { data: { group, subject: dto.subject } };
  }

  @Post(":group/members/remove")
  @HttpCode(204)
  async removeMember(
    @Param("group") group: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) dto: SubjectDto,
  ) {
    await this.grants.removeFromGroup(dto.subject, group);
  }

  @Post(":group/policies")
  async attachPolicy(
    @Param("group") group: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) dto: PolicyNameDto,
  ) {
    try {
      await this.grants.attachToGroup(group, dto.policyName);
    } catch (err) {
      if (err instanceof Error && /unknown policy/.test(err.message)) {
        throw new NotFoundException({ errors: [err.message] });
      }
      throw err;
    }
    return { data: { group, policy: dto.policyName } };
  }

  @Delete(":group/policies/:policyName")
  @HttpCode(204)
  async detachPolicy(@Param("group") group: string, @Param("policyName") policyName: string) {
    await this.grants.detachFromGroup(group, policyName);
  }
}
