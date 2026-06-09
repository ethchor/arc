import { Injectable, Logger } from "@nestjs/common";
import { X509Certificate, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentAttestation } from "@arc/types";

/**
 * Engine-C attestation (ADR-005 Phase 5). At enrollment an agent may present a workload-
 * identity attestation so its identity is a *checkable fact*, not a bare self-assertion.
 * The verifier is pluggable by `kind` — SPIFFE is the first concrete input (arc's K8s /
 * operator direction), with sigstore / TPM / cloud-IID slotting in behind the same
 * interface later.
 *
 * **Three doc shapes under the `spiffe` kind:**
 *   - **bare SPIFFE ID** (record mode only): `spiffe://<trust-domain>/<path>`.
 *   - **X.509-SVID** (record OR enforce): PEM-encoded chain. In record mode the URI is
 *     extracted from the SAN without verification; in enforce mode the chain is walked to
 *     a root in the configured trust bundle for the leaf's trust domain, validity dates
 *     are checked, and the SPIFFE URI SAN becomes the recorded subject.
 *   - **JWT-SVID** (record OR enforce): a compact JWS (`header.payload.signature`). In
 *     enforce mode the JWT is parsed, the signature is verified against the JWK in the
 *     configured JWKS bundle for the trust domain (selected by `kid`), `exp`/`nbf` are
 *     checked, and SPIFFE's `aud` requirement is enforced (matched against
 *     `ARC_SPIFFE_REQUIRED_AUDIENCE` when configured).
 *
 * **Two modes:**
 *   - **record** (default, `ARC_SPIFFE_ENFORCE` unset / "false"): identity is validated but
 *     no cryptography is checked. The SPIFFE ID is recorded as a fact.
 *   - **enforce** (`ARC_SPIFFE_ENFORCE=true`): cryptographic validation against the
 *     configured trust + JWKS bundles is mandatory. A bare SPIFFE ID string is refused.
 *
 * Trust roots are configured by env:
 *   `ARC_SPIFFE_TRUST_BUNDLES = <trust-domain>=<path-to-pem>,…` (X.509 CA bundles)
 *   `ARC_SPIFFE_JWKS_BUNDLES  = <trust-domain>=<path-to-jwks-json>,…` (JWT-SVID JWK Sets)
 *   `ARC_SPIFFE_REQUIRED_AUDIENCE` (optional; when set, JWT-SVIDs must list this exact
 *    audience — usually the arc-server's own identifier)
 *
 * Bundles are loaded once at boot; rotation is a restart for now (hot-reload is its own
 * follow-up).
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
/** Compact JWS: three base64url segments separated by dots. */
const JWT_COMPACT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * A JWK as it appears inside a JWKS bundle. We keep the shape loose (`Record<string,
 * unknown>`) so any of EC / OKP / RSA jwks pass through to Node's `createPublicKey({ key,
 * format: "jwk" })` without us needing an exhaustive per-kty schema.
 */
export type Jwk = Record<string, unknown> & { kty: string; kid?: string };

export interface JwkSet {
  keys: readonly Jwk[];
}

export interface SpiffeVerifierOptions {
  /** Closed allowlist of trust domains. Empty = any well-formed domain (record mode only). */
  allowedTrustDomains: ReadonlySet<string>;
  /** When true, both X.509-SVID and JWT-SVID docs are cryptographically validated. */
  enforce: boolean;
  /** Per-trust-domain CA bundle (X.509-SVID). Empty Map = no X.509 enforce surface. */
  trustBundles: ReadonlyMap<string, readonly X509Certificate[]>;
  /** Per-trust-domain JWK Set (JWT-SVID). Empty Map = no JWT-SVID enforce surface. */
  jwksBundles?: ReadonlyMap<string, JwkSet>;
  /**
   * Required audience for JWT-SVIDs. SPIFFE's `aud` claim is mandatory in the spec; this is
   * the extra check that the audience matches *this* arc-server (usually a stable identifier
   * like `https://arc.example.com` or just `arc-server`). Unset = "any non-empty aud".
   */
  requiredAudience?: string;
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
    const isJwt = !isPem && JWT_COMPACT_RE.test(doc);

    if (this.opts.enforce) {
      // Enforce mode: bare SPIFFE-ID strings are no longer acceptable — they don't bind any
      // crypto, and we just told the operator we'd cryptographically validate.
      if (isPem) return this.verifyX509Svid(doc);
      if (isJwt) return this.verifyJwtSvid(doc);
      return reject("enforce_requires_svid_doc");
    }

    // Record mode (default). Bare SPIFFE ID, X.509-SVID, or JWT-SVID — from SVID docs we
    // extract the URI without verifying the signature/chain.
    if (isPem) {
      const leaf = parsePemChain(doc)[0];
      if (!leaf) return reject("malformed_pem");
      const uri = extractSpiffeUri(leaf);
      if (!uri) return reject("svid_missing_spiffe_uri");
      return this.validateIdString(uri);
    }
    if (isJwt) {
      let payload: Record<string, unknown>;
      try {
        payload = parseJwt(doc).payload;
      } catch {
        return reject("malformed_jwt");
      }
      const sub = payload["sub"];
      if (typeof sub !== "string") return reject("jwt_subject_not_spiffe");
      return this.validateIdString(sub);
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

  /**
   * Enforce a JWT-SVID. Parse → look up the JWK by `kid` in the trust domain's JWKS →
   * verify the signature → enforce `exp` / `nbf` / `aud` per the SPIFFE JWT-SVID spec.
   *
   * Algorithm support is intentionally narrow — the four SPIRE actually uses (ES256, ES384,
   * RS256, EdDSA). Anything else fails closed with `unsupported_jwt_alg` rather than a
   * silently-accepted weaker algorithm.
   */
  private verifyJwtSvid(jwt: string): AttestationResult {
    let parsed: ParsedJwt;
    try {
      parsed = parseJwt(jwt);
    } catch {
      return reject("malformed_jwt");
    }
    const { header, payload, signingInput, signature } = parsed;

    const alg = typeof header["alg"] === "string" ? (header["alg"] as string) : null;
    if (!alg || !JWT_SVID_ALGS[alg as keyof typeof JWT_SVID_ALGS]) {
      return reject("unsupported_jwt_alg");
    }
    const kid = typeof header["kid"] === "string" ? (header["kid"] as string) : null;

    // Subject must be a SPIFFE id. Trust domain comes from the parse — same shape as the
    // X.509 path uses, so allowlist + bundle lookup are identical.
    const sub = payload["sub"];
    if (typeof sub !== "string") return reject("jwt_subject_not_spiffe");
    const m = SPIFFE_ID.exec(sub);
    if (!m) return reject("jwt_subject_not_spiffe");
    const trustDomain = m[1]!;
    if (this.opts.allowedTrustDomains.size > 0 && !this.opts.allowedTrustDomains.has(trustDomain)) {
      return reject("untrusted_domain");
    }
    const jwks = this.opts.jwksBundles?.get(trustDomain);
    if (!jwks || jwks.keys.length === 0) return reject("no_jwks_for_domain");

    const jwk = pickJwk(jwks, kid);
    if (!jwk) return reject("no_jwk_matching_kid");

    let key: ReturnType<typeof createPublicKey>;
    try {
      key = createPublicKey({ key: jwk as Record<string, unknown>, format: "jwk" });
    } catch {
      return reject("malformed_jwk");
    }

    const spec = JWT_SVID_ALGS[alg as keyof typeof JWT_SVID_ALGS];
    let signatureOk = false;
    try {
      const data = Buffer.from(signingInput, "utf8");
      if (spec.dsaEncoding) {
        signatureOk = cryptoVerify(spec.digest, data, { key, dsaEncoding: spec.dsaEncoding }, signature);
      } else {
        // EdDSA / Ed25519 — digest arg is null per Node's API.
        signatureOk = cryptoVerify(spec.digest, data, key, signature);
      }
    } catch {
      return reject("jwt_signature_invalid");
    }
    if (!signatureOk) return reject("jwt_signature_invalid");

    // SPIFFE requires aud. We check it independently of the signature step so the operator
    // sees the *real* reason instead of a generic crypto rejection.
    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (typeof payload["exp"] !== "number" || payload["exp"] < nowSec) return reject("jwt_expired");
    if (typeof payload["nbf"] === "number" && payload["nbf"] > nowSec) return reject("jwt_not_yet_valid");

    const aud = payload["aud"];
    const audList: string[] = Array.isArray(aud)
      ? aud.filter((a): a is string => typeof a === "string")
      : typeof aud === "string" ? [aud] : [];
    if (audList.length === 0) return reject("jwt_missing_audience");
    if (this.opts.requiredAudience && !audList.includes(this.opts.requiredAudience)) {
      return reject("jwt_audience_mismatch");
    }

    return { ok: true, subject: sub, trustAnchor: trustDomain };
  }
}

