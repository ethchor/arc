/**
 * Unit tests for production account login (issue #144 / BL-C4).
 *
 * These are mostly *refusal* tests. Login is the sync gate (doc 06 §6.1) and the account
 * identity is what invites and item shares are addressed to, so every way an attacker could
 * be handed the wrong account gets an explicit case here.
 */
import { ConflictException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthService, type IdTokenVerifier } from "./auth.service";

const ISSUER = "https://accounts.google.com";
const AUDIENCE = "arc-client-id.apps.googleusercontent.com";

interface Row {
  id: number;
  email: string;
  oidcIssuer: string | null;
  oidcSubject: string | null;
  emailVerified: boolean;
}

/** In-memory users table with just enough of the TypeORM repo surface. */
function fakeRepo(seed: Row[] = []) {
  const rows = [...seed];
  let nextId = rows.length + 1;
  return {
    rows,
    findOne: jest.fn(async ({ where }: { where: Partial<Row> }) => {
      return (
        rows.find((r) =>
          Object.entries(where).every(([k, v]) => r[k as keyof Row] === v),
        ) ?? null
      );
    }),
    create: jest.fn((u: Partial<Row>) => ({
      id: nextId++,
      oidcIssuer: null,
      oidcSubject: null,
      emailVerified: false,
      ...u,
    })),
    save: jest.fn(async (u: Row) => {
      const i = rows.findIndex((r) => r.id === u.id);
      if (i >= 0) rows[i] = u;
      else rows.push(u);
      return u;
    }),
  };
}

/** Build a syntactically valid unsigned JWS so `unverifiedIssuer` can read `iss`. */
function token(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

const goodClaims = {
  iss: ISSUER,
  sub: "google-uid-1",
  aud: AUDIENCE,
  email: "user@example.com",
  email_verified: true,
};

/**
 * Assert the machine-readable `error` code. Nest puts an object response on
 * `getResponse()`, leaving `.message` as the generic "Unauthorized Exception", so matching
 * on the message would silently pass for the wrong refusal.
 */
async function expectErrorCode(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ response: { error: code } });
}

function build(opts: { repo?: ReturnType<typeof fakeRepo>; claims?: Record<string, unknown>; throws?: Error } = {}) {
  const repo = opts.repo ?? fakeRepo();
  const verifier: IdTokenVerifier = {
    verify: jest.fn(async () => {
      if (opts.throws) throw opts.throws;
      return opts.claims ?? goodClaims;
    }),
  };
  const jwt = { signAsync: jest.fn(async () => "arc-jwt") } as unknown as JwtService;
  const svc = new AuthService(repo as never, jwt, verifier);
  return { svc, repo, verifier };
}

