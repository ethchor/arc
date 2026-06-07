import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { fromB64u, verifyDelegation } from "@arc/crypto";
import { effectiveAllows, scope, type Capability, type Scope } from "@arc/grants";
import {
  agentSubject,
  userSubject,
  type AgentIdentity,
  type DelegationClaims,
  type DelegationScope,
} from "@arc/types";
import {
  VaultAgentEntity,
  VaultAuditLogEntity,
  VaultDelegationEntity,
  VaultUserKeysEntity,
} from "../database/entities";
import { GrantsService } from "../grants/grants.service";
import type { CreateDelegationDto, RegisterAgentDto, UpdateAgentDto } from "./dto";

/** Canonical capability vocabulary (mirrors `@arc/grants` `Capability` / Vault's verb set). */
const CAPABILITIES: readonly Capability[] = ["create", "read", "update", "delete", "list", "sudo"];

/** The structured outcome of an effective-authority check. */
export interface AgentDecision {
  decision: "allow" | "deny";
  mode: "delegated" | "autonomous";
  /** Machine-readable reason, safe to surface (never leaks which scopes the agent *does* hold). */
  reason:
    | "scope-match"
    | "no-matching-scope"
    | "agent-inactive"
    | "autonomous-not-allowed"
    | "delegation-not-found"
    | "delegation-revoked"
    | "delegation-expired"
    | "delegation-not-yet-valid"
    | "delegation-call-budget-exhausted";
  /** True when the matched delegation is `elevated` — Phase 4 will gate this on push-consent. */
  elevated: boolean;
}

@Injectable()
export class AgentsService {
  constructor(
    @InjectRepository(VaultAgentEntity) private readonly agents: Repository<VaultAgentEntity>,
    @InjectRepository(VaultDelegationEntity) private readonly delegations: Repository<VaultDelegationEntity>,
    @InjectRepository(VaultUserKeysEntity) private readonly userKeys: Repository<VaultUserKeysEntity>,
    @InjectRepository(VaultAuditLogEntity) private readonly audit: Repository<VaultAuditLogEntity>,
    private readonly grants: GrantsService,
  ) {}

  // --- agent CRUD ---

  async register(ownerUserId: number, dto: RegisterAgentDto): Promise<AgentIdentity> {
    const agent = await this.agents.save(
      this.agents.create({
        ownerUserId,
        displayName: dto.displayName,
        signingPublicKey: dto.signingPublicKey,
        identityPublicKey: dto.identityPublicKey,
        identityPublicKeyMlkem: dto.identityPublicKeyMlkem,
        attestation: dto.attestation ?? null,
        autonomousAllowed: false,
        status: "active",
      }),
    );
    await this.writeAudit({ actorUserId: ownerUserId, action: "agent_registered", agentId: agent.id });
    return toWire(agent);
  }

  async list(ownerUserId: number): Promise<AgentIdentity[]> {
    const rows = await this.agents.find({ where: { ownerUserId }, order: { createdAt: "ASC" } });
    return rows.map(toWire);
  }

  async get(ownerUserId: number, agentId: string): Promise<AgentIdentity> {
    return toWire(await this.requireOwnedAgent(ownerUserId, agentId));
  }

  async update(ownerUserId: number, agentId: string, dto: UpdateAgentDto): Promise<AgentIdentity> {
    const agent = await this.requireOwnedAgent(ownerUserId, agentId);
    if (dto.displayName !== undefined) agent.displayName = dto.displayName;
    if (dto.status !== undefined) agent.status = dto.status;
    if (dto.autonomousAllowed !== undefined) agent.autonomousAllowed = dto.autonomousAllowed;
    await this.agents.save(agent);
    await this.writeAudit({ actorUserId: ownerUserId, action: "agent_updated", agentId });
    return toWire(agent);
  }

  // --- delegations ---

  /**
   * Record a signed delegation. The authenticated user is the delegator: we verify the
   * delegation's signature against *their* published signing key, and refuse to record a
   * delegation that claims a different delegator (you can only lend your own authority).
   */
  async createDelegation(delegatorUserId: number, agentId: string, dto: CreateDelegationDto) {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent) throw new NotFoundException("agent not found");
    if (agent.status !== "active") throw new BadRequestException({ error: "agent_inactive" });

    const claims = dto.claims as unknown as DelegationClaims;
    this.validateClaimsShape(claims);

