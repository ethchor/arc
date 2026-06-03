import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import type { MutablePolicyStore, Policy } from "@arc/grants";
import {
  PolicyAttachmentEntity,
  PolicyEntity,
  PolicyGroupAttachmentEntity,
  PolicyGroupMembershipEntity,
} from "../database/entities";

/**
 * Postgres-backed {@link MutablePolicyStore}. Policies survive restart, unlike the
 * in-memory store the GrantsService shipped with. The `@arc/grants` `PolicyEngine` reads
 * through `getPoliciesForSubject`; admin tooling mutates through the rest of the contract.
 *
 * Group resolution: `getPoliciesForSubject` is two→three indexed lookups —
 *   1. direct attachments by subject,
 *   2. group memberships by subject,
 *   3. group attachments by groupName (skipped if step 2 was empty),
 *   4. policies-by-name (single IN() across the union).
 * The CachingPolicyStore decorator memoizes this for 30s by default so the per-request
 * cost is amortized.
 */
@Injectable()
export class TypeOrmPolicyStore implements MutablePolicyStore {
  constructor(
    @InjectRepository(PolicyEntity)
    private readonly policies: Repository<PolicyEntity>,
    @InjectRepository(PolicyAttachmentEntity)
    private readonly attachments: Repository<PolicyAttachmentEntity>,
    @InjectRepository(PolicyGroupMembershipEntity)
    private readonly memberships: Repository<PolicyGroupMembershipEntity>,
    @InjectRepository(PolicyGroupAttachmentEntity)
    private readonly groupAttachments: Repository<PolicyGroupAttachmentEntity>,
  ) {}

  // -- policy CRUD --

  async upsertPolicy(policy: Policy): Promise<void> {
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

  async listPolicies(): Promise<Policy[]> {
    const rows = await this.policies.find();
    return rows.map(toPolicy);
  }

  // -- direct attachments --

  async attach(subject: string, policyName: string): Promise<void> {
    const policy = await this.policies.findOne({ where: { name: policyName } });
    if (!policy) throw new Error(`unknown policy: ${policyName}`);
    const existing = await this.attachments.findOne({ where: { subject, policyName } });
    if (existing) return;
    await this.attachments.save(this.attachments.create({ subject, policyName }));
  }

  async detach(subject: string, policyName: string): Promise<boolean> {
    const res = await this.attachments.delete({ subject, policyName });
    return (res.affected ?? 0) > 0;
  }

  // -- group memberships --

  async addToGroup(subject: string, groupName: string): Promise<void> {
    const existing = await this.memberships.findOne({ where: { subject, groupName } });
    if (existing) return;
    await this.memberships.save(this.memberships.create({ subject, groupName }));
  }

  async removeFromGroup(subject: string, groupName: string): Promise<boolean> {
    const res = await this.memberships.delete({ subject, groupName });
    return (res.affected ?? 0) > 0;
  }

  async listGroupsForSubject(subject: string): Promise<string[]> {
    const rows = await this.memberships.find({ where: { subject } });
    return [...new Set(rows.map((r) => r.groupName))].sort();
  }

  async listSubjectsInGroup(groupName: string): Promise<string[]> {
    const rows = await this.memberships.find({ where: { groupName } });
    return [...new Set(rows.map((r) => r.subject))].sort();
  }

  // -- group → policy --

  async attachToGroup(groupName: string, policyName: string): Promise<void> {
    const policy = await this.policies.findOne({ where: { name: policyName } });
    if (!policy) throw new Error(`unknown policy: ${policyName}`);
    const existing = await this.groupAttachments.findOne({ where: { groupName, policyName } });
    if (existing) return;
    await this.groupAttachments.save(this.groupAttachments.create({ groupName, policyName }));
  }

  async detachFromGroup(groupName: string, policyName: string): Promise<boolean> {
    const res = await this.groupAttachments.delete({ groupName, policyName });
    return (res.affected ?? 0) > 0;
  }

  async listGroupPolicies(groupName: string): Promise<string[]> {
    const rows = await this.groupAttachments.find({ where: { groupName } });
    return [...new Set(rows.map((r) => r.policyName))].sort();
  }

  // -- read path --

  async getPoliciesForSubject(subject: string): Promise<Policy[]> {
    const wanted = new Set<string>();

    const direct = await this.attachments.find({ where: { subject } });
    for (const r of direct) wanted.add(r.policyName);

    const groups = await this.memberships.find({ where: { subject } });
    if (groups.length > 0) {
      const groupNames = [...new Set(groups.map((g) => g.groupName))];
      const groupLinks = await this.groupAttachments.find({
        where: { groupName: In(groupNames) },
      });
      for (const r of groupLinks) wanted.add(r.policyName);
    }

    if (wanted.size === 0) return [];

    const rows = await this.policies.find({ where: { name: In([...wanted]) } });
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
