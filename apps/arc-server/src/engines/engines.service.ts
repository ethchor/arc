import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LeaseError, type LeaseManager } from "@arc/leasing";
import {
  MountRegistry,
  type DynamicSecretsEngine,
  type KvEngine,
  type PkiEngine,
  type PkiIssueRequest,
  type PkiSignRequest,
  type SecretsEngine,
  type TransitEngine,
} from "@arc/secrets-engine";
import { OpenBaoClient, OpenBaoError } from "@arc/openbao-adapter";

/**
 * Token under which the {@link EnginesConfig} factory provider is registered. The module
 * reads env once at boot and exposes the shape below; callers shouldn't read env directly.
 */
export const ENGINES_CONFIG = Symbol("ENGINES_CONFIG");

export interface EnginesConfig {
  /** `null` when BAO_ADDR is unset. The whole Engine-A surface returns 503 in that mode. */
  client: OpenBaoClient | null;
  registry: MountRegistry;
  /** Mount path (with trailing slash, the {@link MountRegistry} normalization) → engine. */
  enginesByMount: Map<string, SecretsEngine>;
  /**
   * Shared arc-internal lease registry. Every dynamic-secret engine mints leases through
   * this so `sys/leases/renew`/`revoke` can look them up by arc id regardless of engine.
   */
  leases: LeaseManager;
}

/**
 * Routes Engine-A requests through the {@link MountRegistry} to the engine adapter mounted
 * at the resolved path. The controller is purposely thin; everything interesting (dispatch
 * by engine type, error translation, the "no BAO_ADDR" 503 path) is here.
 *
 * When {@link EnginesConfig.client} is `null` (BAO_ADDR unset), every dispatch method
 * throws {@link ServiceUnavailableException} with a clear payload so the server still
 * boots with Engine-B working and Engine-A returning a structured "disabled" error.
 */
@Injectable()
export class EnginesService {
  private readonly logger = new Logger(EnginesService.name);

  constructor(@Inject(ENGINES_CONFIG) private readonly config: EnginesConfig) {}

  get enabled(): boolean {
    return this.config.client !== null;
  }

  /** `GET /v1/sys/seal-status` proxy. Throws 503 when Engine-A is disabled. */
  async sealStatus(): Promise<Record<string, unknown>> {
    const client = this.requireClient();
    return (await client.sealStatus()) as unknown as Record<string, unknown>;
  }

  /** `GET /v1/sys/health` proxy. */
  async health(): Promise<Record<string, unknown>> {
    const client = this.requireClient();
    return await client.health();
  }

  /**
   * Lists every registered mount. No `requireClient()` here — a plugin-only deployment
   * (no OpenBao, all mounts come from plugins) is a valid configuration, and the registry
   * is always queryable.
   */
  async listMounts(): Promise<Array<{ path: string; type: string; description?: string }>> {
    return this.config.registry.list().map((m) => ({
      path: m.path,
      type: String(m.type),
      description: m.description,
    }));
  }

  /**
   * Dispatch a `GET` against an engine path. KV reads (`<mount>/data/<key>`) become
   * {@link KvEngine.get}, KV list (`?list=true` against `<mount>/metadata/<prefix>`)
   * becomes {@link KvEngine.list}. Anything else returns 404.
   */
  async get(
    requestPath: string,
    query: Record<string, string | string[] | undefined>,
  ): Promise<Record<string, unknown>> {
    const { engine, relativePath } = this.resolve(requestPath);
    if (engine.type === "kv-v2") {
      const kv = engine as KvEngine;
      const listMode = query.list === "true" || query.list === "1";
      if (listMode && relativePath.startsWith("metadata/")) {
        const keys = await kv.list(relativePath.slice("metadata/".length));
        return { data: { keys } };
      }
      if (relativePath.startsWith("data/")) {
        const versionRaw = pickFirst(query.version);
        const version = versionRaw === undefined ? undefined : Number(versionRaw);
        const read = await kv.get(relativePath.slice("data/".length), version);
        return {
          data: {
            data: read.data,
            metadata: {
              version: read.metadata.version,
              created_time: read.metadata.createdTime,
              deletion_time:
                read.metadata.deleted && !read.metadata.destroyed ? "set" : "",
              destroyed: read.metadata.destroyed,
            },
          },
        };
      }
      throw new NotFoundException({ errors: [`unsupported KV path: ${relativePath}`] });
    }
    if (engine.type === "pki") {
      const pki = engine as PkiEngine;
      const listMode = query.list === "true" || query.list === "1";
      if (listMode && relativePath === "certs") {
        const keys = await pki.listCertificates();
        return { data: { keys } };
      }
      if (relativePath === "ca/pem" || relativePath === "ca") {
        const cert = await pki.readCaCertificate();
        return { data: { certificate: cert } };
      }
      if (relativePath === "ca_chain") {
        const chain = await pki.readCaChain();
        return { data: { ca_chain: chain } };
      }
      if (relativePath.startsWith("cert/")) {
        const serial = relativePath.slice("cert/".length);
        const cert = await pki.readCertificate(serial);
        const data: Record<string, unknown> = { certificate: cert.certificate };
        if (cert.revocationTime !== undefined) data.revocation_time = cert.revocationTime;
        return { data };
      }
      throw new NotFoundException({ errors: [`unsupported PKI path: ${relativePath}`] });
    }
    // Any dynamic-secrets engine — including plugin-backed mounts — exposes credentials
    // through `<mount>/creds/<role>`. Routing is by capability (DynamicSecretsEngine
    // shape), not by `type` string, so plugins don't need to claim "database".
    if (relativePath.startsWith("creds/") && isDynamicSecretsEngine(engine)) {
      const role = relativePath.slice("creds/".length);
      const issued = await engine.issue(role);
      return {
        data: issued.data,
        lease_id: issued.lease.id,
        lease_duration: leaseDurationSeconds(issued.lease),
        renewable: issued.lease.renewable,
      };
    }
    throw new NotFoundException({
      errors: [`engine type ${engine.type} does not support GET at ${relativePath}`],
    });
  }

