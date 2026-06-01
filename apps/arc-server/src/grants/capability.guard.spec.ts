/**
 * Unit tests for {@link CapabilityGuard}'s method→capability mapping and decision plumbing.
 * The "real" Engine-A-with-ACL path is covered in the engines e2e suite; this spec stays
 * narrow on the guard's own logic so a regression here points at the right line.
 */
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { CapabilityGuard, pickCapability, stripV1Prefix } from "./capability.guard";
import { GrantsService } from "./grants.service";
import { scope } from "@arc/grants";

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
    const grants = new GrantsService(defaultMode);
    const guard = new CapabilityGuard(grants);
    return { grants, guard };
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
    grants.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    grants.attach("1", "reader");

    const ctx = fakeCtx({ method: "GET", url: "/v1/secret/data/x", user: { userId: 1, email: "a" } });
    expect(await guard.canActivate(ctx)).toBe(true);
  });

  it("denies covered path with uncovered capability (the scope only grants read, not delete)", async () => {
    const { guard, grants } = makeGuard("deny");
    grants.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    grants.attach("1", "reader");

    const ctx = fakeCtx({ method: "DELETE", url: "/v1/secret/data/x", user: { userId: 1, email: "a" } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("denies covered capability on uncovered path (reader can't touch database/)", async () => {
    const { guard, grants } = makeGuard("deny");
    grants.upsertPolicy({ name: "reader", scopes: [scope("secret/", ["read"])] });
    grants.attach("1", "reader");

    const ctx = fakeCtx({ method: "GET", url: "/v1/database/creds/app", user: { userId: 1, email: "a" } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("`?list=true` requires the `list` capability (not just `read`)", async () => {
    const { guard, grants } = makeGuard("deny");
    grants.upsertPolicy({ name: "reader-only", scopes: [scope("pki/", ["read"])] });
    grants.attach("1", "reader-only");

    const ctx = fakeCtx({
      method: "GET",
      url: "/v1/pki/certs?list=true",
      query: { list: "true" },
      user: { userId: 1, email: "a" },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
