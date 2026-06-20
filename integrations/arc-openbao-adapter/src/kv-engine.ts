import { normalizeMount } from "@arc/leasing";
import type {
  KvEngine,
  KvFullMetadata,
  KvReadResult,
  KvVersionInfo,
  KvWriteResult,
} from "@arc/secrets-engine";
import { OpenBaoError } from "./client";
import type { OpenBaoClient, OpenBaoResponse } from "./client";

const strip = (path: string): string => path.replace(/^\/+/, "");

/**
 * KV v2 engine backed by OpenBao. Maps arc's clean {@link KvEngine} contract onto OpenBao's
 * `<mount>/data/<path>` and `<mount>/metadata/<path>` HTTP layout.
 */
export class OpenBaoKvEngine implements KvEngine {
  readonly type = "kv-v2" as const;
  readonly mount: string;

  constructor(
    private readonly client: OpenBaoClient,
    mount: string,
  ) {
    this.mount = normalizeMount(mount);
  }

  async get(path: string, version?: number): Promise<KvReadResult> {
    const query = version === undefined ? "" : `?version=${version}`;
    let res: OpenBaoResponse;
    try {
      res = await this.client.read(`${this.mount}data/${strip(path)}${query}`);
    } catch (err) {
      // In KV v2, reading a version whose data has been soft-deleted (or destroyed)
      // returns 404: the payload is gone but the version's metadata survives. arc's
      // contract still wants to surface `deleted`/`destroyed`, so fall back to the
      // metadata endpoint to tell "deleted" apart from "never existed".
      if (err instanceof OpenBaoError && err.status === 404) {
        const fromMeta = await this.readVersionMetadata(path, version);
        if (fromMeta) return fromMeta;
      }
      throw err;
    }
    const payload = (res.data ?? {}) as {
      data?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
    const meta = payload.metadata ?? {};
    return {
      data: payload.data ?? {},
      metadata: {
        version: Number(meta.version ?? 0),
        createdTime: String(meta.created_time ?? ""),
        deleted: typeof meta.deletion_time === "string" && meta.deletion_time !== "",
        destroyed: Boolean(meta.destroyed),
      },
    };
  }

  /**
   * Recovers a soft-deleted (or destroyed) version's metadata from `<mount>/metadata/<path>`,
   * which outlives the data payload. Returns null when there is no metadata for the requested
   * version at all (a genuine not-found) so {@link get} re-throws the original 404.
   */
  private async readVersionMetadata(path: string, version?: number): Promise<KvReadResult | null> {
    let res: OpenBaoResponse;
    try {
      res = await this.client.read(`${this.mount}metadata/${strip(path)}`);
    } catch (err) {
      if (err instanceof OpenBaoError && err.status === 404) return null;
      throw err;
    }
    const data = (res.data ?? {}) as {
      current_version?: number;
      versions?: Record<string, { created_time?: string; deletion_time?: string; destroyed?: boolean }>;
    };
    const target = version ?? Number(data.current_version ?? 0);
    const record = data.versions?.[String(target)];
    if (!record) return null;
    return {
      data: {},
      metadata: {
        version: target,
        createdTime: String(record.created_time ?? ""),
        deleted: typeof record.deletion_time === "string" && record.deletion_time !== "",
        destroyed: Boolean(record.destroyed),
      },
    };
  }

  async put(
    path: string,
    data: Record<string, unknown>,
    opts?: { cas?: number },
  ): Promise<KvWriteResult> {
    const body: Record<string, unknown> = { data };
    if (opts?.cas !== undefined) body.options = { cas: opts.cas };
    const res = await this.client.write(`${this.mount}data/${strip(path)}`, body);
    const meta = (res.data ?? {}) as Record<string, unknown>;
    return { version: Number(meta.version ?? 0), createdTime: String(meta.created_time ?? "") };
  }

  async deleteLatest(path: string): Promise<void> {
    await this.client.delete(`${this.mount}data/${strip(path)}`);
  }

  async list(prefix: string): Promise<string[]> {
    const res = await this.client.list(`${this.mount}metadata/${strip(prefix)}`);
    const keys = (res.data as { keys?: unknown } | undefined)?.keys;
    return Array.isArray(keys) ? (keys as string[]) : [];
  }

  /**
   * Full version timeline at `<mount>/metadata/<path>`. KV v2 returns `versions` as a map
   * keyed by stringified version number; we flatten it into a descending-by-version array
   * for client convenience. Empty `deletion_time` is normalised to `undefined` so callers
   * can treat the field as a "is soft-deleted?" predicate by presence.
   */
  async readMetadata(path: string): Promise<KvFullMetadata> {
    const res = await this.client.read(`${this.mount}metadata/${strip(path)}`);
    const data = (res.data ?? {}) as {
      current_version?: number;
      max_versions?: number;
      cas_required?: boolean;
      custom_metadata?: Record<string, string> | null;
      created_time?: string;
      updated_time?: string;
      versions?: Record<string, { created_time?: string; deletion_time?: string; destroyed?: boolean }>;
    };
    const versions: KvVersionInfo[] = Object.entries(data.versions ?? {})
      .map(([k, v]) => {
        const info: KvVersionInfo = {
          version: Number(k),
          createdTime: String(v.created_time ?? ""),
          destroyed: Boolean(v.destroyed),
        };
        if (typeof v.deletion_time === "string" && v.deletion_time.length > 0) {
          info.deletionTime = v.deletion_time;
        }
        return info;
      })
      .sort((a, b) => b.version - a.version);
    return {
      currentVersion: Number(data.current_version ?? 0),
      maxVersions: Number(data.max_versions ?? 0),
      casRequired: Boolean(data.cas_required),
      customMetadata: { ...(data.custom_metadata ?? {}) },
      createdTime: String(data.created_time ?? ""),
      updatedTime: String(data.updated_time ?? ""),
      versions,
    };
  }

  /** Soft-delete one or more specific versions via `POST <mount>/delete/<path> { versions }`. */
  async deleteVersions(path: string, versions: readonly number[]): Promise<void> {
    if (versions.length === 0) return;
    await this.client.write(`${this.mount}delete/${strip(path)}`, { versions: [...versions] });
  }

  /** Restore soft-deleted versions via `POST <mount>/undelete/<path> { versions }`. */
  async undeleteVersions(path: string, versions: readonly number[]): Promise<void> {
    if (versions.length === 0) return;
    await this.client.write(`${this.mount}undelete/${strip(path)}`, { versions: [...versions] });
  }

  /** Permanently destroy versions' data via `POST <mount>/destroy/<path> { versions }`. */
  async destroyVersions(path: string, versions: readonly number[]): Promise<void> {
    if (versions.length === 0) return;
    await this.client.write(`${this.mount}destroy/${strip(path)}`, { versions: [...versions] });
  }
}
