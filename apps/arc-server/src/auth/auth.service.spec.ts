import { ForbiddenException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "./auth.service";

/**
 * MED-C regression (supply-chain audit). The old `dev-login` gate was
 * `if (process.env.NODE_ENV === "production")` — an *exclusive* check, so any value
 * other than the exact string `"production"` (undefined, `"prod"`, `"Production"`,
 * `"staging"`, a typo) enabled the endpoint. dev-login mints a real JWT_SECRET-signed
 * bearer for any email caller supplies, so a forgotten NODE_ENV in a deployed image was
 * "log in as anyone" RPC. New contract requires BOTH:
 *
 *  - `NODE_ENV !== "production"`, AND
 *  - `ARC_ENABLE_DEV_LOGIN === "true"`.
 *
 * These tests drive the helper indirectly through `AuthService.devLogin()` so the
 * production wiring stays the source of truth — no per-test injection of the gate.
 */
describe("AuthService.devLogin — MED-C gating", () => {
  // Minimal stand-ins so we can construct AuthService without a real DataSource.
  const usersRepo = {
    findOne: jest.fn(async () => ({ id: 1, email: "x@x" })),
    save: jest.fn(async (u: { id: number; email: string }) => u),
    create: jest.fn((u: { email: string }) => ({ id: 1, ...u })),
  };
  const jwt = { signAsync: jest.fn(async () => "test-token") } as unknown as JwtService;
  // dev-login never reaches the ID-token verifier; a throwing stub proves that.
  const verifier = { verify: jest.fn(async () => { throw new Error("must not be called"); }) };
  const svc = new AuthService(usersRepo as never, jwt, verifier);

  let nodeEnvBefore: string | undefined;
  let optInBefore: string | undefined;
  beforeEach(() => {
    nodeEnvBefore = process.env.NODE_ENV;
    optInBefore = process.env.ARC_ENABLE_DEV_LOGIN;
  });
  afterEach(() => {
    if (nodeEnvBefore === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnvBefore;
    if (optInBefore === undefined) delete process.env.ARC_ENABLE_DEV_LOGIN;
    else process.env.ARC_ENABLE_DEV_LOGIN = optInBefore;
  });

  // --- the new contract ---

  it("refuses when NODE_ENV=production even with the opt-in (production stays off)", async () => {
    process.env.NODE_ENV = "production";
    process.env.ARC_ENABLE_DEV_LOGIN = "true";
    await expect(svc.devLogin("u@x")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses when ARC_ENABLE_DEV_LOGIN is unset (non-prod is no longer enough)", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.ARC_ENABLE_DEV_LOGIN;
    await expect(svc.devLogin("u@x")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses when ARC_ENABLE_DEV_LOGIN is set to anything other than 'true'", async () => {
    process.env.NODE_ENV = "development";
    for (const val of ["1", "yes", "TRUE", "True", "on", ""]) {
      process.env.ARC_ENABLE_DEV_LOGIN = val;
      await expect(svc.devLogin("u@x")).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it("succeeds only when NODE_ENV is non-production AND ARC_ENABLE_DEV_LOGIN=true", async () => {
    process.env.NODE_ENV = "development";
    process.env.ARC_ENABLE_DEV_LOGIN = "true";
    const result = await svc.devLogin("u@x");
    expect(result.accessToken).toBe("test-token");
  });

  // --- the values the old exclusive-production check silently let through ---

  it.each([undefined, "prod", "Production", "PRODUCTION", "staging", "preview", "test", ""])(
    "refuses when NODE_ENV=%j without ARC_ENABLE_DEV_LOGIN (closes the old fail-open)",
    async (envVal) => {
      if (envVal === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = envVal;
      delete process.env.ARC_ENABLE_DEV_LOGIN;
      await expect(svc.devLogin("u@x")).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it("error message points the operator at the opt-in env var, not just 'disabled'", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.ARC_ENABLE_DEV_LOGIN;
    await expect(svc.devLogin("u@x")).rejects.toThrow(/ARC_ENABLE_DEV_LOGIN/);
  });
});
