import {
  AttestationService,
  SpiffeAttestationVerifier,
  buildAttestationRequired,
  buildSpiffeEnforce,
  type Jwk,
  type JwkSet,
} from "./attestation";
import type { AgentAttestation } from "@arc/types";
import { X509Certificate, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const spiffe = (doc: string): AgentAttestation => ({ kind: "spiffe", doc });

/** Easy constructor for record-mode verifier (the v1 surface). */
const recordVerifier = (allowed: Iterable<string> = []) =>
  new SpiffeAttestationVerifier({
    allowedTrustDomains: new Set(allowed),
    enforce: false,
    trustBundles: new Map(),
  });

describe("SpiffeAttestationVerifier (record mode)", () => {
  it("accepts a well-formed SPIFFE id and resolves the trust domain", () => {
    const r = recordVerifier().verify(spiffe("spiffe://example.org/ns/prod/sa/ci-bot"));
    expect(r).toMatchObject({
      ok: true,
      subject: "spiffe://example.org/ns/prod/sa/ci-bot",
      trustAnchor: "example.org",
    });
  });

  it("rejects malformed ids", () => {
    const v = recordVerifier();
    expect(v.verify(spiffe("not-a-spiffe-id")).reason).toBe("malformed_spiffe_id");
    expect(v.verify(spiffe("https://example.org/x")).reason).toBe("malformed_spiffe_id");
    expect(v.verify(spiffe("spiffe://")).reason).toBe("malformed_spiffe_id");
  });

  it("enforces a trust-domain allowlist when configured", () => {
    const v = recordVerifier(["example.org"]);
    expect(v.verify(spiffe("spiffe://example.org/x")).ok).toBe(true);
    expect(v.verify(spiffe("spiffe://evil.test/x")).reason).toBe("untrusted_domain");
  });

  it("rejects a non-spiffe kind", () => {
    expect(recordVerifier().verify({ kind: "tpm", doc: "x" } as AgentAttestation).reason).toBe(
      "unsupported_kind",
    );
  });
});

// --- Enforce-mode fixture: a self-signed CA + a SPIFFE leaf, both via openssl --------

interface SvidFixture {
  trustDomain: string;
  spiffeId: string;
  caPem: string;
  leafChainPem: string;
  expiredLeafChainPem: string;
  /** A different, unrelated CA's cert — for "chain doesn't anchor to bundle" tests. */
  unrelatedCaPem: string;
}

/**
 * Build a SPIFFE-shaped X.509 fixture using `openssl` (skipped if not on PATH). One CA,
 * one leaf with a SPIFFE-URI SAN that the CA signs. A short-lived leaf is generated too so
 * we can drive the expiry path via a future-faked clock.
 */
function buildSvidFixture(): SvidFixture | null {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
  } catch { return null; }
  const dir = mkdtempSync(path.join(os.tmpdir(), "arc-svid-"));
  const trustDomain = "example.org";
  const spiffeId = `spiffe://${trustDomain}/ns/test/sa/bot`;
  const ca = path.join(dir, "ca.crt"), caKey = path.join(dir, "ca.key");
  const leaf = path.join(dir, "leaf.crt"), leafKey = path.join(dir, "leaf.key");
  const exp = path.join(dir, "expired.crt");
  const unrelatedCa = path.join(dir, "unrelated-ca.crt"), unrelatedCaKey = path.join(dir, "unrelated-ca.key");
  const csr = path.join(dir, "leaf.csr");
  const cnf = path.join(dir, "leaf.cnf");

  execFileSync("openssl", ["genrsa", "-out", caKey, "2048"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-x509", "-new", "-key", caKey, "-days", "365", "-subj", "/CN=test-spire-ca", "-out", ca], { stdio: "ignore" });
  execFileSync("openssl", ["genrsa", "-out", unrelatedCaKey, "2048"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-x509", "-new", "-key", unrelatedCaKey, "-days", "365", "-subj", "/CN=unrelated-ca", "-out", unrelatedCa], { stdio: "ignore" });

  execFileSync("openssl", ["genrsa", "-out", leafKey, "2048"], { stdio: "ignore" });
  writeFileSync(cnf, `[req]\ndistinguished_name=dn\nreq_extensions=v3\n[dn]\n[v3]\nsubjectAltName=URI:${spiffeId}\n`);
  execFileSync("openssl", ["req", "-new", "-key", leafKey, "-subj", "/CN=test-leaf", "-out", csr, "-config", cnf], { stdio: "ignore" });
  // Real leaf — 30-day validity.
  execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "30", "-extfile", cnf, "-extensions", "v3", "-out", leaf], { stdio: "ignore" });
  // "Will be expired soon enough to test" leaf — 1-day validity; we'll fake the clock.
  execFileSync("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-extfile", cnf, "-extensions", "v3", "-out", exp], { stdio: "ignore" });

  return {
    trustDomain,
    spiffeId,
    caPem: readFileSync(ca, "utf8"),
    leafChainPem: readFileSync(leaf, "utf8"),
    expiredLeafChainPem: readFileSync(exp, "utf8"),
    unrelatedCaPem: readFileSync(unrelatedCa, "utf8"),
  };
}

describe("SpiffeAttestationVerifier (enforce mode)", () => {
  const fx = buildSvidFixture();
  const maybe = fx ? it : it.skip;

  maybe("accepts a valid X.509-SVID whose chain anchors to the bundle", () => {
    const bundle = new Map([[fx!.trustDomain, [new X509Certificate(fx!.caPem)]]]);
    const v = new SpiffeAttestationVerifier({
      allowedTrustDomains: new Set([fx!.trustDomain]),
      enforce: true,
      trustBundles: bundle,
    });
    const r = v.verify({ kind: "spiffe", doc: fx!.leafChainPem });
    expect(r).toMatchObject({ ok: true, subject: fx!.spiffeId, trustAnchor: fx!.trustDomain });
  });

  maybe("rejects a chain that does not anchor to the configured bundle", () => {
    // The bundle contains an *unrelated* CA — the leaf can't anchor to it.
    const bundle = new Map([[fx!.trustDomain, [new X509Certificate(fx!.unrelatedCaPem)]]]);
    const v = new SpiffeAttestationVerifier({
      allowedTrustDomains: new Set([fx!.trustDomain]),
      enforce: true,
      trustBundles: bundle,
    });
    const r = v.verify({ kind: "spiffe", doc: fx!.leafChainPem });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_issuer_in_chain_or_bundle");
  });

  maybe("rejects an expired leaf via a future-now clock", () => {
    const bundle = new Map([[fx!.trustDomain, [new X509Certificate(fx!.caPem)]]]);
    const tenDaysAhead = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const v = new SpiffeAttestationVerifier({
      allowedTrustDomains: new Set([fx!.trustDomain]),
      enforce: true,
      trustBundles: bundle,
      now: () => tenDaysAhead,
    });
    const r = v.verify({ kind: "spiffe", doc: fx!.expiredLeafChainPem });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("cert_expired");
  });

  maybe("rejects an SVID whose trust domain has no bundle configured", () => {
    const otherBundle = new Map([["different.example", [new X509Certificate(fx!.caPem)]]]);
    const v = new SpiffeAttestationVerifier({
      allowedTrustDomains: new Set([fx!.trustDomain]),
      enforce: true,
      trustBundles: otherBundle,
    });
    const r = v.verify({ kind: "spiffe", doc: fx!.leafChainPem });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_trust_bundle_for_domain");
  });

  maybe("refuses an SVID whose trust domain is outside the allowlist", () => {
    const bundle = new Map([[fx!.trustDomain, [new X509Certificate(fx!.caPem)]]]);
    const v = new SpiffeAttestationVerifier({
      allowedTrustDomains: new Set(["other.test"]),
      enforce: true,
      trustBundles: bundle,
    });
    const r = v.verify({ kind: "spiffe", doc: fx!.leafChainPem });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("untrusted_domain");
  });

  it("refuses a bare SPIFFE-ID string in enforce mode (no crypto material to validate)", () => {
    const v = new SpiffeAttestationVerifier({
      allowedTrustDomains: new Set(),
      enforce: true,
      trustBundles: new Map(),
    });
    const r = v.verify({ kind: "spiffe", doc: "spiffe://example.org/x" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("enforce_requires_svid_doc");
  });
});

// --- JWT-SVID fixture (Node-native — no openssl) -----------------------------------

interface JwtFixture {
  trustDomain: string;
  spiffeId: string;
  jwks: JwkSet;
  /** Sign a JWT with the fixture's Ed25519 key. */
  signEdDsa: (payload: Record<string, unknown>, header?: Record<string, unknown>) => string;
  /** Sign with a *different* key — for "invalid signature" tests. */
  signWithStrangerKey: (payload: Record<string, unknown>, header?: Record<string, unknown>) => string;
}

function b64u(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function buildJwtFixture(): JwtFixture {
  const trustDomain = "example.org";
  const spiffeId = `spiffe://${trustDomain}/ns/test/sa/bot`;

  // Ed25519 keypair for the trust domain. Export the pub as a JWK for the bundle.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const jwk: Jwk = { ...publicJwk, kty: publicJwk["kty"] as string, kid: "test-kid-1" };
  const jwks: JwkSet = { keys: [jwk] };

  // A different key (same alg) so we can sign with the wrong identity for signature tests.
  const stranger = generateKeyPairSync("ed25519");

  const signWith = (key: KeyObject) =>
    (payload: Record<string, unknown>, header: Record<string, unknown> = {}): string => {
      const fullHeader = { alg: "EdDSA", typ: "JWT", kid: "test-kid-1", ...header };
      const h = b64u(Buffer.from(JSON.stringify(fullHeader)));
      const p = b64u(Buffer.from(JSON.stringify(payload)));
      const signingInput = `${h}.${p}`;
      const signature = sign(null, Buffer.from(signingInput, "utf8"), key);
      return `${signingInput}.${b64u(signature)}`;
    };

  return {
    trustDomain,
    spiffeId,
    jwks,
    signEdDsa: signWith(privateKey),
    signWithStrangerKey: signWith(stranger.privateKey),
  };
}

const FUTURE = (sec: number) => Math.floor(Date.now() / 1000) + sec;
const PAST = (sec: number) => Math.floor(Date.now() / 1000) - sec;

describe("SpiffeAttestationVerifier (JWT-SVID enforce mode)", () => {
  const fx = buildJwtFixture();

  const enforceVerifier = (over: Partial<{
    audience: string;
    domains: string[];
    jwks: ReadonlyMap<string, JwkSet>;
  }> = {}) =>
    new SpiffeAttestationVerifier({
      allowedTrustDomains: new Set(over.domains ?? [fx.trustDomain]),
      enforce: true,
      trustBundles: new Map(),
      jwksBundles: over.jwks ?? new Map([[fx.trustDomain, fx.jwks]]),
      ...(over.audience !== undefined ? { requiredAudience: over.audience } : {}),
    });

  it("accepts a valid Ed25519 JWT-SVID whose kid resolves in the JWKS", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    const r = enforceVerifier({ audience: "arc-server" }).verify({ kind: "spiffe", doc: jwt });
    expect(r).toMatchObject({ ok: true, subject: fx.spiffeId, trustAnchor: fx.trustDomain });
  });

  it("rejects a JWT whose signature was made with a different key (jwt_signature_invalid)", () => {
    const jwt = fx.signWithStrangerKey({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    expect(enforceVerifier({ audience: "arc-server" }).verify({ kind: "spiffe", doc: jwt }).reason).toBe(
      "jwt_signature_invalid",
    );
  });

  it("rejects an unknown kid (no_jwk_matching_kid)", () => {
    const jwt = fx.signEdDsa(
      { sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) },
      { kid: "not-the-real-kid" },
    );
    expect(enforceVerifier({ audience: "arc-server" }).verify({ kind: "spiffe", doc: jwt }).reason).toBe(
      "no_jwk_matching_kid",
    );
  });

  it("rejects an alg outside the SPIRE-supported set (unsupported_jwt_alg)", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) }, { alg: "HS256" });
    expect(enforceVerifier({ audience: "arc-server" }).verify({ kind: "spiffe", doc: jwt }).reason).toBe(
      "unsupported_jwt_alg",
    );
  });

  it("rejects an expired JWT (jwt_expired)", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: PAST(60) });
    expect(enforceVerifier({ audience: "arc-server" }).verify({ kind: "spiffe", doc: jwt }).reason).toBe(
      "jwt_expired",
    );
  });

  it("rejects a JWT whose nbf is in the future (jwt_not_yet_valid)", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(3600), nbf: FUTURE(600) });
    expect(enforceVerifier({ audience: "arc-server" }).verify({ kind: "spiffe", doc: jwt }).reason).toBe(
      "jwt_not_yet_valid",
    );
  });

  it("rejects a JWT with no aud claim (SPIFFE spec requires audience)", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, exp: FUTURE(60) });
    expect(enforceVerifier({ audience: "arc-server" }).verify({ kind: "spiffe", doc: jwt }).reason).toBe(
      "jwt_missing_audience",
    );
  });

  it("rejects a JWT whose aud doesn't include the configured required audience", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: ["other-service"], exp: FUTURE(60) });
    expect(enforceVerifier({ audience: "arc-server" }).verify({ kind: "spiffe", doc: jwt }).reason).toBe(
      "jwt_audience_mismatch",
    );
  });

  it("accepts when requiredAudience is unset and aud has any non-empty value", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "anyone", exp: FUTURE(60) });
    const r = enforceVerifier().verify({ kind: "spiffe", doc: jwt });
    expect(r.ok).toBe(true);
  });

  it("rejects when sub isn't a valid SPIFFE id (jwt_subject_not_spiffe)", () => {
    const jwt = fx.signEdDsa({ sub: "user-1234", aud: "arc-server", exp: FUTURE(60) });
    expect(enforceVerifier({ audience: "arc-server" }).verify({ kind: "spiffe", doc: jwt }).reason).toBe(
      "jwt_subject_not_spiffe",
    );
  });

  it("rejects when no JWKS is configured for the SPIFFE trust domain (no_jwks_for_domain)", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    const v = enforceVerifier({
      audience: "arc-server",
      jwks: new Map([["different.example", fx.jwks]]),
    });
    expect(v.verify({ kind: "spiffe", doc: jwt }).reason).toBe("no_jwks_for_domain");
  });

  it("rejects a JWT whose SPIFFE trust domain is outside the allowlist (untrusted_domain)", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    const v = enforceVerifier({ audience: "arc-server", domains: ["other.test"] });
    expect(v.verify({ kind: "spiffe", doc: jwt }).reason).toBe("untrusted_domain");
  });

  it("rejects a malformed JWT (not three dotted segments) — malformed_jwt", () => {
    const v = enforceVerifier({ audience: "arc-server" });
    // The doc looks like an SVID document (not a bare SPIFFE id) but isn't valid PEM or JWT.
    // Falls through to enforce_requires_svid_doc because the JWT regex rejects two-segment input.
    expect(v.verify({ kind: "spiffe", doc: "not.actually-a-jwt" }).reason).toBe(
      "enforce_requires_svid_doc",
    );
  });
});

