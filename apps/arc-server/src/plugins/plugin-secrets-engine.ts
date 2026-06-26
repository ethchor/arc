import { LeaseError, normalizeMount, type Lease, type LeaseManager } from "@arc/leasing";
import type {
  DynamicSecretsEngine,
  IssueOptions,
  IssuedCredential,
} from "@arc/secrets-engine";
import type { SecretsPlugin } from "@arc/plugin-sdk";

/**
 * Adapter shim: turns a {@link SecretsPlugin} (the plugin-author-facing contract) into a
 * {@link DynamicSecretsEngine} that the arc-server dispatcher can route to. Plugins manage
 * their own backend lease ids; the shared {@link LeaseManager} owns the arc-internal ids
 * and stores the plugin's id as `lease.backendLeaseId`. Same indirection the OpenBao DB
 * adapter uses — every dynamic mount, plugin or built-in, shares one revocation surface.
 *
 * Note: this never touches the master key or any other piece of the Engine-B vault.
 * Plugins only see the `IssueRequest` they were given.
 */
export class PluginSecretsEngine implements DynamicSecretsEngine {
  readonly type: string;
  readonly mount: string;

  constructor(
    private readonly plugin: SecretsPlugin,
    private readonly leases: LeaseManager,
    mountPath: string,
  ) {
    this.mount = normalizeMount(mountPath);
    // Engines pick a literal type string ("kv-v2", "database", …). Plugins get a
    // namespaced one so listMounts() can show "plugin:aws", "plugin:github" etc.
    this.type = `plugin:${plugin.meta.name}`;
  }

  async issue(role: string, opts: IssueOptions = {}): Promise<IssuedCredential> {
    const issued = await this.plugin.issue({
      role,
      ttlSeconds: opts.ttlSeconds,
      params: opts.params,
    });
    const lease = await this.leases.issue({
      mount: this.mount,
      ttlSeconds: issued.ttlSeconds,
      maxTtlSeconds: issued.ttlSeconds,
      renewable: issued.renewable,
      backendLeaseId: issued.leaseId,
    });
    return { data: issued.data, lease };
  }

  async renew(leaseId: string, incrementSeconds?: number): Promise<Lease> {
    const lease = await this.requireLease(leaseId);
    if (!lease.renewable) {
      throw new LeaseError("not_renewable", `lease ${leaseId} is not renewable`);
    }
    if (!lease.backendLeaseId) {
      throw new LeaseError("not_found", `no backend lease for ${leaseId}`);
    }
    const renewed = await this.plugin.renew(lease.backendLeaseId);
    return this.leases.renew(leaseId, renewed.ttlSeconds ?? incrementSeconds ?? lease.ttlSeconds);
  }

  async revoke(leaseId: string): Promise<void> {
    const lease = await this.requireLease(leaseId);
    if (lease.backendLeaseId) {
      await this.plugin.revoke(lease.backendLeaseId);
    }
    await this.leases.revoke(leaseId);
  }

  /**
   * Plugin SDKs don't expose a uniform `listRoles` today — role discovery is plugin-
   * specific (some hard-code, some read from their config). Return `[]` for now; the
   * dispatcher renders this as an honest "no roles discoverable" empty state. Plugins
   * that want to surface roles in the operator UI can opt-in once arc-plugin-sdk gains
   * a discovery method.
   */
  async listRoles(): Promise<string[]> {
    return [];
  }

  private async requireLease(leaseId: string): Promise<Lease> {
    const lease = await this.leases.get(leaseId);
    if (!lease) throw new LeaseError("not_found", `no lease ${leaseId}`);
    return lease;
  }
}