/**
 * SPIRE-supported JWT-SVID algorithms. We keep this list explicit rather than passing
 * whatever `alg` the JWT header claims into `crypto.verify` — both because Node's
 * `verify("HS256", …)` would silently succeed against a public key in some shapes
 * (HMAC-keyed) and because the SPIRE spec enumerates exactly these four.
 */
const JWT_SVID_ALGS = {
  ES256: { digest: "sha256", dsaEncoding: "ieee-p1363" as const },
  ES384: { digest: "sha384", dsaEncoding: "ieee-p1363" as const },
  RS256: { digest: "sha256", dsaEncoding: undefined },
  EdDSA: { digest: null as unknown as string, dsaEncoding: undefined },
} satisfies Record<string, { digest: string | null; dsaEncoding?: "ieee-p1363" }>;

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

// --- JWT-SVID helpers ---------------------------------------------------------------

interface ParsedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** The literal `<header-b64u>.<payload-b64u>` string crypto.verify signs over. */
  signingInput: string;
  signature: Buffer;
}

function parseJwt(s: string): ParsedJwt {
  const parts = s.split(".");
  if (parts.length !== 3) throw new Error("malformed_jwt");
  const [h, p, sig] = parts;
  if (!h || !p || !sig) throw new Error("malformed_jwt");
  const header = JSON.parse(b64uToBuffer(h).toString("utf8")) as Record<string, unknown>;
  const payload = JSON.parse(b64uToBuffer(p).toString("utf8")) as Record<string, unknown>;
  if (header === null || typeof header !== "object") throw new Error("malformed_jwt");
  if (payload === null || typeof payload !== "object") throw new Error("malformed_jwt");
  return {
    header,
    payload,
    signingInput: `${h}.${p}`,
    signature: b64uToBuffer(sig),
  };
}

