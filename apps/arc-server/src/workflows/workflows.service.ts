import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { parseAndValidate, type ValidationResult } from "@arc/workflows";
import {
  VaultAuditLogEntity,
  VaultMembershipEntity,
  VaultWorkflowEntity,
  type MemberRole,
} from "../database/entities";
import type { UpsertWorkflowDto } from "./dto";

/** Minimum-rank gate. Mirrors `vault.service.ts`'s inline constant; kept local so the
 * workflows module doesn't grow a transitive dep on `VaultService`. */
const ROLE_RANK: Record<MemberRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

/**
 * CRUD for `vault_workflows`. Every write re-runs `@arc/workflows` validation server-side
 * (the client may lie or be out of date) and refuses any payload that produces an
 * `error`-level issue. Warnings round-trip in the response so the UI can surface them.
 *
 * Authorization model: only `owner` + `admin` can list / create / update / delete.
 * Editors and viewers cannot see workflow definitions at all — these are policy
 * artifacts, not item data.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    @InjectRepository(VaultWorkflowEntity)
    private readonly workflows: Repository<VaultWorkflowEntity>,
    @InjectRepository(VaultMembershipEntity)
    private readonly memberships: Repository<VaultMembershipEntity>,
    @InjectRepository(VaultAuditLogEntity)
    private readonly audit: Repository<VaultAuditLogEntity>,
  ) {}

  async list(userId: number, vaultId: string) {
    await this.requireRole(vaultId, userId, "admin");
    const rows = await this.workflows.find({
      where: { vaultId },
      order: { createdAt: "ASC" },
    });
    return rows.map(this.toWire);
  }

  async get(userId: number, vaultId: string, id: string) {
    await this.requireRole(vaultId, userId, "admin");
    const row = await this.workflows.findOne({ where: { id, vaultId } });
    if (!row) throw new NotFoundException("workflow not found");
    return this.toWire(row);
  }

  async create(userId: number, vaultId: string, dto: UpsertWorkflowDto) {
    await this.requireRole(vaultId, userId, "admin");
    const { workflow, result } = parseAndValidate(dto.definition);
    if (!workflow) throw new UnprocessableEntityException({ error: "invalid_definition", issues: result.issues });

    const row = await this.workflows.save(
      this.workflows.create({
        vaultId,
        name: dto.name,
        definition: workflow as unknown as Record<string, unknown>,
        enabled: dto.enabled ?? true,
        version: 1,
        createdByUserId: userId,
      }),
    );
    await this.writeAudit(vaultId, userId, "workflow_created", row.id);
    return { ...this.toWire(row), validation: result };
  }

  async update(userId: number, vaultId: string, id: string, dto: UpsertWorkflowDto) {
    await this.requireRole(vaultId, userId, "admin");
    if (typeof dto.expectedVersion !== "number") {
      throw new BadRequestException({ error: "expectedVersion_required_on_update" });
    }
    const { workflow, result } = parseAndValidate(dto.definition);
    if (!workflow) throw new UnprocessableEntityException({ error: "invalid_definition", issues: result.issues });

    const row = await this.workflows.findOne({ where: { id, vaultId } });
    if (!row) throw new NotFoundException("workflow not found");
    if (row.version !== dto.expectedVersion) {
      throw new ConflictException({
        error: "version_conflict",
        currentVersion: row.version,
        expectedVersion: dto.expectedVersion,
      });
    }

    row.name = dto.name;
    row.definition = workflow as unknown as Record<string, unknown>;
    row.enabled = dto.enabled ?? row.enabled;
    row.version += 1;
    await this.workflows.save(row);
    await this.writeAudit(vaultId, userId, "workflow_updated", row.id);
    return { ...this.toWire(row), validation: result };
  }

  async remove(userId: number, vaultId: string, id: string) {
    await this.requireRole(vaultId, userId, "admin");
    const row = await this.workflows.findOne({ where: { id, vaultId } });
    if (!row) throw new NotFoundException("workflow not found");
    await this.workflows.delete({ id, vaultId });
    await this.writeAudit(vaultId, userId, "workflow_deleted", id);
    return { ok: true };
  }

  // -- helpers ----------------------------------------------------------------

  /** Used by the executor to enumerate enabled workflows for a vault. */
  async listEnabledForVault(vaultId: string): Promise<VaultWorkflowEntity[]> {
    return this.workflows.find({ where: { vaultId, enabled: true } });
  }

  /**
   * Validate without persisting. Used by the editor's "live validation" surface — the
   * user gets fast feedback without touching the DB and without needing admin role on a
   * workflow that doesn't yet have a row.
   */
  validate(definition: unknown): ValidationResult {
    return parseAndValidate(definition).result;
  }

  toWire = (row: VaultWorkflowEntity) => ({
    id: row.id,
    vaultId: row.vaultId,
    name: row.name,
    definition: row.definition,
    enabled: row.enabled,
    version: row.version,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  private async requireRole(vaultId: string, userId: number, min: "owner" | "admin" | "editor" | "viewer") {
    const m = await this.memberships.findOne({ where: { vaultId, userId, status: "active" } });
    if (!m) throw new NotFoundException("vault not found"); // hide existence from non-members
    if (ROLE_RANK[m.role] < ROLE_RANK[min]) {
      throw new ForbiddenException({ error: "forbidden", requiredRole: min });
    }
    return m;
  }

  private async writeAudit(vaultId: string, actorUserId: number, action: string, targetId: string) {
    await this.audit.save(
      this.audit.create({ vaultId, actorUserId, action, targetId, actorKind: "user" }),
    );
  }
}
