import { normalizeMount } from "@arc-vault/leasing";
import type { KvEngine, KvReadResult, KvWriteResult } from "@arc-vault/secrets-engine";
import type { OpenBaoClient } from "./client";

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
    const res = await this.client.read(`${this.mount}data/${strip(path)}${query}`);
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
}