  /**
   * `POST /v1/sys/leases/renew` — renew an arc-internal lease. The dispatcher resolves
   * the lease's mount to a {@link DynamicSecretsEngine} and delegates; the adapter knows
   * how to drive the upstream `sys/leases/renew` against OpenBao if needed.
   */
  async renewLease(leaseId: string, incrementSeconds?: number): Promise<Record<string, unknown>> {
    const lease = this.config.leases.get(leaseId);
    if (!lease) throw new NotFoundException({ errors: [`no lease ${leaseId}`] });
    const engine = this.config.enginesByMount.get(lease.mount);
    if (!engine) {
      throw new NotFoundException({
        errors: [`engine not registered for mount ${lease.mount}`],
      });
    }
    if (!isDynamicSecretsEngine(engine)) {
      throw new BadRequestException({
        errors: [`engine ${engine.type} at ${lease.mount} does not support leasing`],
      });
    }
    try {
      const renewed = await engine.renew(leaseId, incrementSeconds);
      return {
        lease_id: renewed.id,
        lease_duration: leaseDurationSeconds(renewed),
        renewable: renewed.renewable,
      };
    } catch (err) {
      if (err instanceof LeaseError) {
        throw new BadRequestException({ errors: [err.message], code: err.code });
      }
      throw err;
    }
  }

  /** `PUT /v1/sys/leases/revoke/<id>` / `POST /v1/sys/leases/revoke {lease_id}`. */
  async revokeLease(leaseId: string): Promise<void> {
    const lease = this.config.leases.get(leaseId);
    if (!lease) throw new NotFoundException({ errors: [`no lease ${leaseId}`] });
    const engine = this.config.enginesByMount.get(lease.mount);
    if (!engine) {
      throw new NotFoundException({
        errors: [`engine not registered for mount ${lease.mount}`],
      });
    }
    if (!isDynamicSecretsEngine(engine)) {
      throw new BadRequestException({
        errors: [`engine ${engine.type} at ${lease.mount} does not support leasing`],
      });
    }
    try {
      await engine.revoke(leaseId);
    } catch (err) {
      if (err instanceof LeaseError) {
        throw new BadRequestException({ errors: [err.message], code: err.code });
      }
      throw err;
    }
  }

