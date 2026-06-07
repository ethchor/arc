import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { VaultAuditLogEntity, VaultPendingApprovalEntity } from "../database/entities";
import { PasskeyService } from "../vault/passkey.service";

/** How long a push-consent request stays actionable before it must be re-requested. */
const APPROVAL_TTL_MS = 5 * 60_000;

/**
 * Push-consent (CIBA) for `elevated` agent actions (ADR-005 Phase 4). An elevated intent
 * can't proceed until the owning human proves control out-of-band with a WebAuthn assertion
 * — not a tappable "yes". Each approval is pinned to one `intentDigest`, so granting it
 * authorizes exactly the action shown to the human and nothing else.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @InjectRepository(VaultPendingApprovalEntity)
    private readonly approvals: Repository<VaultPendingApprovalEntity>,
    @InjectRepository(VaultAuditLogEntity) private readonly audit: Repository<VaultAuditLogEntity>,
    private readonly passkeys: PasskeyService,
  ) {}

  /**
   * Ensure a pending approval exists for this exact intent; return its id. Idempotent — a
   * re-submitted elevated intent reuses the live pending row instead of spawning duplicates.
   */
  async ensurePending(input: {
    agentId: string;
    taskId: string;
    ownerUserId: number;
    intentDigest: string;
    op: string;
    path: string;
  }): Promise<string> {
    const existing = await this.approvals.findOne({
      where: {
        agentId: input.agentId,
        taskId: input.taskId,
        intentDigest: input.intentDigest,
        status: "pending",
      },
    });
    if (existing && existing.expiresAt.getTime() > Date.now()) return existing.id;

    const row = await this.approvals.save(
      this.approvals.create({
        agentId: input.agentId,
        taskId: input.taskId,
        ownerUserId: input.ownerUserId,
        intentDigest: input.intentDigest,
        op: input.op,
        path: input.path,
        status: "pending",
        challenge: null,
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        resolvedAt: null,
      }),
    );
    await this.writeAudit(input.ownerUserId, "agent_approval_requested", input.agentId, input.taskId);
    return row.id;
  }

  /**
   * Consume a granted approval for this exact intent if one is live. Returns true (and marks
   * it consumed — single-use) when an `approved`, unexpired approval matches; false otherwise.
   */
  async tryConsume(agentId: string, taskId: string, intentDigest: string): Promise<boolean> {
    const a = await this.approvals.findOne({
      where: { agentId, taskId, intentDigest, status: "approved" },
    });
    if (!a || a.expiresAt.getTime() <= Date.now()) return false;
    a.status = "consumed";
    a.resolvedAt = new Date();
    await this.approvals.save(a);
    return true;
  }

  /** List the owner's actionable (pending, unexpired) approvals. */
  async listPending(ownerUserId: number) {
    const rows = await this.approvals.find({
      where: { ownerUserId, status: "pending" },
      order: { createdAt: "DESC" },
    });
    const now = Date.now();
    return rows
      .filter((r) => r.expiresAt.getTime() > now)
      .map((r) => ({
        id: r.id,
        agentId: r.agentId,
        taskId: r.taskId,
        op: r.op,
        path: r.path,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      }));
  }

  /** Begin the WebAuthn ceremony — issue a challenge bound to this approval. */
  async beginApproval(ownerUserId: number, approvalId: string) {
    const a = await this.requirePending(ownerUserId, approvalId);
    const options = await this.passkeys.beginAssertionChallenge(ownerUserId);
    a.challenge = options.challenge;
    await this.approvals.save(a);
    return options;
  }

  /** Grant the approval by verifying a WebAuthn assertion against the issued challenge. */
  async approve(ownerUserId: number, approvalId: string, assertion: AuthenticationResponseJSON) {
    const a = await this.requirePending(ownerUserId, approvalId);
    if (!a.challenge) throw new BadRequestException({ error: "no_challenge_begin_first" });
    await this.passkeys.verifyAssertionWithChallenge(ownerUserId, assertion, a.challenge);
    a.status = "approved";
    a.challenge = null;
    a.resolvedAt = new Date();
    await this.approvals.save(a);
    await this.writeAudit(ownerUserId, "agent_approval_granted", a.agentId, a.taskId);
    return { ok: true, approvalId: a.id, status: a.status };
  }

  /** Deny the approval outright (no proof-of-control needed to say no). */
  async deny(ownerUserId: number, approvalId: string) {
    const a = await this.requirePending(ownerUserId, approvalId);
    a.status = "denied";
    a.resolvedAt = new Date();
    await this.approvals.save(a);
    await this.writeAudit(ownerUserId, "agent_approval_denied", a.agentId, a.taskId);
    return { ok: true, approvalId: a.id, status: a.status };
  }

  /** Best-effort GC of expired pending rows (kept tiny; not on the hot path). */
  async sweepExpired(): Promise<number> {
    const res = await this.approvals.delete({ status: "pending", expiresAt: LessThan(new Date()) });
    return res.affected ?? 0;
  }

  private async requirePending(ownerUserId: number, approvalId: string): Promise<VaultPendingApprovalEntity> {
    const a = await this.approvals.findOne({ where: { id: approvalId } });
    if (!a || a.ownerUserId !== ownerUserId) throw new NotFoundException("approval not found");
    if (a.status !== "pending") throw new BadRequestException({ error: "approval_not_pending", status: a.status });
    if (a.expiresAt.getTime() <= Date.now()) throw new ForbiddenException({ error: "approval_expired" });
    return a;
  }

  private async writeAudit(actorUserId: number, action: string, agentId: string, taskId: string): Promise<void> {
    await this.audit.save(
      this.audit.create({
        vaultId: null,
        actorUserId,
        action,
        targetId: agentId,
        actorKind: "user",
        agentId,
        taskId,
      }),
    );
  }
}