    // You can only delegate your own authority, and only to the agent in the URL.
    if (claims.delegator !== userSubject(delegatorUserId)) {
      throw new ForbiddenException({ error: "delegator_mismatch" });
    }
    if (claims.agent !== agentSubject(agentId)) {
      throw new BadRequestException({ error: "agent_mismatch" });
    }

    // Verify the signature against the delegator's published Ed25519 signing key.
    const keys = await this.userKeys.findOne({ where: { userId: delegatorUserId } });
    if (!keys) throw new BadRequestException({ error: "delegator_not_enrolled" });
    const ok = verifyDelegation(
      fromB64u(keys.signingPublicKey),
      claims,
      dto.signature as unknown as Parameters<typeof verifyDelegation>[2],
    );
    if (!ok) throw new BadRequestException({ error: "invalid_delegation_signature" });

    const notBefore = parseInstant(claims.notBefore, "notBefore");
    const notAfter = parseInstant(claims.notAfter, "notAfter");
    if (notAfter.getTime() <= Date.now()) {
      throw new BadRequestException({ error: "delegation_already_expired" });
    }
    if (notAfter.getTime() <= notBefore.getTime()) {
      throw new BadRequestException({ error: "delegation_window_empty" });
    }

    const row = await this.delegations.save(
      this.delegations.create({
        agentId,
        delegatorUserId,
        taskId: claims.taskId,
        claims: claims as unknown as Record<string, unknown>,
        signature: dto.signature,
        notBefore,
        notAfter,
        maxCalls: claims.maxCalls ?? null,
        callsUsed: 0,
        elevated: claims.elevated === true,
        revokedAt: null,
      }),
    );
    await this.writeAudit({
      actorUserId: delegatorUserId,
      action: "agent_delegation_created",
      agentId,
      delegationId: row.id,
      taskId: claims.taskId,
    });
    return { id: row.id, taskId: row.taskId, notAfter: row.notAfter.toISOString(), elevated: row.elevated };
  }

  async listDelegations(ownerUserId: number, agentId: string) {
    await this.requireOwnedAgent(ownerUserId, agentId);
    const rows = await this.delegations.find({ where: { agentId }, order: { createdAt: "DESC" } });
    return rows.map((d) => ({
      id: d.id,
      taskId: d.taskId,
      delegatorUserId: d.delegatorUserId,
      scopes: (d.claims as unknown as DelegationClaims).scopes,
      notBefore: d.notBefore.toISOString(),
      notAfter: d.notAfter.toISOString(),
      maxCalls: d.maxCalls,
      callsUsed: d.callsUsed,
      elevated: d.elevated,
      revoked: d.revokedAt !== null,
    }));
  }

  /** Revoke a delegation. The agent owner or the original delegator may revoke. */
  async revokeDelegation(actingUserId: number, agentId: string, delegationId: string) {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent) throw new NotFoundException("agent not found");
    const d = await this.delegations.findOne({ where: { id: delegationId, agentId } });
    if (!d) throw new NotFoundException("delegation not found");
    if (actingUserId !== agent.ownerUserId && actingUserId !== d.delegatorUserId) {
      throw new ForbiddenException({ error: "not_owner_or_delegator" });
    }
    if (!d.revokedAt) {
      d.revokedAt = new Date();
      await this.delegations.save(d);
    }
    await this.writeAudit({
      actorUserId: actingUserId,
      action: "agent_delegation_revoked",
      agentId,
      delegationId,
      taskId: d.taskId,
    });
    return { ok: true };
  }

  // --- the effective-authority decision (the heart of Engine-C v1) ---

  /**
   * Would `agentId` be allowed `capability` on `path`, optionally under `delegationId`?
   *
   * Delegated mode (delegationId present): allow ⇔ the path/cap is permitted by the
   * **intersection** of (a) the delegation's scopes, (b) the delegator's own policy, and
   * (c) the agent's own policy — and the delegation is live (not revoked/expired, within
   * its window, under its call budget). A delegation can only ever narrow.
   *
   * Autonomous mode (no delegationId): denied unless the agent has `autonomousAllowed`;
   * then allow ⇔ the agent's own policy permits it. No human authority is borrowed.
   *
   * This does not consume the call budget — accounting happens at execution time when the
   * signed-intent path lands (ADR-005 Phase 3). It is pure read introspection.
   */
  async authorize(
    agentId: string,
    input: { path: string; capability: Capability; delegationId?: string },
  ): Promise<AgentDecision> {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent || agent.status !== "active") {
      return deny("agent-inactive", input.delegationId ? "delegated" : "autonomous");
    }
    const agentScopes = await this.grants.scopesForSubject(agentSubject(agentId));

    if (!input.delegationId) {
      if (!agent.autonomousAllowed) return deny("autonomous-not-allowed", "autonomous");
      const allow = effectiveAllows(input.path, input.capability, agentScopes);
      return {
        decision: allow ? "allow" : "deny",
        mode: "autonomous",
        reason: allow ? "scope-match" : "no-matching-scope",
        elevated: false,
      };
    }

    const d = await this.delegations.findOne({ where: { id: input.delegationId, agentId } });
    if (!d) return deny("delegation-not-found", "delegated");
    if (d.revokedAt) return deny("delegation-revoked", "delegated", d.elevated);
    const now = Date.now();
    if (now < d.notBefore.getTime()) return deny("delegation-not-yet-valid", "delegated", d.elevated);
    if (now >= d.notAfter.getTime()) return deny("delegation-expired", "delegated", d.elevated);
    if (d.maxCalls !== null && d.callsUsed >= d.maxCalls) {
      return deny("delegation-call-budget-exhausted", "delegated", d.elevated);
    }

    const delegationScopes = toScopes((d.claims as unknown as DelegationClaims).scopes);
    const delegatorScopes = await this.grants.scopesForSubject(userSubject(d.delegatorUserId));
    const allow = effectiveAllows(
      input.path,
      input.capability,
      delegationScopes,
      delegatorScopes,
      agentScopes,
    );
    return {
      decision: allow ? "allow" : "deny",
      mode: "delegated",
      reason: allow ? "scope-match" : "no-matching-scope",
      elevated: d.elevated,
    };
  }

  // --- helpers ---

  private async requireOwnedAgent(ownerUserId: number, agentId: string): Promise<VaultAgentEntity> {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    // Hide existence from non-owners (same posture as vault membership 404s).
    if (!agent || agent.ownerUserId !== ownerUserId) throw new NotFoundException("agent not found");
    return agent;
  }

  /** Structural + vocabulary validation of the signed claims before we trust the signature path. */
  private validateClaimsShape(claims: DelegationClaims): void {
    if (claims?.v !== 1) throw new BadRequestException({ error: "unsupported_claims_version" });
    if (!Array.isArray(claims.scopes) || claims.scopes.length === 0) {
      throw new BadRequestException({ error: "empty_scopes" });
    }
    for (const s of claims.scopes) {
      if (typeof s?.pathPrefix !== "string" || !Array.isArray(s?.capabilities)) {
        throw new BadRequestException({ error: "malformed_scope" });
      }
      for (const c of s.capabilities) {
        if (!(CAPABILITIES as readonly string[]).includes(c)) {
          throw new BadRequestException({ error: "invalid_capability", capability: c });
        }
      }
    }
    if (typeof claims.taskId !== "string" || claims.taskId.length === 0) {
      throw new BadRequestException({ error: "missing_taskId" });
    }
  }

  private async writeAudit(e: {
    actorUserId: number | null;
    action: string;
    agentId?: string | null;
    delegationId?: string | null;
    taskId?: string | null;
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
      }),
    );
  }
}

function deny(
  reason: AgentDecision["reason"],
  mode: AgentDecision["mode"],
  elevated = false,
): AgentDecision {
  return { decision: "deny", mode, reason, elevated };
}

/** Wire `DelegationScope[]` → normalized `@arc/grants` `Scope[]` (loose verbs already validated). */
function toScopes(wire: DelegationScope[]): Scope[] {
  return wire.map((s) => scope(s.pathPrefix, s.capabilities as Capability[]));
}

function parseInstant(iso: string, field: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new BadRequestException({ error: "invalid_instant", field });
  return d;
}

function toWire(a: VaultAgentEntity): AgentIdentity {
  return {
    id: a.id,
    ownerUserId: a.ownerUserId,
    displayName: a.displayName,
    signingPublicKey: a.signingPublicKey,
    identityPublicKey: a.identityPublicKey,
    identityPublicKeyMlkem: a.identityPublicKeyMlkem,
    attestation: (a.attestation as AgentIdentity["attestation"]) ?? null,
    autonomousAllowed: a.autonomousAllowed,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    lastSeenAt: a.lastSeenAt ? a.lastSeenAt.toISOString() : null,
  };
}
