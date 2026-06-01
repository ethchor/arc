/**
 * Unit tests for GrantsService's store-delegation + the ARC_ROOT_USERS bootstrap. Uses the
 * in-memory store so it stays fast and free of a DataSource — the TypeORM store's own
 * behavior is exercised through the admin e2e suite against sql.js.
 */
import { InMemoryPolicyStore, scope } from "@arc/grants";
import { GrantsService, ROOT_POLICY_NAME, parseRootUsers } from "./grants.service";

describe("parseRootUsers", () => {
  it("splits, trims, and dedupes a comma list", () => {
    expect(parseRootUsers("1, 2 ,3,2")).toEqual(["1", "2", "3"]);
  });

  it("returns [] for undefined / empty / whitespace-only", () => {
    expect(parseRootUsers(undefined)).toEqual([]);
    expect(parseRootUsers("")).toEqual([]);
    expect(parseRootUsers("  , ,")).toEqual([]);
  });
});

describe("GrantsService — store delegation", () => {
  function make(defaultMode: "allow" | "deny" = "deny") {
    const store = new InMemoryPolicyStore();
    return { store, svc: new GrantsService(store, defaultMode) };
  }

  it("upsert + attach + decide flow through the injected store", async () => {
    const { svc } = make("deny");
    await svc.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    await svc.attach("42", "reader");

    const allow = await svc.decide("42", "secret/data/x", "read");
    expect(allow.decision).toBe("allow");
    const deny = await svc.decide("42", "secret/data/x", "delete");
    expect(deny.decision).toBe("deny");
  });

  it("removePolicy + detach return booleans from the store", async () => {
    const { svc } = make();
    await svc.upsertPolicy({ name: "p", scopes: [scope("a/", ["read"])] });
    await svc.attach("u", "p");
    expect(await svc.detach("u", "p")).toBe(true);
    expect(await svc.detach("u", "p")).toBe(false);
    expect(await svc.removePolicy("p")).toBe(true);
    expect(await svc.removePolicy("p")).toBe(false);
  });

  it("listPolicies returns what was upserted", async () => {
    const { svc } = make();
    await svc.upsertPolicy({ name: "a", scopes: [] });
    await svc.upsertPolicy({ name: "b", scopes: [scope("x/", ["list"])] });
    const names = (await svc.listPolicies()).map((p) => p.name).sort();
    expect(names).toEqual(["a", "b"]);
  });
});

describe("GrantsService — ARC_ROOT_USERS bootstrap (onModuleInit)", () => {
  const saved = process.env.ARC_ROOT_USERS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ARC_ROOT_USERS;
    else process.env.ARC_ROOT_USERS = saved;
  });

  it("seeds a sudo root policy + attaches it to each listed user", async () => {
    process.env.ARC_ROOT_USERS = "1,7";
    const store = new InMemoryPolicyStore();
    const svc = new GrantsService(store, "deny");
    await svc.onModuleInit();

    expect(store.listPolicies().map((p) => p.name)).toContain(ROOT_POLICY_NAME);
    // Both listed subjects can do anything (sudo on the empty prefix = all paths).
    expect((await svc.decide("1", "sys/policy", "create")).decision).toBe("allow");
    expect((await svc.decide("7", "secret/data/x", "delete")).decision).toBe("allow");
    // A non-root subject is still denied.
    expect((await svc.decide("99", "secret/data/x", "read")).decision).toBe("deny");
  });

  it("is a no-op when ARC_ROOT_USERS is unset", async () => {
    delete process.env.ARC_ROOT_USERS;
    const store = new InMemoryPolicyStore();
    const svc = new GrantsService(store, "deny");
    await svc.onModuleInit();
    expect(store.listPolicies()).toEqual([]);
  });
});
