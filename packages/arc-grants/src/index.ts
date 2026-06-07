export type {
  Capability,
  Decision,
  DefaultMode,
  MutablePolicyStore,
  Policy,
  PolicyStore,
  Scope,
} from "./types";
export { normalizePrefix, scope, scopeAllows } from "./scope";
export { effectiveAllows, intersectScopes } from "./intersect";
export { PolicyEngine } from "./engine";
export type { DetailedDecision, PolicyEngineOptions } from "./engine";
export { InMemoryPolicyStore } from "./in-memory-store";
export { CachingPolicyStore } from "./caching-store";
export type { CachingPolicyStoreOptions } from "./caching-store";
