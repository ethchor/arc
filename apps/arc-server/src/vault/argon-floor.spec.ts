import { BadRequestException } from "@nestjs/common";
import { assertArgonParamsAboveFloor, resolveArgonFloor } from "./argon-floor";

/**
 * LOW-B regression. The server used to take any `argonParams` the client uploaded on
 * enroll/recover — including the `test` profile (m=256 KiB, t=1) that ships in
 * `@arc/crypto` for unit tests only. A misconfigured release that pushed the test
 * profile into production would degrade the authHash + WK-wrap KDF cost forever, and
 * the server had no signal that anything was wrong.
 *
 * The new floor refuses anything weaker than the `mobile` profile in production and
 * stays permissive in non-production so existing test suites keep working. Override is
 * env-driven; the truth table below pins each path.
 */
describe("argon-floor — LOW-B", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedMinM = process.env.ARC_ARGON_MIN_M;
  const savedMinT = process.env.ARC_ARGON_MIN_T;
  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedMinM === undefined) delete process.env.ARC_ARGON_MIN_M;
    else process.env.ARC_ARGON_MIN_M = savedMinM;
    if (savedMinT === undefined) delete process.env.ARC_ARGON_MIN_T;
    else process.env.ARC_ARGON_MIN_T = savedMinT;
  });

  describe("resolveArgonFloor", () => {
    it("defaults to the mobile-profile floor in production", () => {
      process.env.NODE_ENV = "production";
      delete process.env.ARC_ARGON_MIN_M;
      delete process.env.ARC_ARGON_MIN_T;
      expect(resolveArgonFloor()).toEqual({ m: 65_536, t: 2, p: 1 });
    });

    it("drops the floor in non-production so the test profile still passes", () => {
      process.env.NODE_ENV = "development";
      delete process.env.ARC_ARGON_MIN_M;
      delete process.env.ARC_ARGON_MIN_T;
      const f = resolveArgonFloor();
      expect(f.m).toBe(128); // below `test` profile's 256 — so test profile passes
      expect(f.t).toBe(1);
    });

    it("env overrides win over the default (allow strict floor in staging)", () => {
      process.env.NODE_ENV = "development";
      process.env.ARC_ARGON_MIN_M = "262144";
      process.env.ARC_ARGON_MIN_T = "3";
      expect(resolveArgonFloor()).toMatchObject({ m: 262_144, t: 3 });
    });

    it("garbage env override falls back to the env-appropriate default", () => {
      process.env.NODE_ENV = "production";
      process.env.ARC_ARGON_MIN_M = "not-a-number";
      expect(resolveArgonFloor().m).toBe(65_536);
    });

  });

  describe("assertArgonParamsAboveFloor", () => {
    const floor = { m: 65_536, t: 2, p: 1 };

    it("accepts the mobile profile against the production floor", () => {
      // mobile = { profile: "mobile", m: 65536, t: 4, p: 1, version: 1 }
      expect(() =>
        assertArgonParamsAboveFloor({ profile: "mobile", m: 65_536, t: 4, p: 1, version: 1 }, floor),
      ).not.toThrow();
    });

    it("accepts the desktop profile against the production floor", () => {
      expect(() =>
        assertArgonParamsAboveFloor({ profile: "desktop", m: 262_144, t: 3, p: 1, version: 1 }, floor),
      ).not.toThrow();
    });

    it("rejects the test profile against the production floor (the audit attack)", () => {
      try {
        assertArgonParamsAboveFloor({ profile: "test", m: 256, t: 1, p: 1, version: 1 }, floor);
        fail("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        const body = (e as BadRequestException).getResponse() as { error: string };
        expect(body.error).toBe("argon_below_floor");
      }
    });

    it("rejects an m-below-floor even when t is fine", () => {
      expect(() =>
        assertArgonParamsAboveFloor({ m: 32_768, t: 10, p: 1 }, floor),
      ).toThrow(BadRequestException);
    });

    it("rejects a t-below-floor even when m is fine", () => {
      expect(() =>
        assertArgonParamsAboveFloor({ m: 65_536, t: 1, p: 1 }, floor),
      ).toThrow(BadRequestException);
    });

    it("ignores extra fields the wire DTO carries (profile, version, ...)", () => {
      expect(() =>
        assertArgonParamsAboveFloor(
          { profile: "mobile", m: 65_536, t: 4, p: 1, version: 1 },
          floor,
        ),
      ).not.toThrow();
    });

    it.each([
      ["m missing", { t: 2, p: 1 }],
      ["t missing", { m: 65_536, p: 1 }],
      ["m as string", { m: "65536", t: 2, p: 1 }],
      ["t as float", { m: 65_536, t: 2.5, p: 1 }],
      ["m negative", { m: -1, t: 2, p: 1 }],
    ])("rejects malformed params: %s", (_label, params) => {
      try {
        assertArgonParamsAboveFloor(params as Record<string, unknown>, floor);
        fail("expected throw");
      } catch (e) {
        const body = (e as BadRequestException).getResponse() as { error: string };
        expect(body.error).toBe("argon_params_malformed");
      }
    });
  });
});
