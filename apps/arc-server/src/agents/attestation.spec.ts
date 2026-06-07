import { AttestationService, SpiffeAttestationVerifier } from "./attestation";
import type { AgentAttestation } from "@arc/types";

const spiffe = (doc: string): AgentAttestation => ({ kind: "spiffe", doc });

describe("SpiffeAttestationVerifier", () => {
  it("accepts a well-formed SPIFFE id and resolves the trust domain", () => {
    const v = new SpiffeAttestationVerifier(new Set());
    const r = v.verify(spiffe("spiffe://example.org/ns/prod/sa/ci-bot"));
    expect(r).toMatchObject({ ok: true, subject: "spiffe://example.org/ns/prod/sa/ci-bot", trustAnchor: "example.org" });
  });

  it("rejects malformed ids", () => {
    const v = new SpiffeAttestationVerifier(new Set());
    expect(v.verify(spiffe("not-a-spiffe-id")).reason).toBe("malformed_spiffe_id");
    expect(v.verify(spiffe("https://example.org/x")).reason).toBe("malformed_spiffe_id");
    expect(v.verify(spiffe("spiffe://")).reason).toBe("malformed_spiffe_id");
  });

  it("enforces a trust-domain allowlist when configured", () => {
    const v = new SpiffeAttestationVerifier(new Set(["example.org"]));
    expect(v.verify(spiffe("spiffe://example.org/x")).ok).toBe(true);
    expect(v.verify(spiffe("spiffe://evil.test/x")).reason).toBe("untrusted_domain");
  });

  it("rejects a non-spiffe kind", () => {
    const v = new SpiffeAttestationVerifier(new Set());
    expect(v.verify({ kind: "tpm", doc: "x" } as AgentAttestation).reason).toBe("unsupported_kind");
  });
});

describe("AttestationService", () => {
  const saved = { req: process.env.ARC_AGENT_ATTESTATION, dom: process.env.ARC_SPIFFE_TRUST_DOMAINS };
  afterEach(() => {
    if (saved.req === undefined) delete process.env.ARC_AGENT_ATTESTATION; else process.env.ARC_AGENT_ATTESTATION = saved.req;
    if (saved.dom === undefined) delete process.env.ARC_SPIFFE_TRUST_DOMAINS; else process.env.ARC_SPIFFE_TRUST_DOMAINS = saved.dom;
  });

  it("defaults to optional and verifies spiffe", () => {
    delete process.env.ARC_AGENT_ATTESTATION;
    delete process.env.ARC_SPIFFE_TRUST_DOMAINS;
    const s = new AttestationService();
    expect(s.required).toBe(false);
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
});
