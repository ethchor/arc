/**
 * Unit spec for `buildDefaultMode` — the function that decides arc-server's fail-open vs
 * fail-closed posture for Engine-A's `/v1/*` ACL when a subject has no attached policy.
 *
 * Security-critical: before this fix the default was always `"allow"`, so a production
 * deployment that forgot `ARC_DEFAULT_POLICY=deny` granted *every authenticated user* full
 * Engine-A authority (read/write any secret, mount plugins, write grant policies). The
 * contract is now: explicit env wins; otherwise fail **closed** in production, open in dev.
 */
import { buildDefaultMode } from "./grants.module";

describe("buildDefaultMode (Engine-A default ACL posture)", () => {
  const savedPolicy = process.env.ARC_DEFAULT_POLICY;
  const savedNodeEnv = process.env.NODE_ENV;

  function set(policy: string | undefined, nodeEnv: string | undefined): void {
    if (policy === undefined) delete process.env.ARC_DEFAULT_POLICY;
    else process.env.ARC_DEFAULT_POLICY = policy;
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }

  afterEach(() => {
    if (savedPolicy === undefined) delete process.env.ARC_DEFAULT_POLICY;
    else process.env.ARC_DEFAULT_POLICY = savedPolicy;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  // --- the security regression: unset + production must fail CLOSED ---

  it("defaults to DENY when ARC_DEFAULT_POLICY is unset and NODE_ENV=production", () => {
    set(undefined, "production");
    expect(buildDefaultMode()).toBe("deny");
  });

  it("defaults to ALLOW when unset and NODE_ENV is not production (dev ergonomics)", () => {
    set(undefined, "development");
    expect(buildDefaultMode()).toBe("allow");
  });

  it("defaults to ALLOW when unset and NODE_ENV is undefined (local/test)", () => {
    set(undefined, undefined);
    expect(buildDefaultMode()).toBe("allow");
  });

  // --- explicit env always wins, regardless of NODE_ENV ---

  it("honors an explicit deny in any environment", () => {
    set("deny", "development");
    expect(buildDefaultMode()).toBe("deny");
    set("deny", "production");
    expect(buildDefaultMode()).toBe("deny");
  });

  it("honors an explicit allow even in production (operator opt-out of fail-closed)", () => {
    set("allow", "production");
    expect(buildDefaultMode()).toBe("allow");
  });

  it("is case-insensitive on the policy value", () => {
    set("DENY", "development");
    expect(buildDefaultMode()).toBe("deny");
    set("Allow", "production");
    expect(buildDefaultMode()).toBe("allow");
  });

  // --- invalid values fall back to the environment-appropriate default ---

  it("falls back to DENY for an invalid value in production (fail-closed)", () => {
    set("garbage", "production");
    expect(buildDefaultMode()).toBe("deny");
  });

  it("falls back to ALLOW for an invalid value outside production", () => {
    set("garbage", "development");
    expect(buildDefaultMode()).toBe("allow");
  });
});
