import { normalizeMount } from "@arc/leasing";
import type {
  PkiCertificate,
  PkiEngine,
  PkiIssueRequest,
  PkiIssuedCertificate,
  PkiRevocation,
  PkiRole,
  PkiSignedCertificate,
  PkiSignRequest,
} from "@arc/secrets-engine";
import { OpenBaoError } from "./client";
import type { OpenBaoClient } from "./client";

const strip = (path: string): string => path.replace(/^\/+/, "");

/**
 * PKI engine backed by OpenBao. Maps arc's clean {@link PkiEngine} contract onto OpenBao's
 * `<mount>/issue/<role>`, `<mount>/sign/<role>`, `<mount>/revoke`, `<mount>/cert/<serial>`,
 * `<mount>/certs`, `<mount>/ca/pem`, `<mount>/ca_chain` HTTP layout.
 *
 * SANs (`alt_names`, `ip_sans`, `uri_sans`) are sent as comma-joined strings per the
 * OpenBao API. The role's own config still gates which SANs/CN patterns are accepted —
 * that's a CA-admin concern outside this adapter's scope.
 */
export class OpenBaoPkiEngine implements PkiEngine {
  readonly type = "pki" as const;
  readonly mount: string;

  constructor(
    private readonly client: OpenBaoClient,
    mount = "pki",
  ) {
    this.mount = normalizeMount(mount);
  }

  async issueCertificate(role: string, req: PkiIssueRequest): Promise<PkiIssuedCertificate> {
    const body = this.buildIssueBody(req);
    const res = await this.client.write(`${this.mount}issue/${strip(role)}`, body);
    return parseIssued(res.data);
  }

  async signCsr(role: string, req: PkiSignRequest): Promise<PkiSignedCertificate> {
    const body: Record<string, unknown> = { csr: req.csr };
    if (req.commonName !== undefined) body.common_name = req.commonName;
    if (req.ttlSeconds !== undefined) body.ttl = `${req.ttlSeconds}s`;
    if (req.altNames !== undefined) body.alt_names = req.altNames.join(",");
    if (req.ipSans !== undefined) body.ip_sans = req.ipSans.join(",");
    if (req.uriSans !== undefined) body.uri_sans = req.uriSans.join(",");
    if (req.excludeCnFromSans !== undefined) body.exclude_cn_from_sans = req.excludeCnFromSans;
    if (req.format !== undefined) body.format = req.format;
    const res = await this.client.write(`${this.mount}sign/${strip(role)}`, body);
    return parseSigned(res.data);
  }

  async revokeCertificate(serialNumber: string): Promise<PkiRevocation> {
    const res = await this.client.write(`${this.mount}revoke`, { serial_number: serialNumber });
    const data = (res.data ?? {}) as Record<string, unknown>;
    return { revocationTime: Number(data.revocation_time ?? 0) };
  }

  async readCertificate(serialNumber: string): Promise<PkiCertificate> {
    const res = await this.client.read(`${this.mount}cert/${strip(serialNumber)}`);
    const data = (res.data ?? {}) as Record<string, unknown>;
    const cert: PkiCertificate = { certificate: String(data.certificate ?? "") };
    const rev = Number(data.revocation_time ?? 0);
    if (Number.isFinite(rev) && rev > 0) cert.revocationTime = rev;
    return cert;
  }

  async listCertificates(): Promise<string[]> {
    try {
      const res = await this.client.list(`${this.mount}certs`);
      const keys = (res.data as { keys?: unknown } | undefined)?.keys;
      return Array.isArray(keys) ? (keys as string[]) : [];
    } catch (err) {
      // OpenBao returns 404 when a mount has no certs yet (Vault parity). Normalise to [].
      if (err instanceof OpenBaoError && err.status === 404) return [];
      throw err;
    }
  }

  async listRoles(): Promise<string[]> {
    try {
      const res = await this.client.list(`${this.mount}roles`);
      const keys = (res.data as { keys?: unknown } | undefined)?.keys;
      return Array.isArray(keys) ? (keys as string[]) : [];
    } catch (err) {
      if (err instanceof OpenBaoError && err.status === 404) return [];
      throw err;
    }
  }

