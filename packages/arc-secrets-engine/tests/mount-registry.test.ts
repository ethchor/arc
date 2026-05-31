import { describe, expect, it } from "vitest";
import { MountRegistry } from "../src/index";

describe("MountRegistry", () => {
  it("normalizes paths on mount", () => {
    const r = new MountRegistry();
    const m = r.mount({ path: "/secret", type: "kv-v2" });
    expect(m.path).toBe("secret/");
    expect(r.get("secret")).toBeDefined();
  });

  it("rejects duplicate mounts", () => {
    const r = new MountRegistry();
    r.mount({ path: "secret", type: "kv-v2" });
    expect(() => r.mount({ path: "secret/", type: "kv-v2" })).toThrowError(/already mounted/);
  });

  it("routes by longest-prefix match", () => {
    const r = new MountRegistry();
    r.mount({ path: "database/", type: "database" });
    r.mount({ path: "database/pg/", type: "database" });
    const hit = r.resolve("database/pg/creds/app");
    expect(hit?.mount.path).toBe("database/pg/");
    expect(hit?.relativePath).toBe("creds/app");
  });

  it("does not match on partial path segments", () => {
    const r = new MountRegistry();
    r.mount({ path: "data/", type: "kv-v2" });
    expect(r.resolve("database/x")).toBeUndefined();
  });

  it("resolves a bare mount point with empty relative path", () => {
    const r = new MountRegistry();
    r.mount({ path: "transit/", type: "transit" });
    const hit = r.resolve("transit");
    expect(hit?.mount.path).toBe("transit/");
    expect(hit?.relativePath).toBe("");
  });

  it("unmounts", () => {
    const r = new MountRegistry();
    r.mount({ path: "kv/", type: "kv-v2" });
    expect(r.unmount("kv")).toBe(true);
    expect(r.list()).toHaveLength(0);
  });
});
