import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  InMemoryPolicyStore,
  PolicyEngine,
  type Capability,
  type DefaultMode,
  type DetailedDecision,
  type Policy,
} from "@arc/grants";

export const GRANTS_DEFAULT_MODE = Symbol("GRANTS_DEFAULT_MODE");

/**
 * Process-local grants service backed by an {@link InMemoryPolicyStore} + {@link PolicyEngine}.
 * The default mode (allow vs deny on a subject with no policies) is injected so the
 * `AppModule` can read it from env once at boot:
 *
 *   `ARC_DEFAULT_POLICY=allow` → permissive, the dev/test default (keeps existing tests
 *     passing while ACL admin tooling is built out).
 *   `ARC_DEFAULT_POLICY=deny`  → fail-closed, the production posture.
 *
 * Persistence will move to Postgres in a follow-up; the contract `@arc/grants` exposes is
 * store-agnostic, so swapping the in-memory store for a TypeORM-backed one is a small diff
 * here without touching the engine.
 */
@Injectable()
export class GrantsService {
  private readonly logger = new Logger(GrantsService.name);
  readonly store = new InMemoryPolicyStore();
  readonly engine: PolicyEngine;
  readonly defaultMode: DefaultMode;

  constructor(@Inject(GRANTS_DEFAULT_MODE) defaultMode: DefaultMode) {
    this.defaultMode = defaultMode;
    this.engine = new PolicyEngine({ store: this.store, defaultMode });
    this.logger.log(`GrantsService initialized (defaultMode=${defaultMode})`);
  }

  upsertPolicy(policy: Policy): void {
    this.store.upsertPolicy(policy);
  }

  attach(subject: string, policyName: string): void {
    this.store.attach(subject, policyName);
  }

  detach(subject: string, policyName: string): boolean {
    return this.store.detach(subject, policyName);
  }

  listPolicies(): Policy[] {
    return this.store.listPolicies();
  }

  decide(subject: string, path: string, capability: Capability): Promise<DetailedDecision> {
    return Promise.resolve(this.engine.decideDetailed(subject, path, capability));
  }
}
