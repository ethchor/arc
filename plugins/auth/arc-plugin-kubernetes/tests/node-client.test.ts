import { describe, expect, it } from "vitest";
import { createNodeTokenReviewer } from "../src/node-client";

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("createNodeTokenReviewer", () => {
  it("POSTs a TokenReview to the right URL with the reviewer bearer and parses the user", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({
      status: 201,
      body: {
        status: {
          authenticated: true,
          user: { username: "system:serviceaccount:apps:deployer", uid: "u1", groups: ["system:serviceaccounts"] },
        },
      },
    }));
    const reviewer = createNodeTokenReviewer({ host: "https://kubernetes.default.svc/", reviewerJwt: "reviewer-token", fetchFn });

    const result = await reviewer.review("sa-token", ["arc"]);

    expect(calls[0]?.url).toBe("https://kubernetes.default.svc/apis/authentication.k8s.io/v1/tokenreviews");
    const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer reviewer-token");
    expect(JSON.parse(String(init.body))).toEqual({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: { token: "sa-token", audiences: ["arc"] },
    });
    expect(result).toEqual({
      authenticated: true,
      username: "system:serviceaccount:apps:deployer",
      uid: "u1",
      groups: ["system:serviceaccounts"],
    });
  });

  it("omits audiences from the spec when none are given", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 201, body: { status: { authenticated: false, error: "nope" } } }));
    const reviewer = createNodeTokenReviewer({ host: "https://k8s", reviewerJwt: "r", fetchFn });
    const result = await reviewer.review("t");
    expect(JSON.parse(String((calls[0]?.init as RequestInit).body)).spec).toEqual({ token: "t" });
    expect(result).toEqual({ authenticated: false, error: "nope" });
  });

  it("throws on a non-2xx response from the API server", async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 403, body: { message: "forbidden" } }));
    const reviewer = createNodeTokenReviewer({ host: "https://k8s", reviewerJwt: "r", fetchFn });
    await expect(reviewer.review("t")).rejects.toThrow(/TokenReview failed \(403\)/);
  });
});
