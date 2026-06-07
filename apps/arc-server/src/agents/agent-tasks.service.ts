import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, IsNull, Repository } from "typeorm";
import {
  fromB64u,
  intentArgsDigest,
  intentChainNext,
  intentDigest,
  verifyIntent,
  ZERO_CHAIN,
} from "@arc/crypto";
import type { Capability } from "@arc/grants";
import { agentSubject, type IntentClaims, type JsonValue } from "@arc/types";
import {
  VaultAgentEntity,
  VaultAgentIntentEntity,
  VaultAgentTaskEntity,
  VaultAuditLogEntity,
  VaultDelegationEntity,
} from "../database/entities";
import { ENGINES_CONFIG, type EnginesConfig } from "../engines/engines.service";
import { AgentsService } from "./agents.service";
import { ApprovalsService } from "./approvals.service";
import type { OpenTaskDto, SubmitIntentDto } from "./dto";

/** Default task budget — deliberately conservative; the owner can widen per task. */
const DEFAULT_BUDGET = { wallClockMs: 3_600_000, maxCalls: 100, maxSecretsUnsealed: 50 } as const;

/**
 * Maps an intent verb (the segment after the last `.` in `op`, e.g. `kv.read` → `read`) to a
 * policy {@link Capability}. Unknown verbs are refused — an agent can't smuggle an action
 * past the ACL by inventing an op name.
 */
const VERB_CAPABILITY: Record<string, Capability> = {
  read: "read", get: "read", decrypt: "read",
  list: "list",
  create: "create", put: "create", write: "create", issue: "create", generate: "create",
  update: "update", encrypt: "update", sign: "update", rotate: "update",
  delete: "delete", revoke: "delete",
};

function opToCapability(op: string): Capability | null {
  const verb = op.includes(".") ? op.slice(op.lastIndexOf(".") + 1) : op;
  return VERB_CAPABILITY[verb] ?? null;
}

