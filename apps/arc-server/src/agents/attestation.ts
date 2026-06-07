import { Injectable, Logger } from "@nestjs/common";
import type { AgentAttestation } from "@arc/types";

/**
 * Engine-C attestation (ADR-005 Phase 5). At enrollment an agent may present a workload-
 * identity attestation so its identity is a *checkable fact*, not a bare self-assertion.
 * The verifier is pluggable by `kind` — SPIFFE is the first concrete input (arc's K8s /
 * operator direction), with sigstore / TPM / cloud-IID slotting in behind the same
 * interface later.
 *
 * **Scope of v1 (honest framing):** the SPIFFE verifier validates the SVID *identity* — its
 * `spiffe://` format and trust-domain policy — and records it. It does **not** yet perform
 * cryptographic SVID validation (X.509-SVID chain to the trust bundle, or JWT-SVID signature
 * verification); that is the enforce-mode follow-up. So v1 turns "I claim to be
 * `spiffe://…`" into "a well-formed id in an allowed trust domain, recorded against the
 * agent" — the hook + policy surface, with the cryptographic step deliberately deferred.
 */
export interface AttestationResult {
  ok: boolean;
  /** The resolved workload identity (e.g. the full SPIFFE ID) when `ok`. */
  subject: string | null;
  /** The trust anchor the identity belongs to (e.g. the SPIFFE trust domain). */
  trustAnchor: string | null;
  /** Machine-readable rejection reason when `!ok`. */
  reason?: string;
}

export interface AttestationVerifier {
  readonly kind: AgentAttestation["kind"];
  verify(attestation: AgentAttestation): AttestationResult;
}

/** `spiffe://<trust-domain>/<path>` — trust domain is a DNS-name-ish lowercase label set. */
const SPIFFE_ID = /^spiffe:\/\/([a-z0-9._-]+)(\/[A-Za-z0-9._\-/]*)?$/;

/**
 * SPIFFE verifier (v1): parses + validates the SPIFFE ID in `attestation.doc` and applies a
 * trust-domain allowlist. See the module note — this records identity + applies policy; it
 * does not cryptographically validate the SVID yet.
 */
export class SpiffeAttestationVerifier implements AttestationVerifier {
  readonly kind = "spiffe" as const;
  constructor(private readonly allowedTrustDomains: ReadonlySet<string>) {}

  verify(attestation: AgentAttestation): AttestationResult {
    if (attestation.kind !== "spiffe") return reject("unsupported_kind");
    const m = SPIFFE_ID.exec(attestation.doc.trim());
    if (!m) return reject("malformed_spiffe_id");
    const trustDomain = m[1]!;
    if (this.allowedTrustDomains.size > 0 && !this.allowedTrustDomains.has(trustDomain)) {
      return reject("untrusted_domain");
    }
    return { ok: true, subject: attestation.doc.trim(), trustAnchor: trustDomain };
  }
}

function reject(reason: string): AttestationResult {
  return { ok: false, subject: null, trustAnchor: null, reason };
}

/**
 * Selects a verifier by attestation kind and applies the enrollment-time policy. Config:
 *  - `ARC_AGENT_ATTESTATION` = `optional` (default) | `required`. In `required` mode an agent
 *    can't enroll without a verifiable attestation.
 *  - `ARC_SPIFFE_TRUST_DOMAINS` = comma-separated allowlist (empty = any well-formed domain).
 */
@Injectable()
export class AttestationService {
  private readonly logger = new Logger(AttestationService.name);
  private readonly verifiers = new Map<string, AttestationVerifier>();
  readonly required: boolean;

  constructor() {
    this.required = (process.env.ARC_AGENT_ATTESTATION ?? "optional").toLowerCase() === "required";
    const domains = new Set(
      (process.env.ARC_SPIFFE_TRUST_DOMAINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    this.register(new SpiffeAttestationVerifier(domains));
    this.logger.log(
      `AttestationService (required=${this.required}, spiffe trust domains=${domains.size > 0 ? [...domains].join(",") : "any"})`,
    );
  }

  register(v: AttestationVerifier): void {
    this.verifiers.set(v.kind, v);
  }

  /** Verify a presented attestation. `kind: "none"` is treated as "no attestation present". */
  verify(attestation: AgentAttestation): AttestationResult {
    if (attestation.kind === "none") return { ok: false, subject: null, trustAnchor: null, reason: "no_attestation" };
    const verifier = this.verifiers.get(attestation.kind);
    if (!verifier) return { ok: false, subject: null, trustAnchor: null, reason: "unsupported_kind" };
    return verifier.verify(attestation);
  }
}
