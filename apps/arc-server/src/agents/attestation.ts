import { Injectable, Logger } from "@nestjs/common";
import { X509Certificate, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentAttestation } from "@arc/types";

/**
 * Engine-C attestation (ADR-005 Phase 5). At enrollment an agent may present a workload-
 * identity attestation so its identity is a *checkable fact*, not a bare self-assertion.
 * The verifier is pluggable by `kind` — SPIFFE is the first concrete input (arc's K8s /
 * operator direction), with sigstore / TPM / cloud-IID slotting in behind the same
 * interface later.
 *
 * **Two modes:**
 *   - **record** (default, `ARC_SPIFFE_ENFORCE` unset / "false"): the SPIFFE verifier
 *     validates the SPIFFE ID's *identity* — its `spiffe://` format and the trust-domain
 *     allowlist — and records it. No cryptographic validation of the SVID document.
 *   - **enforce** (`ARC_SPIFFE_ENFORCE=true`): the `doc` MUST be a PEM-encoded X.509-SVID
 *     chain. The verifier parses every cert, walks the chain to a root in the configured
 *     trust bundle for the leaf's trust domain, checks the validity window, and pulls the
 *     SPIFFE URI from the leaf's SAN — *that* is the recorded subject. A bare SPIFFE ID
 *     string is refused in this mode.
 *
 * Trust bundles are configured by `ARC_SPIFFE_TRUST_BUNDLES`:
 *   `<trust-domain>=<path-to-pem>,<trust-domain>=<path-to-pem>`
 * Each PEM file may contain one or more `BEGIN CERTIFICATE` blocks (the trust roots for
 * that domain). Bundles are loaded once at boot; rotation is a restart for now (the
 * verifier interface leaves room for a JWKS-style hot-reload follow-up).
 *
 * JWT-SVID enforce-mode is **deliberately deferred**. Enforce v1 covers the more common
 * SPIRE deployment shape (X.509-SVID via Workload API). When JWT-SVID enforce lands it
 * will use the trust bundle's keys via the same pluggable interface.
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
/** `-----BEGIN CERTIFICATE-----` marker — both LF and CRLF tolerated. */
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export interface SpiffeVerifierOptions {
  /** Closed allowlist of trust domains. Empty = any well-formed domain (record mode only). */
  allowedTrustDomains: ReadonlySet<string>;
  /** When true, the `doc` MUST be a PEM-encoded X.509-SVID chain and is cryptographically validated. */
  enforce: boolean;
  /** Per-trust-domain CA bundle. Keys are trust-domain names; values are arrays of CA X509Certificates. */
  trustBundles: ReadonlyMap<string, readonly X509Certificate[]>;
  /** Injectable clock for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * SPIFFE verifier. In **record** mode, parses + validates the SPIFFE ID string and applies
 * the trust-domain allowlist. In **enforce** mode, parses the PEM-encoded X.509-SVID chain,
 * walks it to a root in the configured trust bundle, validates dates + the SPIFFE URI SAN.
 */
export class SpiffeAttestationVerifier implements AttestationVerifier {
  readonly kind = "spiffe" as const;
  private readonly opts: SpiffeVerifierOptions;
  private readonly now: () => Date;

  constructor(opts: SpiffeVerifierOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  verify(attestation: AgentAttestation): AttestationResult {
    if (attestation.kind !== "spiffe") return reject("unsupported_kind");
    const doc = attestation.doc.trim();
    const isPem = /-----BEGIN CERTIFICATE-----/.test(doc);

    if (this.opts.enforce) {
      // Enforce mode: bare SPIFFE-ID strings are no longer acceptable — they don't bind any
      // crypto, and we just told the operator we'd cryptographically validate.
      if (!isPem) return reject("enforce_requires_svid_doc");
      return this.verifyX509Svid(doc);
    }

    // Record mode (default). Either a bare SPIFFE ID or a PEM SVID; from PEM we extract
    // the URI from the leaf's SAN without verifying the chain.
    if (isPem) {
      const leaf = parsePemChain(doc)[0];
      if (!leaf) return reject("malformed_pem");
      const uri = extractSpiffeUri(leaf);
      if (!uri) return reject("svid_missing_spiffe_uri");
      return this.validateIdString(uri);
    }
    return this.validateIdString(doc);
  }

  private validateIdString(idStr: string): AttestationResult {
    const m = SPIFFE_ID.exec(idStr);
    if (!m) return reject("malformed_spiffe_id");
    const trustDomain = m[1]!;
    if (this.opts.allowedTrustDomains.size > 0 && !this.opts.allowedTrustDomains.has(trustDomain)) {
      return reject("untrusted_domain");
    }
    return { ok: true, subject: idStr, trustAnchor: trustDomain };
  }

  private verifyX509Svid(pemBundle: string): AttestationResult {
    let chain: X509Certificate[];
    try {
      chain = parsePemChain(pemBundle);
    } catch {
      return reject("malformed_pem");
    }
    if (chain.length === 0) return reject("malformed_pem");

    const leaf = chain[0]!;
    const uri = extractSpiffeUri(leaf);
    if (!uri) return reject("svid_missing_spiffe_uri");

    const m = SPIFFE_ID.exec(uri);
    if (!m) return reject("malformed_spiffe_id");
    const trustDomain = m[1]!;
    if (this.opts.allowedTrustDomains.size > 0 && !this.opts.allowedTrustDomains.has(trustDomain)) {
      return reject("untrusted_domain");
    }
    const bundle = this.opts.trustBundles.get(trustDomain);
    if (!bundle || bundle.length === 0) {
      // We were asked to enforce against a domain we have no bundle for. That's a config
      // error masquerading as an auth result; surface it loudly rather than failing open.
      return reject("no_trust_bundle_for_domain");
    }

    const now = this.now().getTime();
    // Walk leaf → intermediates → root. Each cert must be verifiable by the next (in the
    // provided chain) or by a CA in the trust bundle, and within its validity window.
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i]!;
      if (Date.parse(c.validFrom) > now) return reject("cert_not_yet_valid");
      if (Date.parse(c.validTo) < now) return reject("cert_expired");
      const issuer = findIssuer(c, chain.slice(i + 1), bundle);
      if (!issuer) return reject("no_issuer_in_chain_or_bundle");
      try {
        if (!c.verify(issuer.publicKey)) return reject("invalid_signature");
      } catch {
        return reject("invalid_signature");
      }
      // If we just verified against a bundle root, we're done — chain anchored.
      if (bundle.includes(issuer)) {
        return { ok: true, subject: uri, trustAnchor: trustDomain };
      }
    }
    // Reached end of the provided chain without anchoring to the bundle.
    return reject("chain_does_not_anchor_to_bundle");
  }
}