@Injectable()
export class AgentTasksService {
  constructor(
    @InjectRepository(VaultAgentEntity) private readonly agents: Repository<VaultAgentEntity>,
    @InjectRepository(VaultAgentTaskEntity) private readonly tasks: Repository<VaultAgentTaskEntity>,
    @InjectRepository(VaultAgentIntentEntity) private readonly intents: Repository<VaultAgentIntentEntity>,
    @InjectRepository(VaultDelegationEntity) private readonly delegations: Repository<VaultDelegationEntity>,
    @InjectRepository(VaultAuditLogEntity) private readonly audit: Repository<VaultAuditLogEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ENGINES_CONFIG) private readonly engines: EnginesConfig,
    private readonly agentsService: AgentsService,
    private readonly approvals: ApprovalsService,
  ) {}

  /** Open a task. If bound to a delegation, the task id is the delegation's `taskId`. */
  async openTask(ownerUserId: number, agentId: string, dto: OpenTaskDto) {
    await this.agentsService.get(ownerUserId, agentId); // ownership (404 to non-owners)

    let delegationId: string | null = null;
    let taskId = dto.taskId ?? globalThis.crypto.randomUUID();
    if (dto.delegationId) {
      const d = await this.delegations.findOne({ where: { id: dto.delegationId, agentId } });
      if (!d) throw new NotFoundException("delegation not found");
      if (d.revokedAt) throw new BadRequestException({ error: "delegation_revoked" });
      delegationId = d.id;
      taskId = d.taskId; // the delegation was signed against this task id — bind to it
    }
    if (await this.tasks.findOne({ where: { taskId } })) {
      throw new ConflictException({ error: "task_exists", taskId });
    }

    const budget = {
      wallClockMs: dto.budget?.wallClockMs ?? DEFAULT_BUDGET.wallClockMs,
      maxCalls: dto.budget?.maxCalls ?? DEFAULT_BUDGET.maxCalls,
      maxSecretsUnsealed: dto.budget?.maxSecretsUnsealed ?? DEFAULT_BUDGET.maxSecretsUnsealed,
    };
    const task = await this.tasks.save(
      this.tasks.create({
        taskId,
        agentId,
        ownerUserId,
        delegationId,
        budget,
        callsUsed: 0,
        secretsUnsealed: 0,
        chainHead: ZERO_CHAIN,
        status: "open",
        deadlineAt: new Date(Date.now() + budget.wallClockMs),
        closedAt: null,
      }),
    );
    await this.writeAudit({ actorUserId: ownerUserId, action: "agent_task_opened", agentId, delegationId, taskId });
    return { taskId: task.taskId, status: task.status, budget, deadlineAt: task.deadlineAt.toISOString() };
  }

  /**
   * Submit a signed intent — the gated, cryptographically-bound action (ADR-005 Phase 3).
   * Verifies the agent signature, that the declared body matches (`argsDigest`), that the
   * task is open + within budget, then authorizes the declared op/path through the same
   * effective-scope decision as Phase 2, folds the intent into the task's hash chain, and
   * records it. Chain mutation + budget increment are transactional so concurrent intents
   * can't fork the chain.
   */
  async submitIntent(agentId: string, dto: SubmitIntentDto) {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent || agent.status !== "active") throw new BadRequestException({ error: "agent_inactive" });

    const claims = dto.claims as unknown as IntentClaims;
    if (claims?.v !== 1) throw new BadRequestException({ error: "unsupported_intent_version" });
    if (claims.agent !== agentSubject(agentId)) throw new BadRequestException({ error: "agent_mismatch" });

    if (!verifyIntent(fromB64u(agent.signingPublicKey), claims, dto.signature as unknown as Parameters<typeof verifyIntent>[2])) {
      throw new BadRequestException({ error: "invalid_intent_signature" });
    }
    const args = (dto.args ?? null) as JsonValue;
    if (intentArgsDigest(args) !== claims.argsDigest) {
      throw new BadRequestException({ error: "args_digest_mismatch" });
    }
    const capability = opToCapability(claims.op);
    if (!capability) throw new BadRequestException({ error: "unknown_op", op: claims.op });

    return this.dataSource.transaction(async (mgr) => {
      const task = await mgr.findOne(VaultAgentTaskEntity, { where: { taskId: claims.taskId } });
      if (!task) throw new NotFoundException("task not found");
      if (task.agentId !== agentId) throw new BadRequestException({ error: "task_agent_mismatch" });
      if (task.status !== "open") {
        throw new ConflictException({ error: "task_not_open", status: task.status });
      }
      if (Date.now() >= task.deadlineAt.getTime()) {
        task.status = "expired";
        await mgr.save(task);
        throw new ConflictException({ error: "task_expired" });
      }
      if (task.callsUsed >= task.budget.maxCalls) {
        task.status = "exhausted";
        await mgr.save(task);
        throw new ConflictException({ error: "task_budget_exhausted" });
      }

      let decision = await this.agentsService.authorize(agentId, {
        path: claims.path,
        capability,
        ...(claims.delegation ? { delegationId: claims.delegation } : {}),
      });

      // Push-consent gate (ADR-005 Phase 4): an action the policy would allow but which runs
      // under an `elevated` delegation needs a fresh human approval bound to this exact
      // intent. Without a granted approval we register a pending one and return *without*
      // recording or metering the action — the agent re-submits the identical intent once
      // the owner has approved out-of-band (a WebAuthn assertion).
      if (decision.decision === "allow" && decision.elevated) {
        const digest = intentDigest(claims);
        const approved = await this.approvals.tryConsume(agentId, task.taskId, digest);
        if (!approved) {
          const approvalId = await this.approvals.ensurePending({
            agentId,
            taskId: task.taskId,
            ownerUserId: agent.ownerUserId,
            intentDigest: digest,
            op: claims.op,
            path: claims.path,
          });
          await this.writeAudit({
            actorUserId: null,
            action: "agent_intent_pending_approval",
            agentId,
            delegationId: claims.delegation ?? null,
            taskId: task.taskId,
            toolCall: { op: claims.op, path: claims.path, capability, decision: "approval-required" },
          });
          return {
            decision: "deny" as const,
            reason: "approval-required",
            mode: decision.mode,
            elevated: true,
            approvalId,
            seq: task.callsUsed,
            chainHead: task.chainHead,
            callsRemaining: Math.max(0, task.budget.maxCalls - task.callsUsed),
          };
        }
      }

      // Secret-unseal sub-budget: an allowed read counts against maxSecretsUnsealed; exceeding
      // it converts the action to a deny (still recorded in the chain for the audit trail).
      let countsAsUnseal = false;
      if (decision.decision === "allow" && capability === "read") {
        if (task.secretsUnsealed >= task.budget.maxSecretsUnsealed) {
          decision = { ...decision, decision: "deny", reason: "no-matching-scope" };
        } else {
          countsAsUnseal = true;
        }
      }

      const chainHead = intentChainNext(task.chainHead, claims);
      const seq = task.callsUsed;
      await mgr.save(
        mgr.create(VaultAgentIntentEntity, {
          taskId: task.taskId,
          agentId,
          seq,
          claims: claims as unknown as Record<string, unknown>,
          signature: dto.signature,
          chainHead,
          decision: decision.decision,
        }),
      );
      task.callsUsed += 1;
      if (countsAsUnseal) task.secretsUnsealed += 1;
      task.chainHead = chainHead;
      await mgr.save(task);

      await this.writeAudit({
        actorUserId: null,
        action: "agent_intent",
        agentId,
        delegationId: claims.delegation ?? null,
        taskId: task.taskId,
        toolCall: { op: claims.op, path: claims.path, capability, decision: decision.decision },
      });

      return {
        decision: decision.decision,
        reason: decision.reason,
        mode: decision.mode,
        elevated: decision.elevated,
        seq,
        chainHead,
        callsRemaining: Math.max(0, task.budget.maxCalls - task.callsUsed),
      };
    });
  }

  /**
   * Close a task and cascade revoke (ADR-005). Marks the task closed (no further intents
   * accepted), revokes every delegation bound to its `taskId`, and revokes every Engine-A
   * lease tagged with it — the "access opened during a task closes when the task does"
   * guarantee, in one call.
   */
  async closeTask(ownerUserId: number, agentId: string, taskId: string) {
    await this.agentsService.get(ownerUserId, agentId);
    const task = await this.tasks.findOne({ where: { taskId, agentId } });
    if (!task) throw new NotFoundException("task not found");
    if (task.status === "open") {
      task.status = "closed";
      task.closedAt = new Date();
      await this.tasks.save(task);
    }

    const live = await this.delegations.find({ where: { taskId, revokedAt: IsNull() } });
    const now = new Date();
    for (const d of live) {
      d.revokedAt = now;
      await this.delegations.save(d);
    }
    const revokedLeases = this.engines.leases.revokeByTaskId(taskId);

    await this.writeAudit({
      actorUserId: ownerUserId,
      action: "agent_task_closed",
      agentId,
      taskId,
      toolCall: { revokedDelegations: live.length, revokedLeases },
    });
    return { ok: true, revokedDelegations: live.length, revokedLeases };
  }

  /** Read a task; with `verify`, recompute the intent chain and report whether it matches. */
  async getTask(ownerUserId: number, agentId: string, taskId: string, verify = false) {
    await this.agentsService.get(ownerUserId, agentId);
    const task = await this.tasks.findOne({ where: { taskId, agentId } });
    if (!task) throw new NotFoundException("task not found");
    const base = {
      taskId: task.taskId,
      agentId: task.agentId,
      delegationId: task.delegationId,
      status: task.status,
      budget: task.budget,
      callsUsed: task.callsUsed,
      secretsUnsealed: task.secretsUnsealed,
      chainHead: task.chainHead,
      deadlineAt: task.deadlineAt.toISOString(),
      closedAt: task.closedAt ? task.closedAt.toISOString() : null,
    };
    if (!verify) return base;

    const rows = await this.intents.find({ where: { taskId }, order: { seq: "ASC" } });
    let head = ZERO_CHAIN;
    for (const r of rows) head = intentChainNext(head, r.claims as unknown as IntentClaims);
    return { ...base, chainOk: head === task.chainHead, recomputedHead: head, length: rows.length };
  }

  private async writeAudit(e: {
    actorUserId: number | null;
    action: string;
    agentId?: string | null;
    delegationId?: string | null;
    taskId?: string | null;
    toolCall?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.audit.save(
      this.audit.create({
        vaultId: null,
        actorUserId: e.actorUserId,
        action: e.action,
        targetId: e.agentId ?? null,
        actorKind: "agent",
        agentId: e.agentId ?? null,
        delegationId: e.delegationId ?? null,
        taskId: e.taskId ?? null,
        toolCall: e.toolCall ?? null,
      }),
    );
  }
}
