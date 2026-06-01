import { LeaseError, LeaseManager, normalizeMount, type Lease } from "@arc/leasing";
import type {
  DynamicSecretsEngine,
  IssueOptions,
  IssuedCredential,
} from "@arc/secrets-engine";
import type { OpenBaoClient } from "./client";

const strip = (path: string): string => path.replace(/^\/+/, "");

/**
 * Database-creds engine backed by OpenBao. Maps arc's clean {@link DynamicSecretsEngine}
 * contract onto OpenBao's `database/creds/<role>` (issue) + `sys/leases/renew` (renew) +
 * `sys/leases/revoke` (revoke) HTTP layout.
 *
 * The {@link LeaseManager} held here is arc's authority for lease ids: callers see the
 * arc-internal lease id (a UUID), the backend OpenBao lease id is stashed in
 * `lease.backendLeaseId` and used to drive the upstream lifecycle. This keeps the wire
 * shape arc owns clean (no leaking OpenBao's "database/creds/role/abc123" form to clients)
 * and gives arc a single revocation point even when several engines back the same mount.
 *
 * Default TTL (when the backend response omits `lease_duration`) is 1h.
 */
export class OpenBaoDatabaseEngine implements DynamicSecretsEngine {
  readonly type = "database" as const;
  readonly mount: string;

  constructor(
    private readonly client: OpenBaoClient,
    private readonly leases: LeaseManager,
    mount = "database",
  ) {
    this.mount = normalizeMount(mount);
  }

  async issue(role: string, opts: IssueOptions = {}): Promise<IssuedCredential> {
    const res = await this.client.read(`${this.mount}creds/${strip(role)}`);
    const ttlFromBackend = Number(res.lease_duration ?? 0);
    const ttlSeconds = opts.ttlSeconds ?? (ttlFromBackend > 0 ? ttlFromBackend : 3600);
    const lease = this.leases.issue({
      mount: this.mount,
      ttlSeconds,
      maxTtlSeconds: ttlSeconds,
      renewable: res.renewable !== false,
      backendLeaseId: typeof res.lease_id === "string" && res.lease_id.length > 0
        ? res.lease_id
        : undefined,
    });
    return { data: (res.data ?? {}) as Record<string, unknown>, lease };
  }

  async renew(leaseId: string, incrementSeconds?: number): Promise<Lease> {
    const lease = this.requireLease(leaseId);
    if (!lease.renewable) {
      throw new LeaseError("not_renewable", `lease ${leaseId} is not renewable`);
    }
    const increment = incrementSeconds ?? lease.ttlSeconds;
    let newTtl = increment;
    if (lease.backendLeaseId) {
      const res = await this.client.write("sys/leases/renew", {
        lease_id: lease.backendLeaseId,
        increment,
      });
      newTtl = Number(res.lease_duration ?? increment);
    }
    return this.leases.renew(leaseId, newTtl);
  }

  async revoke(leaseId: string): Promise<void> {
    const lease = this.requireLease(leaseId);
    if (lease.backendLeaseId) {
      // OpenBao accepts both `PUT sys/leases/revoke/<id>` and `POST sys/leases/revoke
      // {lease_id}`; we use the body form so URL-encoding the backend id (it contains
      // slashes) doesn't bite us.
      await this.client.write("sys/leases/revoke", { lease_id: lease.backendLeaseId });
    }
    this.leases.revoke(leaseId);
  }

  private requireLease(leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new LeaseError("not_found", `no lease ${leaseId}`);
    return lease;
  }
}
