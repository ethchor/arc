import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import {
  PolicyEngine,
  scope,
  type Capability,
  type DefaultMode,
  type DetailedDecision,
  type MutablePolicyStore,
  type Policy,
} from "@arc/grants";

export const GRANTS_DEFAULT_MODE = Symbol("GRANTS_DEFAULT_MODE");
export const POLICY_STORE = Symbol("POLICY_STORE");

/** Policy name seeded for `ARC_ROOT_USERS`. A `sudo` grant on the empty prefix = all paths. */
export const ROOT_POLICY_NAME = "root";

/**
 * Grants service backed by an injected {@link MutablePolicyStore} (the TypeORM store in
 * production, an in-memory store in unit tests) + a {@link PolicyEngine}. The default mode
 * (allow vs deny on a subject with no policies) is injected so `GrantsModule` can read it
 * from env once at boot:
 *
 *   `ARC_DEFAULT_POLICY=allow` → permissive, the dev/test default.
 *   `ARC_DEFAULT_POLICY=deny`  → fail-closed, the production posture.
 *
 * Bootstrap: `ARC_ROOT_USERS=1,2` seeds a `root` policy (`sudo` on every path) and attaches
 * it to those user ids on boot. This breaks the chicken-and-egg of `deny` mode — without a
 * root user, nobody could ever reach `/v1/sys/policy` to grant the first policy.
 */
@Injectable()
export class GrantsService implements OnModuleInit {
  private readonly logger = new Logger(GrantsService.name);
  readonly engine: PolicyEngine;
  readonly defaultMode: DefaultMode;

  constructor(
    @Inject(POLICY_STORE) private readonly store: MutablePolicyStore,
    @Inject(GRANTS_DEFAULT_MODE) defaultMode: DefaultMode,
  ) {
    this.defaultMode = defaultMode;
    this.engine = new PolicyEngine({ store, defaultMode });
    this.logger.log(`GrantsService initialized (defaultMode=${defaultMode})`);
  }

  /** Seed the root policy + attachments from `ARC_ROOT_USERS` once the DB is ready. */
  async onModuleInit(): Promise<void> {
    const roots = parseRootUsers(process.env.ARC_ROOT_USERS);
    if (roots.length === 0) {
      if (this.defaultMode === "deny") {
        this.logger.warn(
          "ARC_DEFAULT_POLICY=deny but ARC_ROOT_USERS is unset — no subject can manage " +
            "policies. Set ARC_ROOT_USERS to a comma-separated list of user ids to bootstrap.",
        );
      }
      return;
    }
    await this.store.upsertPolicy({ name: ROOT_POLICY_NAME, scopes: [scope("", ["sudo"])] });
    for (const subject of roots) {
      await this.store.attach(subject, ROOT_POLICY_NAME);
    }
    this.logger.log(`seeded "${ROOT_POLICY_NAME}" policy for subjects: ${roots.join(", ")}`);
  }

  async upsertPolicy(policy: Policy): Promise<void> {
    await this.store.upsertPolicy(policy);
  }

  async removePolicy(name: string): Promise<boolean> {
    return this.store.removePolicy(name);
  }

  async attach(subject: string, policyName: string): Promise<void> {
    await this.store.attach(subject, policyName);
  }

  async detach(subject: string, policyName: string): Promise<boolean> {
    return this.store.detach(subject, policyName);
  }

  async listPolicies(): Promise<Policy[]> {
    return this.store.listPolicies();
  }

  // -- groups (delegate to the store; the cache layer handles invalidation) --

  async addToGroup(subject: string, groupName: string): Promise<void> {
    await this.store.addToGroup(subject, groupName);
  }

  async removeFromGroup(subject: string, groupName: string): Promise<boolean> {
    return this.store.removeFromGroup(subject, groupName);
  }

  async attachToGroup(groupName: string, policyName: string): Promise<void> {
    await this.store.attachToGroup(groupName, policyName);
  }

  async detachFromGroup(groupName: string, policyName: string): Promise<boolean> {
    return this.store.detachFromGroup(groupName, policyName);
  }

  async listGroupsForSubject(subject: string): Promise<string[]> {
    return this.store.listGroupsForSubject(subject);
  }

  async listSubjectsInGroup(groupName: string): Promise<string[]> {
    return this.store.listSubjectsInGroup(groupName);
  }

  async listGroupPolicies(groupName: string): Promise<string[]> {
    return this.store.listGroupPolicies(groupName);
  }

  decide(subject: string, path: string, capability: Capability): Promise<DetailedDecision> {
    return Promise.resolve(this.engine.decideDetailed(subject, path, capability));
  }
}

/** Parse `ARC_ROOT_USERS` ("1, 2 ,3") into a deduped list of non-empty subject strings. */
export function parseRootUsers(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
}