  /**
   * `GET <mount>/roles/<name>` — role config. Maps the documented fields to
   * {@link PkiRole}; anything we don't recognise (`signature_bits`, `key_usage`,
   * `allowed_uri_sans`, …) is collected into `extra` so the UI can surface the full
   * config without a contract change for every OpenBao knob.
   */
  async readRole(roleName: string): Promise<PkiRole> {
    const res = await this.client.read(`${this.mount}roles/${strip(roleName)}`);
    const data = (res.data ?? {}) as Record<string, unknown>;
    const known = new Set([
      "ttl",
      "max_ttl",
      "allow_any_name",
      "allow_subdomains",
      "allow_bare_domains",
      "allowed_domains",
      "key_type",
      "key_bits",
    ]);
    const role: PkiRole = { name: roleName };
    const ttl = toSeconds(data.ttl);
    if (ttl !== undefined) role.ttlSeconds = ttl;
    const maxTtl = toSeconds(data.max_ttl);
    if (maxTtl !== undefined) role.maxTtlSeconds = maxTtl;
    if (typeof data.allow_any_name === "boolean") role.allowAnyName = data.allow_any_name;
    if (typeof data.allow_subdomains === "boolean") role.allowSubdomains = data.allow_subdomains;
    if (typeof data.allow_bare_domains === "boolean") role.allowBareDomains = data.allow_bare_domains;
    const domains = data.allowed_domains;
    if (typeof domains === "string") {
      role.allowedDomains = domains.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (Array.isArray(domains)) {
      role.allowedDomains = domains.filter((d): d is string => typeof d === "string");
    }
    if (typeof data.key_type === "string") role.keyType = data.key_type;
    if (typeof data.key_bits === "number") role.keyBits = data.key_bits;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (!known.has(k)) extra[k] = v;
    }
    if (Object.keys(extra).length > 0) role.extra = extra;
    return role;
  }

  async readCaCertificate(): Promise<string> {
    const res = await this.client.read(`${this.mount}ca/pem`);
    const data = (res.data ?? {}) as Record<string, unknown>;
    const cert = data.certificate;
    if (typeof cert === "string" && cert.length > 0) return cert;
    // Some OpenBao versions return the PEM directly in `data` for `ca/pem`. Fall back
    // to whatever string-shaped field we got.
    const direct = res as unknown as { certificate?: unknown };
    if (typeof direct.certificate === "string") return direct.certificate;
    throw new PkiProtocolError("expected PEM-encoded CA certificate in pki/ca/pem response");
  }

  async readCaChain(): Promise<string> {
    const res = await this.client.read(`${this.mount}ca_chain`);
    const data = (res.data ?? {}) as Record<string, unknown>;
    const chain = data.ca_chain;
    if (Array.isArray(chain)) return (chain as string[]).join("\n");
    if (typeof chain === "string") return chain;
    const direct = res as unknown as { ca_chain?: unknown };
    if (typeof direct.ca_chain === "string") return direct.ca_chain;
    if (Array.isArray(direct.ca_chain)) return (direct.ca_chain as string[]).join("\n");
    throw new PkiProtocolError("expected `ca_chain` in pki/ca_chain response");
  }

  private buildIssueBody(req: PkiIssueRequest): Record<string, unknown> {
    const body: Record<string, unknown> = { common_name: req.commonName };
    if (req.ttlSeconds !== undefined) body.ttl = `${req.ttlSeconds}s`;
    if (req.altNames !== undefined) body.alt_names = req.altNames.join(",");
    if (req.ipSans !== undefined) body.ip_sans = req.ipSans.join(",");
    if (req.uriSans !== undefined) body.uri_sans = req.uriSans.join(",");
    if (req.excludeCnFromSans !== undefined) body.exclude_cn_from_sans = req.excludeCnFromSans;
    if (req.format !== undefined) body.format = req.format;
    return body;
  }
}

function parseIssued(raw: Record<string, unknown> | undefined): PkiIssuedCertificate {
  const data = raw ?? {};
  return {
    certificate: String(data.certificate ?? ""),
    issuingCa: String(data.issuing_ca ?? ""),
    caChain: toStringArray(data.ca_chain),
    privateKey: String(data.private_key ?? ""),
    privateKeyType: String(data.private_key_type ?? ""),
    serialNumber: String(data.serial_number ?? ""),
    expiration: Number(data.expiration ?? 0),
  };
}

function parseSigned(raw: Record<string, unknown> | undefined): PkiSignedCertificate {
  const data = raw ?? {};
  return {
    certificate: String(data.certificate ?? ""),
    issuingCa: String(data.issuing_ca ?? ""),
    caChain: toStringArray(data.ca_chain),
    serialNumber: String(data.serial_number ?? ""),
    expiration: Number(data.expiration ?? 0),
  };
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * OpenBao returns role TTLs as either a number (seconds since some versions normalise it
 * server-side) or a Vault TTL string (`"24h"`, `"60m"`, `"3600s"`, bare integer). Parse
 * both forms back into a seconds integer; return `undefined` for anything we can't parse
 * so the caller leaves the field unset rather than fabricating a value.
 */
function toSeconds(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw >= 0 ? raw : undefined;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
}

export class PkiProtocolError extends Error {
  constructor(message: string) {
    super(`pki protocol error: ${message}`);
    this.name = "PkiProtocolError";
  }
}