function b64uToBuffer(s: string): Buffer {
  // base64url → base64 + padding so Buffer can decode it.
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * Pick a JWK from the bundle by `kid`. If the JWT has no `kid` header (rare but legal),
 * accept the only key when the bundle has exactly one — otherwise refuse, since silently
 * picking a key when the bundle has many is what enables substitution attacks.
 */
function pickJwk(jwks: JwkSet, kid: string | null): Jwk | null {
  if (kid === null) return jwks.keys.length === 1 ? jwks.keys[0]! : null;
  return jwks.keys.find((k) => k.kid === kid) ?? null;
}

/**
 * Parse `ARC_SPIFFE_JWKS_BUNDLES` — `<domain>=<path-to-jwks.json>,…`. Each path points at a
 * JSON file shaped `{"keys":[<jwk>,…]}` (the standard JWK Set form SPIRE bundles use).
 * Malformed entries are skipped with a warning, mirroring `loadTrustBundlesFromEnv`.
 */
export function loadJwksBundlesFromEnv(raw: string): Map<string, JwkSet> {
  const out = new Map<string, JwkSet>();
  const log = new Logger("SpiffeAttestationVerifier");
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      log.warn(`ignored malformed JWKS bundle "${entry}" (expected "<domain>=<path>")`);
      continue;
    }
    const domain = entry.slice(0, eq).trim();
    const path = entry.slice(eq + 1).trim();
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray((parsed as { keys?: unknown }).keys)
      ) {
        log.warn(`JWKS bundle for "${domain}" at ${path} doesn't have a "keys" array; skipped`);
        continue;
      }
      const keys = (parsed as { keys: unknown[] }).keys.filter(
        (k): k is Jwk => !!k && typeof k === "object" && typeof (k as { kty?: unknown }).kty === "string",
      );
      if (keys.length === 0) {
        log.warn(`JWKS bundle for "${domain}" at ${path} contains no valid JWKs`);
        continue;
      }
      out.set(domain, { keys });
    } catch (err) {
      log.warn(`failed to load JWKS bundle for "${domain}" at ${path}: ${(err as Error).message}`);
    }
  }
  return out;
}