describe("SpiffeAttestationVerifier (JWT-SVID record mode)", () => {
  const fx = buildJwtFixture();
  it("extracts the SPIFFE id from a JWT-SVID without signature verification", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    const v = new SpiffeAttestationVerifier({
      allowedTrustDomains: new Set(),
      enforce: false,
      trustBundles: new Map(),
    });
    const r = v.verify({ kind: "spiffe", doc: jwt });
    expect(r).toMatchObject({ ok: true, subject: fx.spiffeId, trustAnchor: fx.trustDomain });
  });

  it("still applies the trust-domain allowlist on the JWT's sub claim in record mode", () => {
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    const v = new SpiffeAttestationVerifier({
      allowedTrustDomains: new Set(["only-this.example"]),
      enforce: false,
      trustBundles: new Map(),
    });
    expect(v.verify({ kind: "spiffe", doc: jwt }).reason).toBe("untrusted_domain");
  });
});

describe("AttestationService", () => {
  const saved = {
    req: process.env.ARC_AGENT_ATTESTATION,
    dom: process.env.ARC_SPIFFE_TRUST_DOMAINS,
    enf: process.env.ARC_SPIFFE_ENFORCE,
    bun: process.env.ARC_SPIFFE_TRUST_BUNDLES,
    jwks: process.env.ARC_SPIFFE_JWKS_BUNDLES,
    aud: process.env.ARC_SPIFFE_REQUIRED_AUDIENCE,
    env: process.env.NODE_ENV,
  };
  afterEach(() => {
    if (saved.req === undefined) delete process.env.ARC_AGENT_ATTESTATION; else process.env.ARC_AGENT_ATTESTATION = saved.req;
    if (saved.dom === undefined) delete process.env.ARC_SPIFFE_TRUST_DOMAINS; else process.env.ARC_SPIFFE_TRUST_DOMAINS = saved.dom;
    if (saved.enf === undefined) delete process.env.ARC_SPIFFE_ENFORCE; else process.env.ARC_SPIFFE_ENFORCE = saved.enf;
    if (saved.bun === undefined) delete process.env.ARC_SPIFFE_TRUST_BUNDLES; else process.env.ARC_SPIFFE_TRUST_BUNDLES = saved.bun;
    if (saved.jwks === undefined) delete process.env.ARC_SPIFFE_JWKS_BUNDLES; else process.env.ARC_SPIFFE_JWKS_BUNDLES = saved.jwks;
    if (saved.aud === undefined) delete process.env.ARC_SPIFFE_REQUIRED_AUDIENCE; else process.env.ARC_SPIFFE_REQUIRED_AUDIENCE = saved.aud;
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
  });

  it("defaults to record mode and verifies a SPIFFE id", () => {
    delete process.env.ARC_AGENT_ATTESTATION;
    delete process.env.ARC_SPIFFE_TRUST_DOMAINS;
    delete process.env.ARC_SPIFFE_ENFORCE;
    process.env.NODE_ENV = "development"; // pin non-prod so this can't flip on the runner's env
    const s = new AttestationService();
    expect(s.required).toBe(false);
    expect(s.enforce).toBe(false);
    expect(s.verify(spiffe("spiffe://example.org/x")).ok).toBe(true);
  });

  // SEC-H7 (#149): attestation is secure-by-default in production.
  describe("env-aware production default (SEC-H7)", () => {
    it("buildSpiffeEnforce / buildAttestationRequired default ON under production when unset", () => {
      delete process.env.ARC_SPIFFE_ENFORCE;
      delete process.env.ARC_AGENT_ATTESTATION;
      process.env.NODE_ENV = "production";
      expect(buildSpiffeEnforce()).toBe(true);
      expect(buildAttestationRequired()).toBe(true);
    });

    it("both default OFF in dev/test when unset", () => {
      delete process.env.ARC_SPIFFE_ENFORCE;
      delete process.env.ARC_AGENT_ATTESTATION;
      process.env.NODE_ENV = "development";
      expect(buildSpiffeEnforce()).toBe(false);
      expect(buildAttestationRequired()).toBe(false);
    });

    it("an explicit value always wins, case-insensitively", () => {
      process.env.NODE_ENV = "production";
      process.env.ARC_SPIFFE_ENFORCE = "FALSE";
      process.env.ARC_AGENT_ATTESTATION = "Optional";
      expect(buildSpiffeEnforce()).toBe(false);
      expect(buildAttestationRequired()).toBe(false);
      process.env.NODE_ENV = "development";
      process.env.ARC_SPIFFE_ENFORCE = "true";
      process.env.ARC_AGENT_ATTESTATION = "required";
      expect(buildSpiffeEnforce()).toBe(true);
      expect(buildAttestationRequired()).toBe(true);
    });

    it("an invalid value falls back to the env-appropriate default", () => {
      process.env.NODE_ENV = "production";
      process.env.ARC_SPIFFE_ENFORCE = "yes"; // not true/false → prod default (enforce)
      process.env.ARC_AGENT_ATTESTATION = "maybe"; // not required/optional → prod default (required)
      expect(buildSpiffeEnforce()).toBe(true);
      expect(buildAttestationRequired()).toBe(true);
    });

    it("a stock production deploy (enforce unset, no bundles) fails closed at boot", () => {
      delete process.env.ARC_SPIFFE_ENFORCE;
      delete process.env.ARC_SPIFFE_TRUST_BUNDLES;
      delete process.env.ARC_SPIFFE_JWKS_BUNDLES;
      process.env.NODE_ENV = "production";
      // Old code defaulted enforce=false → silently recorded an unverified identity. Now the
      // prod default turns enforce on, and installSpiffeVerifier refuses to boot without a bundle.
      expect(() => new AttestationService()).toThrow(/ARC_SPIFFE_ENFORCE/);
    });

    it("explicit ARC_SPIFFE_ENFORCE=false + ARC_AGENT_ATTESTATION=optional opts out of the prod default", () => {
      process.env.NODE_ENV = "production";
      process.env.ARC_SPIFFE_ENFORCE = "false";
      process.env.ARC_AGENT_ATTESTATION = "optional";
      const s = new AttestationService();
      expect(s.enforce).toBe(false);
      expect(s.required).toBe(false);
    });
  });

  it("treats kind:none as no attestation and unknown kinds as unsupported", () => {
    const s = new AttestationService();
    expect(s.verify({ kind: "none", doc: "" }).reason).toBe("no_attestation");
    expect(s.verify({ kind: "sigstore", doc: "bundle" }).reason).toBe("unsupported_kind");
  });

  it("reads required mode + trust-domain allowlist from env", () => {
    process.env.ARC_AGENT_ATTESTATION = "required";
    process.env.ARC_SPIFFE_TRUST_DOMAINS = "example.org, corp.internal";
    const s = new AttestationService();
    expect(s.required).toBe(true);
    expect(s.verify(spiffe("spiffe://corp.internal/sa/x")).ok).toBe(true);
    expect(s.verify(spiffe("spiffe://other.test/x")).reason).toBe("untrusted_domain");
  });

  it("enforce=true in dev warns + still refuses bare SPIFFE ids when no bundles are configured", () => {
    process.env.ARC_SPIFFE_ENFORCE = "true";
    delete process.env.ARC_SPIFFE_TRUST_BUNDLES;
    process.env.NODE_ENV = "development";
    const s = new AttestationService();
    expect(s.enforce).toBe(true);
    expect(s.verify(spiffe("spiffe://example.org/x")).reason).toBe("enforce_requires_svid_doc");
  });

  it("enforce=true with no X.509 + no JWKS bundles refuses to boot in production (fail-closed)", () => {
    process.env.ARC_SPIFFE_ENFORCE = "true";
    delete process.env.ARC_SPIFFE_TRUST_BUNDLES;
    delete process.env.ARC_SPIFFE_JWKS_BUNDLES;
    process.env.NODE_ENV = "production";
    expect(() => new AttestationService()).toThrow(/ARC_SPIFFE_ENFORCE=true but both/);
  });

  it("enforce=true with only JWKS bundles configured (no X.509) boots fine — JWT-SVID surface is enough", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arc-jwks-env-"));
    const fx = buildJwtFixture();
    const jwksFile = path.join(dir, "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(fx.jwks));

    process.env.ARC_SPIFFE_ENFORCE = "true";
    process.env.ARC_SPIFFE_JWKS_BUNDLES = `${fx.trustDomain}=${jwksFile}`;
    process.env.ARC_SPIFFE_REQUIRED_AUDIENCE = "arc-server";
    process.env.NODE_ENV = "production";
    const s = new AttestationService();
    expect(s.enforce).toBe(true);

    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    const r = s.verify({ kind: "spiffe", doc: jwt });
    expect(r).toMatchObject({ ok: true, subject: fx.spiffeId, trustAnchor: fx.trustDomain });
  });

  it("reads ARC_SPIFFE_REQUIRED_AUDIENCE and enforces it on JWT-SVIDs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arc-jwks-aud-"));
    const fx = buildJwtFixture();
    const jwksFile = path.join(dir, "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(fx.jwks));

    process.env.ARC_SPIFFE_ENFORCE = "true";
    process.env.ARC_SPIFFE_JWKS_BUNDLES = `${fx.trustDomain}=${jwksFile}`;
    process.env.ARC_SPIFFE_REQUIRED_AUDIENCE = "arc-server";
    const s = new AttestationService();

    const wrong = fx.signEdDsa({ sub: fx.spiffeId, aud: "different-service", exp: FUTURE(60) });
    expect(s.verify({ kind: "spiffe", doc: wrong }).reason).toBe("jwt_audience_mismatch");
  });

  // ----- SIGHUP / reloadBundles() hot-reload --------------------------------------

  it("reloadBundles() picks up a JWKS file that was rotated on disk (key rotation flow)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arc-jwks-rotate-"));
    const fxOld = buildJwtFixture();
    const jwksFile = path.join(dir, "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(fxOld.jwks));

    process.env.ARC_SPIFFE_ENFORCE = "true";
    process.env.ARC_SPIFFE_JWKS_BUNDLES = `${fxOld.trustDomain}=${jwksFile}`;
    process.env.ARC_SPIFFE_REQUIRED_AUDIENCE = "arc-server";
    const s = new AttestationService();

    // Pre-rotation: a token signed by the OLD key verifies.
    const oldJwt = fxOld.signEdDsa({ sub: fxOld.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    expect(s.verify({ kind: "spiffe", doc: oldJwt }).ok).toBe(true);

    // Rotate: a new keypair becomes the trust bundle on disk. The OLD key is no longer
    // anchored anywhere; the NEW key is the only one that should now verify.
    const fxNew = buildJwtFixture();
    writeFileSync(jwksFile, JSON.stringify(fxNew.jwks));

    // Pre-reload: arc-server still trusts the OLD key — it hasn't seen the file change.
    expect(s.verify({ kind: "spiffe", doc: oldJwt }).ok).toBe(true);

    await s.reloadBundles();

    // Post-reload: a token signed by the NEW key verifies; old key is gone.
    const newJwt = fxNew.signEdDsa({ sub: fxNew.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    expect(s.verify({ kind: "spiffe", doc: newJwt }).ok).toBe(true);
    expect(s.verify({ kind: "spiffe", doc: oldJwt }).reason).toBe("jwt_signature_invalid");

    s.onModuleDestroy();
  });

  it("reloadBundles() picks up a JWKS file that was added since boot (new trust domain)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arc-jwks-add-"));
    const fx = buildJwtFixture();
    const jwksFile = path.join(dir, "jwks.json");
    // Write the JWKS NOW but env starts with the variable pointing at a non-existent path —
    // simulates the "I forgot to mount the secret" case followed by the operator fixing
    // the path and sending SIGHUP.
    process.env.ARC_SPIFFE_ENFORCE = "true";
    process.env.ARC_SPIFFE_JWKS_BUNDLES = `${fx.trustDomain}=${path.join(dir, "absent.json")}`;
    process.env.ARC_SPIFFE_REQUIRED_AUDIENCE = "arc-server";
    process.env.NODE_ENV = "development"; // tolerate the "no bundles" warning at boot
    const s = new AttestationService();

    // Boot state: enforce on but bundle file didn't load → no JWKS for the domain.
    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    expect(s.verify({ kind: "spiffe", doc: jwt }).reason).toBe("no_jwks_for_domain");

    // Operator fixes the file (writes the JWKS to the *real* path) and updates the env
    // var to point at it, then sends SIGHUP.
    writeFileSync(jwksFile, JSON.stringify(fx.jwks));
    process.env.ARC_SPIFFE_JWKS_BUNDLES = `${fx.trustDomain}=${jwksFile}`;
    await s.reloadBundles();

    expect(s.verify({ kind: "spiffe", doc: jwt }).ok).toBe(true);
    s.onModuleDestroy();
  });

  it("reloadBundles() refuses to disarm enforce: empty bundles on reload keeps the previous verifier", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arc-jwks-disarm-"));
    const fx = buildJwtFixture();
    const jwksFile = path.join(dir, "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(fx.jwks));

    process.env.ARC_SPIFFE_ENFORCE = "true";
    process.env.ARC_SPIFFE_JWKS_BUNDLES = `${fx.trustDomain}=${jwksFile}`;
    process.env.ARC_SPIFFE_REQUIRED_AUDIENCE = "arc-server";
    const s = new AttestationService();

    const jwt = fx.signEdDsa({ sub: fx.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    expect(s.verify({ kind: "spiffe", doc: jwt }).ok).toBe(true);

    // Operator (or a misconfig) wipes the env vars and tries to reload. The reload MUST
    // NOT silently disarm enforce — it logs the warning and keeps the previous verifier
    // alive so production traffic continues to be checked.
    process.env.ARC_SPIFFE_JWKS_BUNDLES = "";
    process.env.ARC_SPIFFE_TRUST_BUNDLES = "";
    await s.reloadBundles();

    expect(s.verify({ kind: "spiffe", doc: jwt }).ok).toBe(true);
    s.onModuleDestroy();
  });

  it("SIGHUP signal triggers reloadBundles() (real-signal sanity)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "arc-jwks-sighup-"));
    const fxOld = buildJwtFixture();
    const jwksFile = path.join(dir, "jwks.json");
    writeFileSync(jwksFile, JSON.stringify(fxOld.jwks));

    process.env.ARC_SPIFFE_ENFORCE = "true";
    process.env.ARC_SPIFFE_JWKS_BUNDLES = `${fxOld.trustDomain}=${jwksFile}`;
    process.env.ARC_SPIFFE_REQUIRED_AUDIENCE = "arc-server";
    const s = new AttestationService();

    const fxNew = buildJwtFixture();
    writeFileSync(jwksFile, JSON.stringify(fxNew.jwks));

    // `process.emit("SIGHUP")` invokes the listeners synchronously without sending an
    // OS signal — important because in a jest worker `process.kill(pid, SIGHUP)` can
    // race Node's default disposition and terminate the worker before the listener
    // chain settles. The behaviour proven is the same: the wired handler fires and
    // reloadBundles() runs.
    process.emit("SIGHUP");
    // Handler is sync-emit but invokes `reloadBundles()` which is async; let two
    // microtasks settle so its returned promise resolves.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const newJwt = fxNew.signEdDsa({ sub: fxNew.spiffeId, aud: "arc-server", exp: FUTURE(60) });
    expect(s.verify({ kind: "spiffe", doc: newJwt }).ok).toBe(true);
    s.onModuleDestroy();
  });
});
