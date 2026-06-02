/**
 * Tests the Node-builtin GitHubAppClient: RS256 JWT signing + the REST request shape +
 * response parsing. fetch is mocked so we never hit the network. The private key is a
 * fresh RSA-2048 generated once per test file.
 */
import { generateKeyPairSync, createVerify } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createNodeGitHubClient } from "../src/node-client";
import type { CreateInstallationTokenInput } from "../src/types";

let privateKeyPem: string;
let publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];

beforeAll(() => {
  const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKey = kp.publicKey;
});

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer } {
  const parts = jwt.split(".");
  expect(parts).toHaveLength(3);
  const [headerB64, payloadB64, sigB64] = parts;
  const fromB64Url = (s: string) =>
    Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return {
    header: JSON.parse(fromB64Url(headerB64!).toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(fromB64Url(payloadB64!).toString("utf8")) as Record<string, unknown>,
    signingInput: `${headerB64}.${payloadB64}`,
    signature: fromB64Url(sigB64!),
  };
}

describe("createNodeGitHubClient — JWT signing", () => {
  it("mints an RS256 JWT with iss=appId, sane iat/exp, and a valid signature", async () => {
    const fetchFn = vi.fn(async (_url: unknown, init: { headers: Record<string, string> }) => {
      const jwt = init.headers["Authorization"]!.replace(/^Bearer /, "");
      const { header, payload, signingInput, signature } = decodeJwt(jwt);
      expect(header.alg).toBe("RS256");
      expect(header.typ).toBe("JWT");
      expect(payload.iss).toBe(42);
      const iat = payload.iat as number;
      const exp = payload.exp as number;
      const now = Math.floor(Date.now() / 1000);
      expect(iat).toBeLessThanOrEqual(now); // backdated
      expect(iat).toBeGreaterThan(now - 120); // not too far back
      expect(exp - iat).toBeLessThanOrEqual(600); // within GitHub's 10-min cap

      const verifier = createVerify("RSA-SHA256");
      verifier.update(signingInput);
      verifier.end();
      expect(verifier.verify(publicKey, signature)).toBe(true);

      return new Response(
        JSON.stringify({
          token: "ghs_xyz",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { contents: "read" },
          repository_selection: "all",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createNodeGitHubClient({
      appId: 42,
      privateKeyPem,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const out = await client.createInstallationToken({ installationId: 99 });
    expect(out.token).toBe("ghs_xyz");
    expect(out.expirationSeconds).toBeGreaterThan(3500);
    expect(out.expirationSeconds).toBeLessThanOrEqual(3600);
    expect(out.permissions).toEqual({ contents: "read" });
    expect(out.repositorySelection).toBe("all");
  });
});

describe("createNodeGitHubClient — request shape", () => {
  function captureFetch(response: () => Response) {
    const captured = { url: "", body: undefined as unknown };
    const fetchFn = vi.fn(async (url: unknown, init: { body?: string }) => {
      captured.url = String(url);
      captured.body = init.body ? JSON.parse(init.body) : undefined;
      return response();
    });
    return { fetchFn: fetchFn as unknown as typeof fetch, captured };
  }

  const okResponse = () =>
    new Response(
      JSON.stringify({
        token: "t",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );

  it("targets /app/installations/<id>/access_tokens on the default api.github.com base", async () => {
    const { fetchFn, captured } = captureFetch(okResponse);
    const client = createNodeGitHubClient({ appId: 1, privateKeyPem, fetchFn });
    await client.createInstallationToken({ installationId: 555 });
    expect(captured.url).toBe("https://api.github.com/app/installations/555/access_tokens");
  });

  it("honors apiBaseUrl for GHES", async () => {
    const { fetchFn, captured } = captureFetch(okResponse);
    const client = createNodeGitHubClient({
      appId: 1,
      privateKeyPem,
      apiBaseUrl: "https://ghes.example.com/api/v3/",
      fetchFn,
    });
    await client.createInstallationToken({ installationId: 7 });
    expect(captured.url).toBe("https://ghes.example.com/api/v3/app/installations/7/access_tokens");
  });

  it("sends repositories + permissions in the JSON body when provided", async () => {
    const { fetchFn, captured } = captureFetch(okResponse);
    const client = createNodeGitHubClient({ appId: 1, privateKeyPem, fetchFn });
    await client.createInstallationToken({
      installationId: 1,
      repositories: ["acme/api"],
      permissions: { contents: "write" },
    });
    expect(captured.body).toEqual({
      repositories: ["acme/api"],
      permissions: { contents: "write" },
    });
  });

  it("sends repository_ids as snake_case when given (GitHub's wire format)", async () => {
    const { fetchFn, captured } = captureFetch(okResponse);
    const client = createNodeGitHubClient({ appId: 1, privateKeyPem, fetchFn });
    await client.createInstallationToken({ installationId: 1, repositoryIds: [10, 20] });
    expect(captured.body).toEqual({ repository_ids: [10, 20] });
  });

  it("throws when GitHub returns a non-2xx with the body in the message", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createNodeGitHubClient({
      appId: 1,
      privateKeyPem,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      client.createInstallationToken({ installationId: 1 } as CreateInstallationTokenInput),
    ).rejects.toThrow(/401.*Bad credentials/);
  });

  it("throws when GitHub returns 2xx but the body is missing token or expires_at", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
    );
    const client = createNodeGitHubClient({
      appId: 1,
      privateKeyPem,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await expect(
      client.createInstallationToken({ installationId: 1 } as CreateInstallationTokenInput),
    ).rejects.toThrow(/missing token \/ expires_at/);
  });
});
