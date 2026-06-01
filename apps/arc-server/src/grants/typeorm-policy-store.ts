import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import type { MutablePolicyStore, Policy } from "@arc/grants";
import { PolicyAttachmentEntity, PolicyEntity } from "../database/entities";

/**
 * Postgres-backed {@link MutablePolicyStore}. Policies survive restart, unlike the
 * in-memory store the GrantsService shipped with. The `@arc/grants` `PolicyEngine` reads
 * through `getPoliciesForSubject`; admin tooling mutates through the rest of the contract.
 *
 * The engine calls `getPoliciesForSubject` on every `/v1/*` request via `CapabilityGuard`,
 * so it's two indexed lookups (attachments-by-subject, then policies-by-name). A short-TTL
 * cache is a reasonable later optimization; correctness first.
 */
@Injectable()
export class TypeOrmPolicyStore implements MutablePolicyStore {
  constructor(
    @InjectRepository(PolicyEntity)
    private readonly policies: Repository<PolicyEntity>,
    @InjectRepository(PolicyAttachmentEntity)
    private readonly attachments: Repository<PolicyAttachmentEntity>,
  ) {}

  async upsertPolicy(policy: Policy): Promise<void> {
    // save() upserts on the primary key (name): a re-`upsert` replaces the scopes wholesale,
    // matching the in-memory store's Map.set semantics.
    await this.policies.save(
      this.policies.create({
        name: policy.name,
        scopes: policy.scopes.map((s) => ({
          pathPrefix: s.pathPrefix,
          capabilities: [...s.capabilities],
        })),
      }),
    );
  }

  async removePolicy(name: string): Promise<boolean> {
    const res = await this.policies.delete({ name });
    return (res.affected ?? 0) > 0;
  }

  async attach(subject: string, policyName: string): Promise<void> {
    const policy = await this.policies.findOne({ where: { name: policyName } });
    if (!policy) throw new Error(`unknown policy: ${policyName}`);
    // Idempotent: skip if this (subject, policy) pair already exists. The unique constraint
    // is the backstop, but checking first avoids a noisy duplicate-key error in the logs.
    const existing = await this.attachments.findOne({ where: { subject, policyName } });
    if (existing) return;
    await this.attachments.save(this.attachments.create({ subject, policyName }));
  }

  async detach(subject: string, policyName: string): Promise<boolean> {
    const res = await this.attachments.delete({ subject, policyName });
    return (res.affected ?? 0) > 0;
  }

  async listPolicies(): Promise<Policy[]> {
    const rows = await this.policies.find();
    return rows.map(toPolicy);
  }

  async getPoliciesForSubject(subject: string): Promise<Policy[]> {
    const links = await this.attachments.find({ where: { subject } });
    if (links.length === 0) return [];
    // Dedup names before the IN() (a subject could in theory have the same policy twice if
    // the unique constraint were ever relaxed; cheap insurance).
    const names = [...new Set(links.map((l) => l.policyName))];
    const rows = await this.policies.find({ where: { name: In(names) } });
    // Stale attachments (policy removed but link lingered) simply don't appear in `rows`.
    return rows.map(toPolicy);
  }
}

function toPolicy(row: PolicyEntity): Policy {
  return {
    name: row.name,
    scopes: row.scopes.map((s) => ({
      pathPrefix: s.pathPrefix,
      capabilities: s.capabilities as Policy["scopes"][number]["capabilities"],
    })),
  };
}
