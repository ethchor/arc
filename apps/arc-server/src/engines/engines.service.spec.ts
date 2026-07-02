/**
 * Unit tests for {@link EnginesService}'s lease lifecycle. Avoids spinning up a real
 * OpenBao + DB stack by injecting an `EnginesConfig` with a fake `DynamicSecretsEngine`
 * that drives `LeaseManager` directly. This exercises:
 *
 *   - `GET /v1/database/creds/<role>` dispatch — service finds the mount, calls engine.issue,
 *     and maps the lease into Vault's wire shape (`lease_id`/`lease_duration`/`renewable`).
 *   - `POST /v1/sys/leases/renew` — service looks the arc lease up in {@link LeaseManager},
 *     routes to the engine for that mount, and surfaces the renewed TTL.
 *   - `POST /v1/sys/leases/revoke` — same routing, plus a 400 when the lease was already
 *     revoked (LeaseError translation).
 *   - "mount has no dynamic engine" — service refuses to renew/revoke a lease that lives at
 *     a non-dynamic mount (KV / transit / PKI today).
 */
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { LeaseManager, type Lease } from "@arc/leasing";
import {
  MountRegistry,
  type DynamicSecretsEngine,
  type IssuedCredential,
  type SecretsEngine,
} from "@arc/secrets-engine";
import { EnginesService, type EnginesConfig } from "./engines.service";
import type { GrantsService } from "../grants/grants.service";

/** Grants stub for the SEC-H5 tests: denies `decide` on the listed mounts, allows the rest. */
function denyGrantsOn(...deniedMounts: string[]): GrantsService {
  const denied = new Set(deniedMounts);
  return {
    decide: async (_subject: string, path: string) =>
      denied.has(path)
        ? { decision: "deny", reason: "no-matching-scope", policies: [] }
        : { decision: "allow", reason: "scope-match", policies: [] },
  } as unknown as GrantsService;
}

class FakeDatabaseEngine implements DynamicSecretsEngine {
  readonly type = "database" as const;
  readonly mount = "database/";
  constructor(private readonly leases: LeaseManager) {}

  async issue(role: string): Promise<IssuedCredential> {
    const lease = await this.leases.issue({
      mount: this.mount,
      ttlSeconds: 60,
      maxTtlSeconds: 600,
      renewable: true,
      backendLeaseId: `database/creds/${role}/backend-${role}`,
    });
    return { data: { username: `v-${role}`, password: "secret" }, lease };
  }

  async renew(leaseId: string, increment?: number): Promise<Lease> {
    return this.leases.renew(leaseId, increment ?? 60);
  }

  async revoke(leaseId: string): Promise<void> {
    await this.leases.revoke(leaseId);
  }

  /** Required by {@link DynamicSecretsEngine} since #111 added role discovery. Tests that
   *  need a non-empty list can stub the method per-case; the default works for the
   *  existing issue/renew/revoke lifecycle tests that don't exercise role listing. */
  async listRoles(): Promise<string[]> {
    return [];
  }
}

class FakeKvEngine implements SecretsEngine {
  readonly type = "kv-v2" as const;
  readonly mount = "secret/";
}

function makeService(
  grants?: GrantsService,
): { service: EnginesService; leases: LeaseManager; engine: FakeDatabaseEngine } {
  const registry = new MountRegistry();
  registry.mount({ path: "database/", type: "database" });
  registry.mount({ path: "secret/", type: "kv-v2" });
  const leases = new LeaseManager();
  const engine = new FakeDatabaseEngine(leases);
  const enginesByMount = new Map<string, SecretsEngine>();
  enginesByMount.set("database/", engine);
  enginesByMount.set("secret/", new FakeKvEngine());
  // A non-null `client` placeholder so requireClient() does not throw 503. The unit test
  // doesn't exercise any OpenBao HTTP call so the value is never dereferenced.
  const config: EnginesConfig = {
    client: {} as never,
    registry,
    enginesByMount,
    leases,
    manifestCapsByMount: new Map(),
  };
  return { service: new EnginesService(config, grants), leases, engine };
}