function reject(reason: string): AttestationResult {
  return { ok: false, subject: null, trustAnchor: null, reason };
}

/** Split a multi-PEM blob into ordered `X509Certificate`s. Throws on parse failure. */
function parsePemChain(pem: string): X509Certificate[] {
  const matches = pem.match(PEM_CERT_RE);
  if (!matches) return [];
  return matches.map((block) => new X509Certificate(Buffer.from(block, "utf8")));
}

/**
 * Find the cert that issued `c` — either later in the provided chain, or in the trust
 * bundle. Match is by Subject DN string (cheap + correct enough for SPIFFE deployments
 * where SPIRE-issued certs have stable Subject identities).
 */
function findIssuer(
  c: X509Certificate,
  laterInChain: readonly X509Certificate[],
  bundle: readonly X509Certificate[],
): X509Certificate | null {
  const target = c.issuer;
  // Self-signed leaf (Subject == Issuer): only legitimate if the root *is* the leaf and
  // the leaf appears in the bundle. Otherwise we'd accept any self-signed claim.
  if (c.subject === c.issuer) {
    return bundle.find((b) => b.subject === c.subject && b.toString() === c.toString()) ?? null;
  }
  for (const cand of laterInChain) if (cand.subject === target) return cand;
  for (const cand of bundle) if (cand.subject === target) return cand;
  return null;
}

/**
 * Pull the SPIFFE URI from a leaf cert's SubjectAlternativeName. Node's `subjectAltName`
 * is a comma-separated string of `<kind>:<value>` entries; we want the `URI:spiffe://…`
 * one. Returns `null` if there isn't exactly one.
 */
