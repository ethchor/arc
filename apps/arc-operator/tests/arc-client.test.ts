import { describe, expect, it } from "vitest";
import { ArcClient } from "../src/arc-client";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(handler: (call: Recorded) => { status: number; body: unknown }) {
  const calls: Recorded[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: Recorded = {
      url,
      method: init?.method ?? "GET",
      headers,
      ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);
    const { status, body } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as Awaited<ReturnType<typeof fetch>>;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("ArcClient — login + token reuse", () => {
  it("logs in via the Kubernetes auth method using the SA token, caches the arc JWT, reuses it on subsequent calls", async () => {
    let nowMs = 1_000_000;
    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/v1/auth/kubernetes/login")) {
        return { status: 200, body: { data: { token: "arc-jwt-1", identityId: "system:sa:apps:op", policies: ["reader"], tokenTtlSeconds: 600 } } };
      }
      if (call.url.endsWith("/v1/secret/data/x")) return { status: 200, body: { data: { data: { k: "v" }, metadata: { version: 1 } } } };
      throw new Error(`unexpected url: ${call.url}`);
    });

    const client = new ArcClient({
      baseUrl: "http://arc:3001",
      authMount: "kubernetes",
      authRole: "operator",
      fetchFn,
      tokenSource: async () => "sa-token-1234",
      now: () => nowMs,
      refreshLeadSeconds: 60,
    });

    await client.kvGet("secret", "x");
    nowMs += 10_000;
    await client.kvGet("secret", "x");

    const loginCalls = calls.filter((c) => c.url.endsWith("/v1/auth/kubernetes/login"));
    expect(loginCalls.length).toBe(1);
    expect(loginCalls[0]?.body).toEqual({ role: "operator", jwt: "sa-token-1234" });

    const kvCalls = calls.filter((c) => c.url.endsWith("/v1/secret/data/x"));
    expect(kvCalls.length).toBe(2);
    expect(kvCalls[0]?.headers.authorization).toBe("Bearer arc-jwt-1");
    expect(kvCalls[1]?.headers.authorization).toBe("Bearer arc-jwt-1");
  });

  it("re-logs in when the cached token is within the refresh lead window of expiry", async () => {
    let nowMs = 1_000_000;
    let issued = 0;
    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/v1/auth/kubernetes/login")) {
        issued++;
        return { status: 200, body: { data: { token: `jwt-${issued}`, identityId: "x", policies: [], tokenTtlSeconds: 600 } } };
      }
      return { status: 200, body: { data: { data: {}, metadata: { version: 1 } } } };
    });
    const client = new ArcClient({
      baseUrl: "http://arc:3001",
      authMount: "kubernetes",
      authRole: "op",
      fetchFn,
      tokenSource: async () => "sa",
      now: () => nowMs,
      refreshLeadSeconds: 60,
    });

    await client.kvGet("secret", "x"); // login #1
    nowMs += (600 - 30) * 1000; // jump forward to inside the 60s refresh lead
    await client.kvGet("secret", "x"); // forces login #2
    expect(calls.filter((c) => c.url.endsWith("/v1/auth/kubernetes/login")).length).toBe(2);
  });

  it("on a 401 from a downstream call, drops the cached token and retries the request once", async () => {
    let nowMs = 1_000_000;
    let issued = 0;
    let kvHit = 0;
    const { fetchFn, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/v1/auth/kubernetes/login")) {
        issued++;
        return { status: 200, body: { data: { token: `jwt-${issued}`, identityId: "x", policies: [], tokenTtlSeconds: 600 } } };
      }
      kvHit++;
      if (kvHit === 1) return { status: 401, body: { errors: ["token revoked"] } };
      return { status: 200, body: { data: { data: { k: "v" }, metadata: { version: 1 } } } };
    });
    const client = new ArcClient({
      baseUrl: "http://arc:3001",
      authMount: "kubernetes",
      authRole: "op",
      fetchFn,
      tokenSource: async () => "sa",
      now: () => nowMs,
      refreshLeadSeconds: 60,
    });

    const res = await client.kvGet("secret", "x");
    expect(res.data.data).toEqual({ k: "v" });
    expect(issued).toBe(2); // initial login + re-login after 401
    expect(calls.filter((c) => c.url.endsWith("/v1/secret/data/x")).length).toBe(2);
  });

  it("propagates a 403 verbatim without retrying (policy denial is permanent)", async () => {
    const { fetchFn } = fakeFetch((call) => {
      if (call.url.endsWith("/v1/auth/kubernetes/login")) {
        return { status: 200, body: { data: { token: "jwt", identityId: "x", policies: [], tokenTtlSeconds: 600 } } };
      }
      return { status: 403, body: { errors: ["forbidden by policy"] } };
    });
    const client = new ArcClient({
      baseUrl: "http://arc:3001",
      authMount: "kubernetes",
      authRole: "op",
      fetchFn,
      tokenSource: async () => "sa",
    });
    await expect(client.kvGet("secret", "x")).rejects.toThrow(/403/);
  });
});