describe("AuthService.oidcLogin", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["ARC_OIDC_ISSUERS", "ARC_OIDC_AUDIENCES", "ARC_OIDC_ADOPT_UNBOUND"]) {
      saved[k] = process.env[k];
    }
    process.env.ARC_OIDC_ISSUERS = ISSUER;
    process.env.ARC_OIDC_AUDIENCES = AUDIENCE;
    delete process.env.ARC_OIDC_ADOPT_UNBOUND;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("creates a verified account on first login and mints an arc JWT", async () => {
    const { svc, repo } = build();
    const res = await svc.oidcLogin(token(goodClaims));
    expect(res).toMatchObject({ accessToken: "arc-jwt", email: "user@example.com" });
    expect(repo.rows[0]).toMatchObject({
      email: "user@example.com",
      oidcIssuer: ISSUER,
      oidcSubject: "google-uid-1",
      emailVerified: true,
    });
  });

  it("returns the same account on repeat login (binds on issuer+subject, not email)", async () => {
    const repo = fakeRepo();
    const first = await build({ repo }).svc.oidcLogin(token(goodClaims));
    const second = await build({ repo }).svc.oidcLogin(token(goodClaims));
    expect(second.userId).toBe(first.userId);
    expect(repo.rows).toHaveLength(1);
  });

  it("follows an email change at the IdP without moving the account", async () => {
    const repo = fakeRepo([
      { id: 1, email: "old@example.com", oidcIssuer: ISSUER, oidcSubject: "google-uid-1", emailVerified: true },
    ]);
    const { svc } = build({ repo, claims: { ...goodClaims, email: "new@example.com" } });
    const res = await svc.oidcLogin(token(goodClaims));
    expect(res.userId).toBe(1);
    expect(repo.rows[0]?.email).toBe("new@example.com");
  });

  it("passes the configured audience to the verifier", async () => {
    const { svc, verifier } = build();
    await svc.oidcLogin(token(goodClaims));
    expect(verifier.verify).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ issuer: ISSUER, audiences: [AUDIENCE] }),
    );
  });

  // --- refusals ---

  it("refuses an issuer outside the allowlist", async () => {
    const { svc, verifier } = build();
    await expect(svc.oidcLogin(token({ ...goodClaims, iss: "https://evil.example" }))).rejects.toThrow(
      UnauthorizedException,
    );
    // Rejected before any signature work — an unknown issuer is never fetched from.
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("refuses a token the verifier rejects (bad signature / audience / expiry)", async () => {
    const { svc } = build({ throws: new Error("audience not in boundAudiences") });
    await expect(svc.oidcLogin(token(goodClaims))).rejects.toThrow(UnauthorizedException);
  });

  it("refuses an unverified email", async () => {
    const { svc } = build({ claims: { ...goodClaims, email_verified: false } });
    await expectErrorCode(svc.oidcLogin(token(goodClaims)), "email_not_verified");
  });

  it("refuses a token with no sub or no email", async () => {
    await expectErrorCode(
      build({ claims: { ...goodClaims, sub: "" } }).svc.oidcLogin(token(goodClaims)),
      "id_token_missing_sub",
    );
    await expectErrorCode(
      build({ claims: { iss: ISSUER, sub: "s", email_verified: true } }).svc.oidcLogin(token(goodClaims)),
      "id_token_missing_email",
    );
  });

  it("refuses to merge onto an account already bound to a different identity", async () => {
    const repo = fakeRepo([
      { id: 1, email: "user@example.com", oidcIssuer: "https://other.idp", oidcSubject: "other-1", emailVerified: true },
    ]);
    const { svc } = build({ repo });
    await expect(svc.oidcLogin(token(goodClaims))).rejects.toThrow(ConflictException);
    expect(repo.rows[0]?.oidcIssuer).toBe("https://other.idp");
  });

  it("refuses to adopt an unbound account by default (dev-login rows stay unclaimable)", async () => {
    const repo = fakeRepo([
      { id: 1, email: "user@example.com", oidcIssuer: null, oidcSubject: null, emailVerified: false },
    ]);
    const { svc } = build({ repo });
    await expectErrorCode(svc.oidcLogin(token(goodClaims)), "email_exists_unbound");
  });

  it("adopts an unbound account only when the operator opts in", async () => {
    process.env.ARC_OIDC_ADOPT_UNBOUND = "true";
    const repo = fakeRepo([
      { id: 1, email: "user@example.com", oidcIssuer: null, oidcSubject: null, emailVerified: false },
    ]);
    const { svc } = build({ repo });
    const res = await svc.oidcLogin(token(goodClaims));
    expect(res.userId).toBe(1);
    expect(repo.rows[0]).toMatchObject({ oidcIssuer: ISSUER, emailVerified: true });
  });

  it("is unavailable rather than open when no issuer is configured", async () => {
    delete process.env.ARC_OIDC_ISSUERS;
    delete process.env.ARC_OIDC_AUDIENCES;
    const { svc } = build();
    await expect(svc.oidcLogin(token(goodClaims))).rejects.toThrow(ServiceUnavailableException);
  });

  it("refuses to start with issuers but no audiences (confused-deputy guard)", () => {
    process.env.ARC_OIDC_AUDIENCES = "";
    expect(() => build()).toThrow(/ARC_OIDC_AUDIENCES/);
  });
});
