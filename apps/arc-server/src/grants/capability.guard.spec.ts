/**
 * Unit tests for {@link CapabilityGuard}'s method→capability mapping and decision plumbing.
 * The "real" Engine-A-with-ACL path is covered in the engines e2e suite; this spec stays
 * narrow on the guard's own logic so a regression here points at the right line.
 */
import { BadRequestException, ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { InMemoryPolicyStore, scope } from "@arc/grants";
import { MetricsService } from "../observability/metrics.service";
import { CapabilityGuard, pickCapability, stripV1Prefix } from "./capability.guard";
import { GrantsService } from "./grants.service";

function fakeCtx(req: {
  method: string;
  url: string;
  user?: { userId: number; email: string };
  query?: Record<string, unknown>;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}) as unknown as object,
      getNext: () => ({}) as unknown as object,
    }),
    // LOW-E: the guard calls `reflector.getAllAndOverride(...)` against handler+class
    // metadata to honour `@RequireCapability()`. The Reflector accepts arbitrary keys
    // on either reference, so empty stubs reproduce "no override declared" → falls
    // through to the HTTP method → capability mapping (the legacy behaviour).
    getHandler: () => (() => undefined),
    getClass: () => (class EmptyContext {}),
  } as unknown as ExecutionContext;
}

describe("stripV1Prefix", () => {
  it("strips the /v1/ prefix + the query string", () => {
    expect(stripV1Prefix("/v1/secret/data/x?foo=bar")).toBe("secret/data/x");
  });

  it("returns the bare path when /v1/ is missing", () => {
    expect(stripV1Prefix("/something/else")).toBe("something/else");
  });
});

describe("pickCapability", () => {
  it("maps GET → read by default", () => {
    expect(pickCapability("GET", "secret/data/x", {})).toBe("read");
  });

  it("maps GET ?list=true → list (so list policies don't grant read)", () => {
    expect(pickCapability("GET", "pki/certs", { list: "true" })).toBe("list");
    expect(pickCapability("GET", "pki/certs", { list: "1" })).toBe("list");
  });

  it("maps POST → create, PUT → update, DELETE → delete", () => {
    expect(pickCapability("POST", "x", {})).toBe("create");
    expect(pickCapability("PUT", "x", {})).toBe("update");
    expect(pickCapability("DELETE", "x", {})).toBe("delete");
  });

  it("falls back to sudo for unknown HTTP verbs (conservative)", () => {
    expect(pickCapability("BREW", "x", {})).toBe("sudo");
  });
});

describe("CapabilityGuard", () => {
  function makeGuard(defaultMode: "allow" | "deny" = "deny") {
    const store = new InMemoryPolicyStore();
    const grants = new GrantsService(store, defaultMode);
    const metrics = new MetricsService();
    // LOW-E: the guard now reads `@RequireCapability()` metadata via Reflector. The spec
    // exercises ExecutionContext stubs that don't carry that metadata, so a vanilla
    // Reflector — which returns undefined for unset keys — preserves the legacy
    // method→capability behaviour for these test fixtures.
    const reflector = new Reflector();
    const guard = new CapabilityGuard(grants, metrics, reflector);
    return { grants, guard, store, metrics };
  }

  it("skips non-/v1 paths entirely (the Vault membership ACL handles those)", async () => {
    const { guard } = makeGuard("deny");
    const ctx = fakeCtx({ method: "GET", url: "/vaults/abc/items?since=0", user: { userId: 1, email: "a" } });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it("denies a /v1 request when defaultMode=deny and the user has no policies", async () => {
    const { guard } = makeGuard("deny");
    const ctx = fakeCtx({ method: "GET", url: "/v1/secret/data/x", user: { userId: 1, email: "a" } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows a /v1 request when defaultMode=allow and the user has no policies", async () => {
    const { guard } = makeGuard("allow");
    const ctx = fakeCtx({ method: "GET", url: "/v1/secret/data/x", user: { userId: 1, email: "a" } });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it("allows when a covering scope is attached, even under defaultMode=deny", async () => {
    const { guard, grants } = makeGuard("deny");
    await grants.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    await grants.attach("1", "reader");

    const ctx = fakeCtx({ method: "GET", url: "/v1/secret/data/x", user: { userId: 1, email: "a" } });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it("denies covered path with uncovered capability (the scope only grants read, not delete)", async () => {
    const { guard, grants } = makeGuard("deny");
    await grants.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    await grants.attach("1", "reader");

    const ctx = fakeCtx({ method: "DELETE", url: "/v1/secret/data/x", user: { userId: 1, email: "a" } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("denies covered capability on uncovered path (reader can't touch database/)", async () => {
    const { guard, grants } = makeGuard("deny");
    await grants.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    await grants.attach("1", "reader");

    const ctx = fakeCtx({ method: "GET", url: "/v1/database/creds/app", user: { userId: 1, email: "a" } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // HIGH-A regression (untrusted-code audit): the guard was matching ACL by raw
  // `startsWith` on a path that could carry `..`. With `fetch` collapsing `..` before
  // sending, a caller authorized for `secret/` could reach `sys/seal-status` via
  // `/v1/secret/data/../../sys/seal-status`. The canonicalizer now rejects the path
  // before the ACL check, returning 400 invalid_engine_path (not 403 — the request is
  // malformed, not unauthorized; the distinction matters for SDK error handling).
  it("rejects /v1 path traversal with 400 BEFORE the ACL match runs", async () => {
    const { guard, grants } = makeGuard("deny");
    // Even with a covering scope: traversal still 400s — never reaches the ACL check.
    await grants.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    await grants.attach("1", "reader");

    for (const url of [
      "/v1/secret/data/../../sys/seal-status",
      "/v1/secret/./data/x",
      "/v1/secret/data/%2e%2e/sys/seal-status",
      "/v1/secret/data/%2E%2E/sys/seal-status",
      "/v1/secret//data/x",
      "/v1/",
    ]) {
      const ctx = fakeCtx({ method: "GET", url, user: { userId: 1, email: "a" } });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it("`?list=true` requires the `list` capability (not just `read`)", async () => {
    const { guard, grants } = makeGuard("deny");
    await grants.upsertPolicy({ name: "reader-only", scopes: [scope("pki/", ["read"])] });
    await grants.attach("1", "reader-only");

    const ctx = fakeCtx({
      method: "GET",
      url: "/v1/pki/certs?list=true",
      query: { list: "true" },
      user: { userId: 1, email: "a" },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
