import { describe, expect, it, vi } from "vitest";
import { LeaseManager, LeaseError } from "@arc/leasing";
import { OpenBaoClient, OpenBaoDatabaseEngine } from "../src/index";
import type { FetchInit } from "../src/index";

function fakeFetch(
  handler: (url: string, init: FetchInit) => { status: number; body?: unknown },
) {
  return vi.fn(async (url: string, init?: FetchInit) => {
    const { status, body } = handler(url, init ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    };
  });
}

let counter = 0;
const seqId = () => `lease-${++counter}`;

describe("OpenBaoDatabaseEngine.issue", () => {
  it("hits database/creds/<role> and mints an arc lease around the backend lease", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/database/creds/app");
      expect(init.method).toBe("GET");
      return {
        status: 200,
        body: {
          data: { username: "v-token-app-12345", password: "AB1234" },
          lease_id: "database/creds/app/abcdef",
          lease_duration: 3600,
          renewable: true,
        },
      };
    });
    const leases = new LeaseManager({ idGen: seqId });
    const db = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
      leases,
    );

    const issued = await db.issue("app");
    expect(issued.data).toEqual({ username: "v-token-app-12345", password: "AB1234" });
    expect(issued.lease.mount).toBe("database/");
    expect(issued.lease.ttlSeconds).toBe(3600);
    expect(issued.lease.renewable).toBe(true);
    expect(issued.lease.backendLeaseId).toBe("database/creds/app/abcdef");
    expect(leases.get(issued.lease.id)?.id).toBe(issued.lease.id);
  });

  it("falls back to a 1h default TTL when the backend omits lease_duration", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 200,
      body: { data: { username: "u", password: "p" }, lease_id: "x/y/z", renewable: true },
    }));
    const leases = new LeaseManager({ idGen: seqId });
    const db = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", fetchFn }),
      leases,
    );
    const issued = await db.issue("app");
    expect(issued.lease.ttlSeconds).toBe(3600);
  });

  it("honors the caller's ttlSeconds override even when the backend reports a different TTL", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 200,
      body: {
        data: { username: "u", password: "p" },
        lease_id: "x/y/z",
        lease_duration: 60,
        renewable: true,
      },
    }));
    const leases = new LeaseManager({ idGen: seqId });
    const db = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", fetchFn }),
      leases,
    );
    const issued = await db.issue("app", { ttlSeconds: 300 });
    expect(issued.lease.ttlSeconds).toBe(300);
  });
});

describe("OpenBaoDatabaseEngine.renew", () => {
  it("renews the backend lease and extends the arc lease by the returned increment", async () => {
    let issued = false;
    const fetchFn = fakeFetch((url, init) => {
      if (url.endsWith("/v1/database/creds/app")) {
        issued = true;
        return {
          status: 200,
          body: {
            data: { username: "u", password: "p" },
            lease_id: "database/creds/app/abcdef",
            lease_duration: 60,
            renewable: true,
          },
        };
      }
      expect(url).toBe("http://bao:8200/v1/sys/leases/renew");
      const body = JSON.parse(init.body!) as Record<string, unknown>;
      expect(body.lease_id).toBe("database/creds/app/abcdef");
      expect(body.increment).toBe(120);
      return { status: 200, body: { lease_id: body.lease_id, lease_duration: 120, renewable: true } };
    });
    const leases = new LeaseManager({ idGen: seqId });
    const db = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", fetchFn }),
      leases,
    );
    const i = await db.issue("app", { ttlSeconds: 60 });
    expect(issued).toBe(true);

    // Allow arc to extend beyond its issued ttl: lease ceiling = ttl, so override here.
    const lease = leases.get(i.lease.id)!;
    (lease as { maxTtlSeconds: number }).maxTtlSeconds = 600;

    const renewed = await db.renew(i.lease.id, 120);
    expect(renewed.id).toBe(i.lease.id);
    // The renewed expiry sits 120s past now (LeaseManager renews from now, not from prior expiry).
    expect(renewed.expiresAt - Date.now()).toBeGreaterThan(110_000);
    expect(renewed.expiresAt - Date.now()).toBeLessThan(125_000);
  });

  it("refuses to renew a lease that was issued non-renewable", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 200,
      body: {
        data: { username: "u", password: "p" },
        lease_id: "x/y/z",
        lease_duration: 60,
        renewable: false,
      },
    }));
    const leases = new LeaseManager({ idGen: seqId });
    const db = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", fetchFn }),
      leases,
    );
    const i = await db.issue("app");
    await expect(db.renew(i.lease.id)).rejects.toThrow(LeaseError);
  });

  it("throws not_found when renewing an unknown lease", async () => {
    const fetchFn = fakeFetch(() => ({ status: 200 }));
    const leases = new LeaseManager({ idGen: seqId });
    const db = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", fetchFn }),
      leases,
    );
    await expect(db.renew("nope")).rejects.toThrow(/not_found|no lease/);
  });
});

describe("OpenBaoDatabaseEngine.revoke", () => {
  it("posts the backend lease id to sys/leases/revoke and marks the arc lease revoked", async () => {
    let revokeCalled = false;
    const fetchFn = fakeFetch((url, init) => {
      if (url.endsWith("/v1/database/creds/app")) {
        return {
          status: 200,
          body: {
            data: { username: "u", password: "p" },
            lease_id: "database/creds/app/zzz",
            lease_duration: 60,
            renewable: true,
          },
        };
      }
      revokeCalled = true;
      expect(url).toBe("http://bao:8200/v1/sys/leases/revoke");
      expect(JSON.parse(init.body!)).toEqual({ lease_id: "database/creds/app/zzz" });
      return { status: 204 };
    });
    const leases = new LeaseManager({ idGen: seqId });
    const db = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", fetchFn }),
      leases,
    );
    const i = await db.issue("app");
    await db.revoke(i.lease.id);
    expect(revokeCalled).toBe(true);
    expect(leases.state(i.lease.id)).toBe("revoked");
  });

  it("respects a custom mount path on issue + revoke", async () => {
    let issueUrl = "";
    const fetchFn = fakeFetch((url) => {
      issueUrl = url;
      return {
        status: 200,
        body: {
          data: { username: "u", password: "p" },
          lease_id: "db-prod/creds/app/aaa",
          lease_duration: 60,
          renewable: true,
        },
      };
    });
    const leases = new LeaseManager({ idGen: seqId });
    const db = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", fetchFn }),
      leases,
      "db-prod",
    );
    expect(db.mount).toBe("db-prod/");
    await db.issue("app");
    expect(issueUrl).toBe("http://bao:8200/v1/db-prod/creds/app");
  });

  it("listRoles LISTs <mount>/roles and folds a 404 (empty mount) into []", async () => {
    const ok = fakeFetch((url, init) => {
      expect(init.method).toBe("LIST");
      expect(url).toBe("http://bao:8200/v1/database/roles");
      return { status: 200, body: { data: { keys: ["app-prod", "app-stage"] } } };
    });
    const db1 = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "t", fetchFn: ok }),
      new LeaseManager(),
    );
    expect(await db1.listRoles()).toEqual(["app-prod", "app-stage"]);

    const empty = fakeFetch(() => ({ status: 404, body: { errors: [] } }));
    const db2 = new OpenBaoDatabaseEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "t", fetchFn: empty }),
      new LeaseManager(),
    );
    expect(await db2.listRoles()).toEqual([]);
  });
});