  /**
   * Dispatch a `POST`. KV writes, transit create-key / rotate / encrypt / decrypt all flow
   * through here. Body shape mirrors OpenBao's (Vault-compatible) wire format so existing
   * Vault client SDKs Just Work against this surface.
   */
  async post(
    requestPath: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { engine, relativePath } = this.resolve(requestPath);

    if (engine.type === "kv-v2" && relativePath.startsWith("data/")) {
      const kv = engine as KvEngine;
      const data = (body.data as Record<string, unknown> | undefined) ?? {};
      const options = body.options as { cas?: number } | undefined;
      const res = await kv.put(relativePath.slice("data/".length), data, {
        cas: options?.cas,
      });
      return { data: { version: res.version, created_time: res.createdTime } };
    }

    if (engine.type === "transit") {
      const transit = engine as TransitEngine;
      if (relativePath.startsWith("keys/")) {
        const rest = relativePath.slice("keys/".length);
        const rotateMatch = /^(.+)\/rotate$/.exec(rest);
        if (rotateMatch) {
          const { latestVersion } = await transit.rotateKey(rotateMatch[1]!);
          return { data: { latest_version: latestVersion } };
        }
        await transit.createKey(rest, {
          algorithm: typeof body.type === "string" ? (body.type as string) : undefined,
          exportable:
            typeof body.exportable === "boolean" ? (body.exportable as boolean) : undefined,
        });
        return { data: { created: true } };
      }
      if (relativePath.startsWith("encrypt/")) {
        const keyName = relativePath.slice("encrypt/".length);
        const plaintextB64 = body.plaintext;
        if (typeof plaintextB64 !== "string") {
          throw new NotFoundException({ errors: ["transit/encrypt requires base64 `plaintext`"] });
        }
        const context = typeof body.context === "string" ? (body.context as string) : undefined;
        const ct = await transit.encrypt(keyName, base64ToBytes(plaintextB64), {
          contextBase64: context,
        });
        return { data: { ciphertext: ct.ciphertext, key_version: ct.keyVersion } };
      }
      if (relativePath.startsWith("decrypt/")) {
        const keyName = relativePath.slice("decrypt/".length);
        const ciphertext = body.ciphertext;
        if (typeof ciphertext !== "string") {
          throw new NotFoundException({ errors: ["transit/decrypt requires `ciphertext`"] });
        }
        const context = typeof body.context === "string" ? (body.context as string) : undefined;
        const pt = await transit.decrypt(keyName, ciphertext, { contextBase64: context });
        return { data: { plaintext: bytesToBase64(pt) } };
      }
      throw new NotFoundException({
        errors: [`unsupported transit path: ${relativePath}`],
      });
    }

    if (engine.type === "pki") {
      const pki = engine as PkiEngine;
      if (relativePath.startsWith("issue/")) {
        const role = relativePath.slice("issue/".length);
        const issued = await pki.issueCertificate(role, parsePkiIssueBody(body));
        return {
          data: {
            certificate: issued.certificate,
            issuing_ca: issued.issuingCa,
            ca_chain: issued.caChain,
            private_key: issued.privateKey,
            private_key_type: issued.privateKeyType,
            serial_number: issued.serialNumber,
            expiration: issued.expiration,
          },
        };
      }
      if (relativePath.startsWith("sign/")) {
        const role = relativePath.slice("sign/".length);
        const signed = await pki.signCsr(role, parsePkiSignBody(body));
        return {
          data: {
            certificate: signed.certificate,
            issuing_ca: signed.issuingCa,
            ca_chain: signed.caChain,
            serial_number: signed.serialNumber,
            expiration: signed.expiration,
          },
        };
      }
      if (relativePath === "revoke") {
        const serial = body.serial_number;
        if (typeof serial !== "string") {
          throw new NotFoundException({ errors: ["pki/revoke requires `serial_number`"] });
        }
        const r = await pki.revokeCertificate(serial);
        return { data: { revocation_time: r.revocationTime } };
      }
      throw new NotFoundException({ errors: [`unsupported PKI path: ${relativePath}`] });
    }

    throw new NotFoundException({
      errors: [`engine type ${engine.type} does not support POST at ${relativePath}`],
    });
  }

  /** KV soft-delete on `<mount>/data/<key>`. */
  async delete(requestPath: string): Promise<void> {
    const { engine, relativePath } = this.resolve(requestPath);
    if (engine.type === "kv-v2" && relativePath.startsWith("data/")) {
      await (engine as KvEngine).deleteLatest(relativePath.slice("data/".length));
      return;
    }
    throw new NotFoundException({
      errors: [`engine type ${engine.type} does not support DELETE at ${relativePath}`],
    });
  }

  /**
   * Map OpenBao HTTP errors back through Nest's exception model so the controller can
   * reuse {@link translateError} without leaking adapter internals into the route layer.
   */
  translateError(err: unknown): never {
    if (err instanceof OpenBaoError) {
      this.logger.warn(`openbao error ${err.status}: ${err.errors.join("; ")}`);
      throw new ServiceUnavailableException({ errors: err.errors, status: err.status });
    }
    throw err;
  }

