import { Inject, Injectable, Optional } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  evaluate,
  parseAndValidate,
  type EvaluationContext,
  type EvaluationDecision,
  type WorkflowDefinition,
} from "@arc/workflows";
import {
  VaultAuditLogEntity,
  VaultMembershipEntity,
  VaultWorkflowEntity,
} from "../database/entities";
import { GrantsService } from "../grants/grants.service";

export interface WorkflowExecutionRequest {
  agentId: string;
  /** Owning user of the agent — used as `requesterRole` lookup + approver for `require_approval`. */
  ownerUserId: number;
  mountPath: string;
  capability: string;
  /** Optional override clock (tests, simulation). Defaults to `new Date()`. */
  now?: Date;
}

/**
 * The combined decision the executor returns to its callers. `terminal` is the action
 * the workflow chose; for `auto_approve` the caller proceeds without further consent,
 * for `require_approval` the caller falls through to the existing CIBA approval flow,
 * for `deny` the caller refuses with the workflow's reason.
 *
 * `matchedWorkflowId` is null when no enabled workflow matched (e.g. zero workflows
 * configured). In that case the caller applies its default behaviour — for Phase 1
 * that means falling back to the existing unconditional `ensurePending` path.
 */
export interface WorkflowExecutionResult {
  matchedWorkflowId: string | null;
  terminal: EvaluationDecision["terminal"] | null;
  reason: string | null;
  notifications: readonly string[];
  trace: readonly string[];
}

const NO_MATCH: WorkflowExecutionResult = {
  matchedWorkflowId: null,
  terminal: null,
  reason: null,
  notifications: [],
  trace: [],
};

/**
 * Runs configured workflows against an incoming request and returns a single decision.
 *
 * Match policy: a workflow matches when its trigger kind is `request_access` (Phase 1's
 * only trigger). When multiple workflows match, the first one created wins — deterministic
 * + easy to reason about. We don't implement priority columns until there's a real second
 * workflow on a real vault asking for one.
 */
@Injectable()
export class WorkflowExecutorService {
  constructor(
    @InjectRepository(VaultWorkflowEntity)
    private readonly workflows: Repository<VaultWorkflowEntity>,
    @InjectRepository(VaultMembershipEntity)
    private readonly memberships: Repository<VaultMembershipEntity>,
    @InjectRepository(VaultAuditLogEntity)
    private readonly audit: Repository<VaultAuditLogEntity>,
    /**
     * Optional so unit tests can omit the grants module. In production the GrantsModule
     * is `@Global`, so this never resolves undefined at runtime.
     */
    @Optional() @Inject(GrantsService) private readonly grants?: GrantsService,
  ) {}

  /**
   * Build the context + run the first matching workflow.
   *
   * Workflows are scoped to a vault, but agent intents target engine mount paths and
   * do not carry a vault id. We therefore consider every vault where the agent's owner
   * holds at least `admin` role (the role required to configure workflows in the first
   * place). All enabled workflows on those vaults are pooled and evaluated in oldest-
   * created order; the first one whose trigger matches wins.
   */
  async run(req: WorkflowExecutionRequest): Promise<WorkflowExecutionResult> {
    const memberships = await this.memberships.find({
      where: { userId: req.ownerUserId, status: "active" },
    });
    const adminVaults = memberships
      .filter((m) => m.role === "owner" || m.role === "admin")
      .map((m) => m.vaultId);
    if (adminVaults.length === 0) return NO_MATCH;

    const rows = await this.workflows
      .createQueryBuilder("w")
      .where("w.vaultId IN (:...vaultIds)", { vaultIds: adminVaults })
      .andWhere("w.enabled = :enabled", { enabled: true })
      .orderBy("w.createdAt", "ASC")
      .getMany();
    if (rows.length === 0) return NO_MATCH;

    const ctx = await this.buildContext(req, memberships);
    for (const row of rows) {
      const { workflow } = parseAndValidate(row.definition);
      if (!workflow) {
        // A row that fails revalidation is treated as "no match" rather than killing the
        // whole flow — disabling it from the UI is the operator's recovery. We still
        // audit-log this so the operator notices.
        await this.writeAudit(row.vaultId, null, "workflow_invalid_skipped", row.id);
        continue;
      }
      if (!matchesTrigger(workflow, ctx)) continue;
      // For each workflow, override the requester role from the matching vault rather
      // than using the first one found — a user can be `viewer` in vault A and `admin`
      // in vault B, and the right role to feed the condition is the one for *this*
      // workflow's vault.
      const m = memberships.find((mb) => mb.vaultId === row.vaultId);
      const decision = evaluate(workflow, { ...ctx, requesterRole: m?.role ?? null });
      await this.writeAudit(row.vaultId, null, "workflow_decision", row.id, {
        agentId: req.agentId,
        mountPath: req.mountPath,
        terminal: decision.terminal,
        reason: decision.reason,
        notifications: decision.notifications,
        trace: decision.trace,
      });
      return {
        matchedWorkflowId: row.id,
        terminal: decision.terminal,
        reason: decision.reason,
        notifications: decision.notifications,
        trace: decision.trace,
      };
    }
    return NO_MATCH;
  }

  /**
   * Same as `run` but with a synthetic context (no DB lookups). Used by the editor's
   * "simulate" surface to preview decisions without touching any agent state.
   */
  simulate(definition: WorkflowDefinition, ctx: EvaluationContext): EvaluationDecision {
    return evaluate(definition, ctx);
  }

  private async buildContext(
    req: WorkflowExecutionRequest,
    memberships: VaultMembershipEntity[],
  ): Promise<EvaluationContext> {
    const requesterGroups = this.grants
      ? await Promise.resolve(this.grants.listGroupsForSubject(String(req.ownerUserId))).catch(
          () => [] as string[],
        )
      : [];
    return {
      trigger: { kind: "request_access" },
      mountPath: req.mountPath,
      capability: req.capability,
      // Default to the highest role the owner holds anywhere; per-workflow we then
      // narrow to the vault that owns it (see `run`).
      requesterRole: pickHighestRole(memberships),
      requesterGroups,
      // Phase 1: MFA freshness is not tracked at the user level yet. Wire it from the
      // device entity once we add `lastMfaAt` propagation. For now any condition that
      // requires recent MFA will fall to its `false` branch.
      mfaAgeSeconds: null,
      now: req.now ?? new Date(),
    };
  }

  private async writeAudit(
    vaultId: string,
    actorUserId: number | null,
    action: string,
    targetId: string,
    toolCall?: Record<string, unknown>,
  ) {
    await this.audit.save(
      this.audit.create({
        vaultId,
        actorUserId,
        action,
        targetId,
        actorKind: actorUserId === null ? "system" : "user",
        ...(toolCall ? { toolCall } : {}),
      }),
    );
  }
}

function matchesTrigger(def: WorkflowDefinition, ctx: EvaluationContext): boolean {
  const trigger = def.nodes.find((n) => n.kind === "trigger");
  if (!trigger || trigger.kind !== "trigger") return false;
  return trigger.trigger.kind === ctx.trigger.kind;
}

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 } as const;
function pickHighestRole(
  memberships: VaultMembershipEntity[],
): "owner" | "admin" | "editor" | "viewer" | null {
  if (memberships.length === 0) return null;
  return memberships.reduce<"owner" | "admin" | "editor" | "viewer">((best, m) => {
    return ROLE_RANK[m.role] > ROLE_RANK[best] ? m.role : best;
  }, memberships[0]!.role);
}
