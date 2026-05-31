import { describe, expect, it, vi } from "vitest";
import { OpenBaoClient, OpenBaoError, OpenBaoKvEngine } from "../src/index";
import type { FetchInit } from "../src/index";

function fakeFetch(handler: (url: string, init: FetchInit) => { status: number; body?: unknown }) {
  return vi.fn(async (url: string, init?: FetchInit) => {
    const { status, body } = handler(url, init ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    };
  });
}

describe("OpenBaoClient", () => {
  it("performs the seal-status (bao status) round-trip", async () => {
    const fetchFn = fakeFetch((url) => {
      expect(url).toBe("http://bao:8200/v1/sys/seal-status");
      return {
        status: 200,
        body: { type: "shamir", initialized: true, sealed: false, version: "2.0.0", t: 1, n: 1 },
      };
    });
    const client = new OpenBaoClient({ addr: "http://bao:8200/", token: "root", fetchFn });
    const status = await client.sealStatus();
    expect(status.sealed).toBe(false);
    expect(status.initialized).toBe(true);
    expect(status.version).toBe("2.0.0");
    expect(fetchFn).toHaveBeenCalledWith(
      "http://bao:8200/v1/sys/seal-status",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws OpenBaoError on a non-2xx response carrying errors[]", async () => {
    const fetchFn = fakeFetch(() => ({ status: 403, body: { errors: ["permission denied"] } }));
    const client = new OpenBaoClient({ addr: "http://bao:8200", token: "bad", fetchFn });
    await expect(client.read("secret/data/x")).rejects.toThrowError(OpenBaoError);
  });
});

describe("OpenBaoKvEngine", () => {
  it("sends the token header and maps a KV v2 read", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/secret/data/app/config");
      seenHeaders = init.headers ?? {};
      return {
        status: 200,
        body: {
          data: {
            data: { apiKey: "xyz" },
            metadata: { version: 3, created_time: "2026-01-01T00:00:00Z", destroyed: false },
          },
        },
      };
    });
    const client = new OpenBaoClient({ addr: "http://bao:8200", token: "s.abc", fetchFn });
    const kv = new OpenBaoKvEngine(client, "secret");
    const read = await kv.get("app/config");
    expect(seenHeaders["X-Vault-Token"]).toBe("s.abc");
    expect(read.data).toEqual({ apiKey: "xyz" });
    expect(read.metadata.version).toBe(3);
    expect(read.metadata.destroyed).toBe(false);
  });

  it("writes to the data path and returns the new version", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/secret/data/app/config");
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ data: { apiKey: "new" } }));
      return { status: 200, body: { data: { version: 4, created_time: "2026-02-02T00:00:00Z" } } };
    });
    const kv = new OpenBaoKvEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }), "secret/");
    const res = await kv.put("app/config", { apiKey: "new" });
    expect(res.version).toBe(4);
  });

  it("lists keys from the metadata path", async () => {
    const fetchFn = fakeFetch((url) => {
      expect(url).toBe("http://bao:8200/v1/secret/metadata/app");
      return { status: 200, body: { data: { keys: ["config", "db/"] } } };
    });
    const kv = new OpenBaoKvEngine(new OpenBaoClient({ addr: "http://bao:8200", fetchFn }), "secret");
    expect(await kv.list("app")).toEqual(["config", "db/"]);
  });
});