  private resolve(requestPath: string): { engine: SecretsEngine; relativePath: string } {
    // No requireClient() — a plugin-mounted path is reachable without an OpenBao backend.
    // If the path doesn't resolve, 404 is the right error (not 503), regardless of whether
    // a backend is configured.
    const resolved = this.config.registry.resolve(requestPath);
    if (!resolved) {
      throw new NotFoundException({ errors: [`no mount at ${requestPath}`] });
    }
    const engine = this.config.enginesByMount.get(resolved.mount.path);
    if (!engine) {
      throw new NotFoundException({
        errors: [`engine not registered for mount ${resolved.mount.path}`],
      });
    }
    return { engine, relativePath: resolved.relativePath };
  }

  private requireClient(): OpenBaoClient {
    if (!this.config.client) {
      throw new ServiceUnavailableException({
        errors: [
          "Engine-A (OpenBao backend) is not configured. Set BAO_ADDR (and BAO_TOKEN " +
            "if your backend requires it) to enable /v1/* routes.",
        ],
        engine: "A",
        configured: false,
      });
    }
    return this.config.client;
  }
}

function isDynamicSecretsEngine(engine: SecretsEngine): engine is DynamicSecretsEngine {
  const probe = engine as Partial<DynamicSecretsEngine>;
  return typeof probe.issue === "function" && typeof probe.renew === "function";
}

/**
 * Vault's `lease_duration` is the seconds-until-expiry granted by the current operation —
 * not the original ttl. `LeaseManager.renew` advances `expiresAt` from now but keeps
 * `ttlSeconds` readonly, so derive the wire value from the expiry delta.
 */
function leaseDurationSeconds(lease: { expiresAt: number }): number {
  return Math.max(0, Math.floor((lease.expiresAt - Date.now()) / 1000));
}

function pickFirst(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function base64ToBytes(s: string): Uint8Array {
  const bin = Buffer.from(s, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
}

function parsePkiIssueBody(body: Record<string, unknown>): PkiIssueRequest {
  const cn = body.common_name;
  if (typeof cn !== "string" || cn.length === 0) {
    throw new NotFoundException({ errors: ["pki/issue requires `common_name`"] });
  }
  const req: PkiIssueRequest = { commonName: cn };
  setOptionalTtl(body.ttl, (s) => (req.ttlSeconds = s));
  setOptionalCsv(body.alt_names, (xs) => (req.altNames = xs));
  setOptionalCsv(body.ip_sans, (xs) => (req.ipSans = xs));
  setOptionalCsv(body.uri_sans, (xs) => (req.uriSans = xs));
  if (typeof body.exclude_cn_from_sans === "boolean") req.excludeCnFromSans = body.exclude_cn_from_sans;
  if (body.format === "pem" || body.format === "der" || body.format === "pem_bundle") {
    req.format = body.format;
  }
  return req;
}

function parsePkiSignBody(body: Record<string, unknown>): PkiSignRequest {
  const csr = body.csr;
  if (typeof csr !== "string" || csr.length === 0) {
    throw new NotFoundException({ errors: ["pki/sign requires `csr`"] });
  }
  const req: PkiSignRequest = { csr };
  if (typeof body.common_name === "string") req.commonName = body.common_name;
  setOptionalTtl(body.ttl, (s) => (req.ttlSeconds = s));
  setOptionalCsv(body.alt_names, (xs) => (req.altNames = xs));
  setOptionalCsv(body.ip_sans, (xs) => (req.ipSans = xs));
  setOptionalCsv(body.uri_sans, (xs) => (req.uriSans = xs));
  if (typeof body.exclude_cn_from_sans === "boolean") req.excludeCnFromSans = body.exclude_cn_from_sans;
  if (body.format === "pem" || body.format === "der" || body.format === "pem_bundle") {
    req.format = body.format;
  }
  return req;
}

/**
 * Vault TTL strings accept `"3600s"`, `"60m"`, `"24h"`, or a bare number-of-seconds string.
 * arc's contract is `ttlSeconds: number`; convert here so callers get the friendly form too.
 */
function setOptionalTtl(raw: unknown, set: (seconds: number) => void): void {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    set(raw);
    return;
  }
  if (typeof raw === "string" && raw.length > 0) {
    const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(raw.trim());
    if (m) {
      const n = Number(m[1]);
      const unit = (m[2] ?? "s").toLowerCase();
      const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
      set(n * mult);
    }
  }
}

function setOptionalCsv(raw: unknown, set: (parts: string[]) => void): void {
  if (typeof raw === "string" && raw.length > 0) {
    set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
  } else if (Array.isArray(raw)) {
    set(raw.filter((x): x is string => typeof x === "string"));
  }
}
