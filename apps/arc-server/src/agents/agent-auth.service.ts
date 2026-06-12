import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { Repository } from "typeorm";
import { fromB64u, randomBytes, toB64u, verifyObject } from "@arc/crypto";
import { agentSubject, type JsonValue } from "@arc/types";
import { VaultAgentEntity } from "../database/entities";

/** How long a challenge nonce is valid, and the lifetime of an issued agent token. */
const CHALLENGE_TTL_MS = 2 * 60_000;
const AGENT_TOKEN_TTL = "10m";

interface PendingChallenge {
  nonce: string;
  expiresAt: number;
}

/**
 * Agent self-authentication (ADR-005 — completes the Phase-3 credential path). An agent
 * proves control of its Ed25519 signing key via challenge-response and receives a
 * short-lived JWT it uses to submit its *own* intents — so the action path no longer rides
 * on the owner's session. The token carries the owner as `sub` (the human authority behind
 * the agent) plus `agentId` and the RFC 8693 `act: { sub: "agent:<id>" }` claim, so the
 * on-behalf-of relationship is legible to standard OAuth tooling.
 */
@Injectable()
export class AgentAuthService {
  private readonly pending = new Map<string, PendingChallenge>();

  constructor(
    @InjectRepository(VaultAgentEntity) private readonly agents: Repository<VaultAgentEntity>,
    private readonly jwt: JwtService,
  ) {}

  /** Issue a fresh challenge nonce for an agent to sign. Open (the agent has no token yet). */
  async challenge(agentId: string): Promise<{ nonce: string; expiresAt: string }> {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent || agent.status !== "active") throw new NotFoundException("agent not found");
    const nonce = toB64u(randomBytes(32));
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    this.pending.set(agentId, { nonce, expiresAt });
    return { nonce, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Exchange a signed challenge for a short-lived agent token. The signature is over the
   * canonical object `{ v, purpose: "agent-auth", agent, nonce }` (Ed25519 over JCS-SHA-256,
   * the same primitive as delegations/intents), verified against the agent's published key.
   * The nonce is single-use.
   */
  async token(agentId: string, signature: unknown): Promise<{ accessToken: string; expiresIn: string }> {
    const agent = await this.agents.findOne({ where: { id: agentId } });
    if (!agent || agent.status !== "active") throw new NotFoundException("agent not found");

    const pending = this.pending.get(agentId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(agentId);
      throw new BadRequestException({ error: "no_pending_challenge" });
    }
    this.pending.delete(agentId); // single-use regardless of outcome

    const challengeObject: JsonValue = {
      v: 1,
      purpose: "agent-auth",
      agent: agentSubject(agentId),
      nonce: pending.nonce,
    };
    const ok = verifyObject(
      fromB64u(agent.signingPublicKey),
      challengeObject,
      signature as Parameters<typeof verifyObject>[2],
    );
    if (!ok) throw new BadRequestException({ error: "invalid_challenge_signature" });

    agent.lastSeenAt = new Date();
    await this.agents.save(agent);

    // HIGH-C (audit): pin the JWT to the agent's current `tokenEpoch`. Any subsequent
    // event that bumps the counter (task closure today; suspend / delegation revoke
    // later) makes this JWT fail with `agent_token_revoked` on the JwtAuthGuard, so
    // "close task" actually stops the agent inside the 10-minute TTL window.
    const accessToken = await this.jwt.signAsync(
      {
        sub: agent.ownerUserId,
        email: `agent:${agentId}`,
        agentId,
        agentTokenEpoch: agent.tokenEpoch,
        act: { sub: agentSubject(agentId) }, // RFC 8693 token-exchange actor claim
      },
      { expiresIn: AGENT_TOKEN_TTL },
    );
    return { accessToken, expiresIn: AGENT_TOKEN_TTL };
  }
}