function extractSpiffeUri(cert: X509Certificate): string | null {
  const san = cert.subjectAltName;
  if (!san) return null;
  // Common encodings: `URI:spiffe://example.org/x` or `Uniform Resource Identifier:spiffe://…`.
  const matches = san.match(/\b(?:URI|Uniform Resource Identifier):(spiffe:\/\/[^\s,]+)/g);
  if (!matches || matches.length !== 1) return null;
  return matches[0]!.replace(/^[^:]+:/, "");
}

/**
 * Parse `ARC_SPIFFE_TRUST_BUNDLES` — `<domain>=<path>,<domain>=<path>,…`. Each path points
 * at a PEM file with one or more `BEGIN CERTIFICATE` blocks (the CA roots for that domain).
 * Malformed entries are skipped with a warning rather than failing boot, mirroring the
 * trust-anchor parsing in PluginManifestService — typo in one entry doesn't take the
 * verifier down.
 */
export function loadTrustBundlesFromEnv(raw: string): Map<string, X509Certificate[]> {
  const out = new Map<string, X509Certificate[]>();
  const log = new Logger("SpiffeAttestationVerifier");
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      log.warn(`ignored malformed trust bundle "${entry}" (expected "<domain>=<path>")`);
      continue;
    }
    const domain = entry.slice(0, eq).trim();
    const path = entry.slice(eq + 1).trim();
    try {
      const pem = readFileSync(path, "utf8");
      const certs = parsePemChain(pem);
      if (certs.length === 0) {
        log.warn(`trust bundle for "${domain}" at ${path} contains no CERTIFICATE blocks`);
        continue;
      }
      out.set(domain, certs);
    } catch (err) {
      log.warn(`failed to load trust bundle for "${domain}" at ${path}: ${(err as Error).message}`);
    }
  }
  return out;
}

// `createPublicKey` re-export anchors the dependency on `node:crypto` for downstream
// verifiers (the JWT-SVID enforce path will need it). Kept tiny + side-effect-free.
void createPublicKey;
void (null as unknown as KeyObject);

/**
 * Selects a verifier by attestation kind and applies the enrollment-time policy. Config:
 *  - `ARC_AGENT_ATTESTATION` = `optional` (default) | `required`. In `required` mode an agent
 *    can't enroll without a verifiable attestation.
 *  - `ARC_SPIFFE_TRUST_DOMAINS` = comma-separated allowlist (empty = any well-formed domain).
 *  - `ARC_SPIFFE_ENFORCE` = `true` to require cryptographic SVID validation (enforce-mode).
 *  - `ARC_SPIFFE_TRUST_BUNDLES` = `<domain>=<pem-path>,…` for enforce-mode chain validation.
 */
@Injectable()
export class AttestationService {
  private readonly logger = new Logger(AttestationService.name);
  private readonly verifiers = new Map<string, AttestationVerifier>();
  readonly required: boolean;
  readonly enforce: boolean;

  constructor() {
    this.required = (process.env.ARC_AGENT_ATTESTATION ?? "optional").toLowerCase() === "required";
    this.enforce = (process.env.ARC_SPIFFE_ENFORCE ?? "false").toLowerCase() === "true";
    const domains = new Set(
      (process.env.ARC_SPIFFE_TRUST_DOMAINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
    const bundles = this.enforce ? loadTrustBundlesFromEnv(process.env.ARC_SPIFFE_TRUST_BUNDLES ?? "") : new Map();
    if (this.enforce && bundles.size === 0) {
      // Operator asked for enforce but configured no bundles. Refuse to start in production
      // (fail-closed); in dev/test this is a loud warning so test envs aren't blocked.
      const msg =
        "ARC_SPIFFE_ENFORCE=true but ARC_SPIFFE_TRUST_BUNDLES is empty or all paths failed to load. " +
        "Configure at least one trust bundle, or unset ARC_SPIFFE_ENFORCE.";
      if (process.env.NODE_ENV === "production") {
        throw new Error(msg);
      }
      this.logger.warn(msg);
    }
    this.register(new SpiffeAttestationVerifier({
      allowedTrustDomains: domains,
      enforce: this.enforce,
      trustBundles: bundles,
    }));
    this.logger.log(
      `AttestationService (required=${this.required}, enforce=${this.enforce}, spiffe trust domains=${domains.size > 0 ? [...domains].join(",") : "any"}, bundles=${bundles.size})`,
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
