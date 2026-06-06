/**
 * Hermetic unit tests for {@link OpenBaoKvEngine} — no live OpenBao required (the suite in
 * `integration.test.ts` covers the real server when BAO_ADDR is set). A fake {@link FetchLike}
 * routes by method + path so we can assert the KV v2 wire layout, and in particular the
 * soft-delete behaviour: reading a deleted version's data 404s, so the engine falls back to the
 * `metadata/` endpoint to report `deleted: true` instead of throwing.
 */
import { describe, expect, it } from "vitest";
import { OpenBaoClient, OpenBaoError, type FetchInit, type FetchLike, type FetchResponseLike } from "../src/client";
import { OpenBaoKvEngine } from "../src/kv-engine";

function reply(status: number, body: unknown): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

function engine(fetchFn: FetchLike, mount = "secret"): OpenBaoKvEngine {
  return new OpenBaoKvEngine(new OpenBaoClient({ addr: "http://bao.test", token: "root", fetchFn }), mount);
}

describe("OpenBaoKvEngine.get — active version", () => {
  it("maps the KV v2 data + metadata payload onto KvReadResult", async () => {
    const fetchFn: FetchLike = async (url, init) => {
      expect(init?.method).toBe("GET");
      expect(url).toBe("http://bao.test/v1/secret/data/app/key");
      return reply(200, {
        data: {
          data: { apiKey: "sk-1" },
          metadata: { version: 3, created_time: "2026-01-01T00:00:00Z", deletion_time: "", destroyed: false },
        },
      });
    };
    const out = await engine(fetchFn).get("app/key");
    expect(out.data).toEqual({ apiKey: "sk-1" });
    expect(out.metadata).toEqual({ version: 3, createdTime: "2026-01-01T00:00:00Z", deleted: false, destroyed: false });
  });

  it("threads an explicit version through as ?version=", async () => {
    const fetchFn: FetchLike = async (url) => {
      expect(url).toBe("http://bao.test/v1/secret/data/app/key?version=2");
      return reply(200, { data: { data: {}, metadata: { version: 2, created_time: "T", deletion_time: "", destroyed: false } } });
    };
    const out = await engine(fetchFn).get("app/key", 2);
    expect(out.metadata.version).toBe(2);
  });
});

describe("OpenBaoKvEngine.get — soft-deleted / destroyed version (404 on data)", () => {
  // After a soft-delete, GET <mount>/data/<path> returns 404 but the metadata endpoint still
  // has the version with a non-empty deletion_time.
  function routes(metadataBody: unknown): FetchLike {
    return async (url, init) => {
      if (url.includes("/secret/data/")) return reply(404, { errors: [] });
      if (url.includes("/secret/metadata/")) {
        expect(init?.method).toBe("GET"); // metadata READ, not LIST
        return reply(200, metadataBody);
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    };
  }

  it("falls back to metadata and reports deleted: true", async () => {
    const fetchFn = routes({
      data: { current_version: 2, versions: { "2": { created_time: "T2", deletion_time: "2026-02-02T00:00:00Z", destroyed: false } } },
    });
    const out = await engine(fetchFn).get("app/key");
    expect(out.data).toEqual({});
    expect(out.metadata).toEqual({ version: 2, createdTime: "T2", deleted: true, destroyed: false });
  });

  it("reports destroyed: true for a destroyed version", async () => {
    const fetchFn = routes({
      data: { current_version: 1, versions: { "1": { created_time: "T1", deletion_time: "", destroyed: true } } },
    });
    const out = await engine(fetchFn).get("app/key");
    expect(out.metadata.destroyed).toBe(true);
    expect(out.metadata.deleted).toBe(false);
  });

  it("honours an explicit version when reading deleted metadata", async () => {
    const fetchFn = routes({
      data: {
        current_version: 5,
        versions: { "3": { created_time: "T3", deletion_time: "2026-03-03T00:00:00Z", destroyed: false } },
      },
    });
    const out = await engine(fetchFn).get("app/key", 3);
    expect(out.metadata.version).toBe(3);
    expect(out.metadata.deleted).toBe(true);
  });
});

describe("OpenBaoKvEngine.get — genuine not-found", () => {
  it("re-throws the original 404 when the path has no metadata either", async () => {
    const fetchFn: FetchLike = async () => reply(404, { errors: [] });
    await expect(engine(fetchFn).get("missing")).rejects.toBeInstanceOf(OpenBaoError);
    await expect(engine(fetchFn).get("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("re-throws when the metadata exists but lacks the requested version", async () => {
    const fetchFn: FetchLike = async (url) => {
      if (url.includes("/secret/data/")) return reply(404, { errors: [] });
      return reply(200, { data: { current_version: 1, versions: { "1": { created_time: "T", deletion_time: "", destroyed: false } } } });
    };
    // Asking for v9 which the metadata doesn't list → null → original 404 surfaces.
    await expect(engine(fetchFn).get("app/key", 9)).rejects.toMatchObject({ status: 404 });
  });

  it("does not swallow non-404 errors (e.g. 403 permission denied)", async () => {
    const fetchFn: FetchLike = async () => reply(403, { errors: ["permission denied"] });
    await expect(engine(fetchFn).get("app/key")).rejects.toMatchObject({ status: 403 });
  });
});

describe("OpenBaoKvEngine.put", () => {
  it("POSTs { data } to <mount>/data/<path> and returns the new version", async () => {
    let captured: { url: string; init?: FetchInit } | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      captured = { url, init };
      return reply(200, { data: { version: 7, created_time: "T7" } });
    };
    const out = await engine(fetchFn).put("app/key", { apiKey: "sk-2" });
    expect(out).toEqual({ version: 7, createdTime: "T7" });
    expect(captured?.url).toBe("http://bao.test/v1/secret/data/app/key");
    expect(captured?.init?.method).toBe("POST");
    expect(JSON.parse(captured?.init?.body ?? "{}")).toEqual({ data: { apiKey: "sk-2" } });
  });

  it("passes a CAS guard through as options.cas", async () => {
    let body: string | undefined;
    const fetchFn: FetchLike = async (_url, init) => {
      body = init?.body;
      return reply(200, { data: { version: 1, created_time: "T" } });
    };
    await engine(fetchFn).put("app/key", { a: 1 }, { cas: 0 });
    expect(JSON.parse(body ?? "{}")).toEqual({ data: { a: 1 }, options: { cas: 0 } });
  });
});

describe("OpenBaoKvEngine.list + deleteLatest", () => {
  it("LISTs <mount>/metadata/<prefix> and returns the keys array", async () => {
    const fetchFn: FetchLike = async (url, init) => {
      expect(init?.method).toBe("LIST");
      expect(url).toBe("http://bao.test/v1/secret/metadata/app");
      return reply(200, { data: { keys: ["key", "other"] } });
    };
    expect(await engine(fetchFn).list("app")).toEqual(["key", "other"]);
  });

  it("soft-deletes via DELETE <mount>/data/<path>", async () => {
    let captured: { url: string; method?: string } | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      captured = { url, method: init?.method };
      return reply(204, undefined);
    };
    await engine(fetchFn).deleteLatest("app/key");
    expect(captured).toEqual({ url: "http://bao.test/v1/secret/data/app/key", method: "DELETE" });
  });
});