describe("EnginesService — database/creds + sys/leases lifecycle", () => {
  it("dispatches GET database/creds/<role> to the engine and returns the Vault wire shape", async () => {
    const { service } = makeService();
    const res = await service.get("database/creds/app", {});
    expect(res.data).toEqual({ username: "v-app", password: "secret" });
    expect(typeof res.lease_id).toBe("string");
    // lease_duration is derived from (expiresAt - now) so floor() can shave 1s on a
    // slow CI runner. Assert the range, not an exact value (the deterministic check on
    // the underlying LeaseManager TTL lives in @arc/leasing's own tests).
    expect(res.lease_duration).toBeGreaterThanOrEqual(59);
    expect(res.lease_duration).toBeLessThanOrEqual(60);
    expect(res.renewable).toBe(true);
  });

  it("renewLease extends an existing lease via the engine", async () => {
    const { service } = makeService();
    const issued = await service.get("database/creds/app", {});
    const leaseId = issued.lease_id as string;

    const renewed = await service.renewLease(leaseId, 120);
    expect(renewed.lease_id).toBe(leaseId);
    // Same range tolerance as the issue assertion — floor() can shave 1s.
    expect(renewed.lease_duration).toBeGreaterThanOrEqual(119);
    expect(renewed.lease_duration).toBeLessThanOrEqual(120);
    expect(renewed.renewable).toBe(true);
  });

  it("revokeLease removes the lease via the engine and refuses subsequent renewals", async () => {
    const { service, leases } = makeService();
    const issued = await service.get("database/creds/app", {});
    const leaseId = issued.lease_id as string;

    await service.revokeLease(leaseId);
    expect(await leases.state(leaseId)).toBe("revoked");

    // Renewing a revoked lease surfaces as a 400 — LeaseError is translated.
    await expect(service.renewLease(leaseId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("renewLease returns 404 when the lease id is unknown", async () => {
    const { service } = makeService();
    await expect(service.renewLease("does-not-exist")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("renewLease returns 400 when the lease lives at a non-dynamic mount", async () => {
    const { service, leases } = makeService();
    // Mint a lease directly at the KV mount (no engine.issue path here — simulating a
    // misrouted lease so we can hit the "engine does not support leasing" branch).
    const lease = await leases.issue({ mount: "secret/", ttlSeconds: 60 });
    await expect(service.renewLease(lease.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.revokeLease(lease.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  // SEC-H5 (#147): renew/revoke authorize against the *target lease's mount*, not just the
  // sys/leases URL path the CapabilityGuard already checked.
  it("renewLease throws Forbidden and does NOT renew when the subject lacks capability on the lease mount", async () => {
    const { service, leases } = makeService(denyGrantsOn("database/"));
    const leaseId = (await service.get("database/creds/app", {})).lease_id as string;
    const before = await leases.get(leaseId);
    await expect(service.renewLease(leaseId, 3600, "42")).rejects.toBeInstanceOf(ForbiddenException);
    const after = await leases.get(leaseId);
    expect(after!.expiresAt).toBe(before!.expiresAt); // TTL untouched
    expect(await leases.state(leaseId)).toBe("active");
  });

  it("revokeLease throws Forbidden and does NOT revoke when the subject lacks capability on the lease mount", async () => {
    const { service, leases } = makeService(denyGrantsOn("database/"));
    const leaseId = (await service.get("database/creds/app", {})).lease_id as string;
    await expect(service.revokeLease(leaseId, "42")).rejects.toBeInstanceOf(ForbiddenException);
    expect(await leases.state(leaseId)).toBe("active"); // NOT revoked
  });

  it("renew + revoke succeed when the subject holds capability on the lease mount", async () => {
    const { service, leases } = makeService(denyGrantsOn("other/")); // allows database/
    const leaseId = (await service.get("database/creds/app", {})).lease_id as string;
    await expect(service.renewLease(leaseId, 120, "42")).resolves.toBeDefined();
    await service.revokeLease(leaseId, "42");
    expect(await leases.state(leaseId)).toBe("revoked");
  });
});
