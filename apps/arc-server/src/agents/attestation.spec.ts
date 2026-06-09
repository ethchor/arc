import { AttestationService, SpiffeAttestationVerifier } from "./attestation";
import type { AgentAttestation } from "@arc/types";
import { X509Certificate } from "node:crypto";
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

describe("AttestationService", () => {
  const saved = {
    req: process.env.ARC_AGENT_ATTESTATION,
    dom: process.env.ARC_SPIFFE_TRUST_DOMAINS,
    enf: process.env.ARC_SPIFFE_ENFORCE,
    bun: process.env.ARC_SPIFFE_TRUST_BUNDLES,
    env: process.env.NODE_ENV,
  };
  afterEach(() => {
    if (saved.req === undefined) delete process.env.ARC_AGENT_ATTESTATION; else process.env.ARC_AGENT_ATTESTATION = saved.req;
    if (saved.dom === undefined) delete process.env.ARC_SPIFFE_TRUST_DOMAINS; else process.env.ARC_SPIFFE_TRUST_DOMAINS = saved.dom;
    if (saved.enf === undefined) delete process.env.ARC_SPIFFE_ENFORCE; else process.env.ARC_SPIFFE_ENFORCE = saved.enf;
    if (saved.bun === undefined) delete process.env.ARC_SPIFFE_TRUST_BUNDLES; else process.env.ARC_SPIFFE_TRUST_BUNDLES = saved.bun;
    if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
  });

  it("defaults to record mode and verifies a SPIFFE id", () => {
    delete process.env.ARC_AGENT_ATTESTATION;
    delete process.env.ARC_SPIFFE_TRUST_DOMAINS;
    delete process.env.ARC_SPIFFE_ENFORCE;
    const s = new AttestationService();
    expect(s.required).toBe(false);
    expect(s.enforce).toBe(false);
    expect(s.verify(spiffe("spiffe://example.org/x")).ok).toBe(true);
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

  it("enforce=true with empty bundles refuses to boot in production (fail-closed)", () => {
    process.env.ARC_SPIFFE_ENFORCE = "true";
    delete process.env.ARC_SPIFFE_TRUST_BUNDLES;
    process.env.NODE_ENV = "production";
    expect(() => new AttestationService()).toThrow(/ARC_SPIFFE_ENFORCE=true but/);
  });
});
