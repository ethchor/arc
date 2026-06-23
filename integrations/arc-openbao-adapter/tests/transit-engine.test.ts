import { describe, expect, it, vi } from "vitest";
import { OpenBaoClient, OpenBaoTransitEngine, TransitProtocolError } from "../src/index";
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

describe("OpenBaoTransitEngine", () => {
  it("createKey posts the canonical type/exportable body to keys/<name>", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/transit/keys/app-data");
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ type: "aes256-gcm96", exportable: false }));
      return { status: 204 };
    });
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    await engine.createKey("app-data");
  });

  it("encrypt base64-encodes plaintext + parses the key version out of vault:vN:...", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/transit/encrypt/app-data");
      const body = JSON.parse(init.body ?? "{}") as { plaintext: string };
      expect(body.plaintext).toBe("aGVsbG8="); // base64 of "hello"
      return { status: 200, body: { data: { ciphertext: "vault:v3:abcdef" } } };
    });
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    const ct = await engine.encrypt("app-data", new TextEncoder().encode("hello"));
    expect(ct.ciphertext).toBe("vault:v3:abcdef");
    expect(ct.keyVersion).toBe(3);
  });

  it("decrypt base64-decodes the response plaintext into a Uint8Array", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/transit/decrypt/app-data");
      const body = JSON.parse(init.body ?? "{}") as { ciphertext: string };
      expect(body.ciphertext).toBe("vault:v1:opaque");
      return { status: 200, body: { data: { plaintext: "aGVsbG8=" } } };
    });
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    const pt = await engine.decrypt("app-data", "vault:v1:opaque");
    expect(new TextDecoder().decode(pt)).toBe("hello");
  });

  it("rotateKey triggers /rotate then reads the latest_version", async () => {
    let calls = 0;
    const fetchFn = fakeFetch((url, init) => {
      calls++;
      if (calls === 1) {
        expect(url).toBe("http://bao:8200/v1/transit/keys/app-data/rotate");
        expect(init.method).toBe("POST");
        return { status: 204 };
      }
      expect(url).toBe("http://bao:8200/v1/transit/keys/app-data");
      expect(init.method).toBe("GET");
      return { status: 200, body: { data: { latest_version: 7 } } };
    });
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    const { latestVersion } = await engine.rotateKey("app-data");
    expect(latestVersion).toBe(7);
    expect(calls).toBe(2);
  });

  it("threads `context` through to encrypt + decrypt when supplied", async () => {
    const fetchFn = fakeFetch((url, init) => {
      const body = JSON.parse(init.body ?? "{}") as Record<string, string>;
      expect(body.context).toBe("Y3R4"); // base64 of "ctx"
      if (url.includes("/encrypt/")) {
        return { status: 200, body: { data: { ciphertext: "vault:v1:cc" } } };
      }
      return { status: 200, body: { data: { plaintext: "aGVsbG8=" } } };
    });
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    await engine.encrypt("app-data", new TextEncoder().encode("hello"), { contextBase64: "Y3R4" });
    await engine.decrypt("app-data", "vault:v1:cc", { contextBase64: "Y3R4" });
  });

  it("encrypt throws TransitProtocolError on a malformed response", async () => {
    const fetchFn = fakeFetch(() => ({ status: 200, body: { data: { notCiphertext: "oops" } } }));
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    await expect(
      engine.encrypt("app-data", new TextEncoder().encode("hello")),
    ).rejects.toThrow(TransitProtocolError);
  });

  it("encrypt rejects a returned ciphertext that doesn't carry a vault:vN: prefix", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 200,
      body: { data: { ciphertext: "totally:not:transit" } },
    }));
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    await expect(
      engine.encrypt("app-data", new TextEncoder().encode("hello")),
    ).rejects.toThrow(TransitProtocolError);
  });

  it("listKeys LISTs <mount>/keys and returns the array", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/transit/keys");
      expect(init.method).toBe("LIST");
      return { status: 200, body: { data: { keys: ["app", "billing", "ml-1"] } } };
    });
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    expect(await engine.listKeys()).toEqual(["app", "billing", "ml-1"]);
  });

  it("listKeys treats a 404 (empty mount) as an empty array, not an error", async () => {
    const fetchFn = fakeFetch(() => ({ status: 404, body: { errors: [] } }));
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    expect(await engine.listKeys()).toEqual([]);
  });

  it("readKey GETs <mount>/keys/<name> and normalises the response fields", async () => {
    const fetchFn = fakeFetch((url, init) => {
      expect(url).toBe("http://bao:8200/v1/transit/keys/app");
      expect(init.method).toBe("GET");
      return {
        status: 200,
        body: {
          data: {
            name: "app",
            type: "aes256-gcm96",
            latest_version: 3,
            min_decryption_version: 1,
            min_encryption_version: 0,
            deletion_allowed: false,
            exportable: false,
            supports_derivation: false,
            keys: {
              "1": "2026-01-01T00:00:00Z",
              "2": "2026-03-01T00:00:00Z",
              "3": "2026-06-01T00:00:00Z",
            },
          },
        },
      };
    });
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    const info = await engine.readKey("app");
    expect(info.name).toBe("app");
    expect(info.type).toBe("aes256-gcm96");
    expect(info.latestVersion).toBe(3);
    expect(info.minDecryptionVersion).toBe(1);
    expect(info.minEncryptionVersion).toBe(0);
    expect(info.deletionAllowed).toBe(false);
    expect(info.exportable).toBe(false);
    expect(info.supportsDerivation).toBe(false);
    expect(info.versionCreatedAt?.["3"]).toBe("2026-06-01T00:00:00Z");
  });

  it("readKey converts numeric epoch-seconds version creation times to ISO strings", async () => {
    const fetchFn = fakeFetch(() => ({
      status: 200,
      body: {
        data: {
          name: "raw",
          type: "aes256-gcm96",
          latest_version: 1,
          min_decryption_version: 0,
          min_encryption_version: 0,
          deletion_allowed: false,
          exportable: false,
          keys: { "1": 1_730_000_000 },
        },
      },
    }));
    const engine = new OpenBaoTransitEngine(
      new OpenBaoClient({ addr: "http://bao:8200", token: "root", fetchFn }),
    );
    const info = await engine.readKey("raw");
    expect(info.versionCreatedAt?.["1"]).toBe(new Date(1_730_000_000 * 1000).toISOString());
  });
});
