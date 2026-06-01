import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  MountRegistry,
  type KvEngine,
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

  async listMounts(): Promise<Array<{ path: string; type: string; description?: string }>> {
    this.requireClient();
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
    throw new NotFoundException({
      errors: [`engine type ${engine.type} does not support GET at ${relativePath}`],
    });
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
    this.requireClient();
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
