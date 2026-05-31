import { normalizeMount } from "@arc/leasing";
import type { MountConfig } from "./types";

export interface ResolvedMount {
  mount: MountConfig;
  /** The request path with the mount prefix stripped (e.g. "creds/app"). */
  relativePath: string;
}

/**
 * Tracks mounted engines and routes request paths to them. Mirrors Vault's mount system: every
 * engine lives at a path, and a request is dispatched to the mount with the longest matching
 * path prefix.
 */
export class MountRegistry {
  private readonly mounts = new Map<string, MountConfig>();

  mount(config: MountConfig): MountConfig {
    const path = normalizeMount(config.path);
    if (path === "") throw new Error("mount path must be non-empty");
    if (this.mounts.has(path)) throw new Error(`already mounted at ${path}`);
    const normalized: MountConfig = { ...config, path };
    this.mounts.set(path, normalized);
    return normalized;
  }

  unmount(path: string): boolean {
    return this.mounts.delete(normalizeMount(path));
  }

  get(path: string): MountConfig | undefined {
    return this.mounts.get(normalizeMount(path));
  }

  list(): MountConfig[] {
    return [...this.mounts.values()];
  }

  /**
   * Route a request path to its mount by longest-prefix match. The trailing slash on each
   * normalized mount path means "data/" never spuriously matches "database/x".
   */
  resolve(requestPath: string): ResolvedMount | undefined {
    const path = requestPath.trim().replace(/^\/+/, "");
    const probe = `${path}/`;
    let best: MountConfig | undefined;
    for (const candidate of this.mounts.values()) {
      if (probe.startsWith(candidate.path)) {
        if (!best || candidate.path.length > best.path.length) best = candidate;
      }
    }
    if (!best) return undefined;
    const relativePath = path.length > best.path.length ? path.slice(best.path.length) : "";
    return { mount: best, relativePath };
  }
}
