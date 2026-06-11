import { SetMetadata } from "@nestjs/common";

/**
 * Reflection key for {@link AgentTokenAllowed}. Read by {@link JwtAuthGuard} to decide
 * whether an agent-issued JWT (the kind minted by `POST /vault/agents/:id/auth/token`,
 * carrying `agentId` per ADR-005) is accepted on a given route.
 *
 * Without this marker, an agent token is rejected. Agent tokens authenticate the
 * **agent**, not its owner — they exist so an agent can submit its own signed intents.
 * Letting them act *as* the owner on the data path (Engine-B vaults, Engine-A `/v1/*`,
 * the agent control plane) is the CRIT-1 bypass that defeats the entire delegation /
 * intent / CIBA / budget chain.
 */
export const AGENT_TOKEN_ALLOWED_KEY = "arc:agent-token-allowed";

/**
 * Mark a route handler as accepting an agent-issued JWT in addition to a user session.
 * Apply sparingly: today only `POST /vault/agents/:id/intents` carries this annotation.
 * Owner-issued sessions remain accepted on every route (the marker doesn't restrict
 * *to* agents, it just permits them).
 */
export const AgentTokenAllowed = (): MethodDecorator =>
  SetMetadata(AGENT_TOKEN_ALLOWED_KEY, true);