/**
 * Selects a verifier by attestation kind and applies the enrollment-time policy. Config:
 *  - `ARC_AGENT_ATTESTATION` = `optional` (default) | `required`. In `required` mode an agent
 *    can't enroll without a verifiable attestation.
 *  - `ARC_SPIFFE_TRUST_DOMAINS` = comma-separated allowlist (empty = any well-formed domain).
 *  - `ARC_SPIFFE_ENFORCE` = `true` to require cryptographic SVID validation (enforce-mode).
 *  - `ARC_SPIFFE_TRUST_BUNDLES` = `<domain>=<pem-path>,…` for enforce-mode X.509 chain validation.
 *  - `ARC_SPIFFE_JWKS_BUNDLES` = `<domain>=<jwks-path>,…` for enforce-mode JWT-SVID validation.
 *  - `ARC_SPIFFE_REQUIRED_AUDIENCE` = expected `aud` value in JWT-SVIDs (optional).
 *    Unset = any non-empty `aud` accepted.
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
    const jwks = this.enforce ? loadJwksBundlesFromEnv(process.env.ARC_SPIFFE_JWKS_BUNDLES ?? "") : new Map();
    const requiredAudience = process.env.ARC_SPIFFE_REQUIRED_AUDIENCE?.trim() || undefined;
    if (this.enforce && bundles.size === 0 && jwks.size === 0) {
      // Operator asked for enforce but configured neither X.509 trust bundles nor JWKS
      // bundles. Refuse to start in production (fail-closed); in dev/test this is a loud
      // warning so test envs aren't blocked.
      const msg =
        "ARC_SPIFFE_ENFORCE=true but both ARC_SPIFFE_TRUST_BUNDLES and ARC_SPIFFE_JWKS_BUNDLES " +
        "are empty (or all paths failed to load). Configure at least one bundle, or unset " +
        "ARC_SPIFFE_ENFORCE.";
      if (process.env.NODE_ENV === "production") {
        throw new Error(msg);
      }
      this.logger.warn(msg);
    }
    this.register(new SpiffeAttestationVerifier({
      allowedTrustDomains: domains,
      enforce: this.enforce,
      trustBundles: bundles,
      jwksBundles: jwks,
      ...(requiredAudience ? { requiredAudience } : {}),
    }));
    this.logger.log(
      `AttestationService (required=${this.required}, enforce=${this.enforce}, ` +
        `spiffe trust domains=${domains.size > 0 ? [...domains].join(",") : "any"}, ` +
        `x509 bundles=${bundles.size}, jwks bundles=${jwks.size}` +
        (requiredAudience ? `, required aud=${requiredAudience})` : ")"),
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
