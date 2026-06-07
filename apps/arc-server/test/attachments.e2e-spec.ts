/**
 * End-to-end coverage of the encrypted-attachment surface.
 *
 *   POST   /vaults/:vId/items/:iId/attachments         — upload (ciphertext as b64)
 *   GET    /vaults/:vId/items/:iId/attachments         — list (metadata only)
 *   GET    /vaults/:vId/items/:iId/attachments/:attId  — download ciphertext
 *   DELETE /vaults/:vId/items/:iId/attachments/:attId  — delete row + blob
 *
 * The server stays zero-knowledge: ciphertext bytes are opaque to it. These tests use a
 * stand-in "ciphertext" (random base64 payload) plus stand-in `wrappedKey` / `encMetadata`
 * envelopes — the real client-side crypto is covered by @arc/crypto / @arc/sdk tests.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { VaultClient } from "@arc/sdk";
import { AppModule } from "../src/app.module";

function fakeEnvelope() {
  return { v: 1, alg: "xchacha20poly1305", kdf: "argon2id", keyVersion: 1, aad: "", nonce: "AAAA", ct: "AAAA" };
}

describe("attachments e2e", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  let seq = 0;
  async function setupVaultItem(): Promise<{ token: string; vaultId: string; itemId: string }> {
    const A = new VaultClient({ baseUrl, profile: "test" });
    // Unique email per test — enroll() is one-shot per user, so a reused address 409s the
    // second run within the same suite.
    const { token } = await A.devLogin(`alice-att-${++seq}@example.com`);
    await A.enroll(`master-password-A-${seq}`);
    const vault = await A.createVault("team");
    await A.putItem(vault.id, { type: "secret", key: "X", value: "y" }, { type: "secret" });
    const pulled = await A.pull(vault.id, 0);
    return { token, vaultId: vault.id, itemId: pulled.items[0]!.id };
  }

  function call(path: string, init: { token: string; method: string; body?: unknown }) {
    return fetch(`${baseUrl}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${init.token}`,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  it("upload → list → download → delete round-trip preserves opaque bytes verbatim", async () => {
    const { token, vaultId, itemId } = await setupVaultItem();

    const bytes = randomBytes(1024); // 1 KiB of opaque "ciphertext"
    const ciphertextB64 = bytes.toString("base64");

    const upRes = await call(`/vaults/${vaultId}/items/${itemId}/attachments`, {
      token,
      method: "POST",
      body: { ciphertextB64, wrappedKey: fakeEnvelope(), encMetadata: fakeEnvelope(), vaultKeyVersion: 1 },
    });
    expect(upRes.status).toBe(201);
    const uploaded = (await upRes.json()) as { id: string; sizeBytes: number };
    expect(uploaded.sizeBytes).toBe(1024);

    const listRes = await call(`/vaults/${vaultId}/items/${itemId}/attachments`, { token, method: "GET" });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{ id: string; sizeBytes: number }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(uploaded.id);

    const dlRes = await call(`/vaults/${vaultId}/items/${itemId}/attachments/${uploaded.id}`, { token, method: "GET" });
    expect(dlRes.status).toBe(200);
    const downloaded = (await dlRes.json()) as { ciphertextB64: string; sizeBytes: number };
    expect(downloaded.ciphertextB64).toBe(ciphertextB64);
    expect(downloaded.sizeBytes).toBe(1024);

    const delRes = await call(`/vaults/${vaultId}/items/${itemId}/attachments/${uploaded.id}`, { token, method: "DELETE" });
    expect(delRes.status).toBe(200);
    const listAfter = (await call(`/vaults/${vaultId}/items/${itemId}/attachments`, { token, method: "GET" }).then((r) => r.json())) as unknown[];
    expect(listAfter).toEqual([]);

    // Re-downloading after delete is a 404.
    const dl404 = await call(`/vaults/${vaultId}/items/${itemId}/attachments/${uploaded.id}`, { token, method: "GET" });
    expect(dl404.status).toBe(404);
  });

  it("rejects an oversized ciphertext (413)", async () => {
    const { token, vaultId, itemId } = await setupVaultItem();
    // 26 MiB > the 25 MiB code cap. The body parser limit (40 MiB) lets the bytes through;
    // the service-layer guard fires the 413.
    const oversized = Buffer.alloc(26 * 1024 * 1024).toString("base64");
    const res = await call(`/vaults/${vaultId}/items/${itemId}/attachments`, {
      token,
      method: "POST",
      body: { ciphertextB64: oversized, wrappedKey: fakeEnvelope(), encMetadata: fakeEnvelope(), vaultKeyVersion: 1 },
    });
    expect(res.status).toBe(413);
  });

  it("rejects an empty ciphertext (413)", async () => {
    const { token, vaultId, itemId } = await setupVaultItem();
    const res = await call(`/vaults/${vaultId}/items/${itemId}/attachments`, {
      token,
      method: "POST",
      body: { ciphertextB64: "", wrappedKey: fakeEnvelope(), encMetadata: fakeEnvelope(), vaultKeyVersion: 1 },
    });
    expect(res.status).toBe(413);
  });

  it("a non-member cannot upload to or list a different user's vault (404 to hide existence)", async () => {
    const { vaultId, itemId } = await setupVaultItem();

    // Independent user with no membership in that vault.
    const B = new VaultClient({ baseUrl, profile: "test" });
    const { token: bToken} = await B.devLogin(`eve-att-${++seq}@example.com`);
    await B.enroll(`master-password-B-${seq}`);

    const upRes = await call(`/vaults/${vaultId}/items/${itemId}/attachments`, {
      token: bToken,
      method: "POST",
      body: { ciphertextB64: Buffer.from("x").toString("base64"), wrappedKey: fakeEnvelope(), encMetadata: fakeEnvelope(), vaultKeyVersion: 1 },
    });
    expect(upRes.status).toBe(404); // requireRole hides existence from non-members

    const listRes = await call(`/vaults/${vaultId}/items/${itemId}/attachments`, { token: bToken, method: "GET" });
    expect(listRes.status).toBe(404);
  });

  it("the audit log records attachment_added and attachment_deleted (metadata only)", async () => {
    const { token, vaultId, itemId } = await setupVaultItem();
    const A = new VaultClient({ baseUrl, profile: "test" });
    // Re-attach the same token to a client so we can call listAudit through the SDK.
    A.setToken(token);

    const up = await call(`/vaults/${vaultId}/items/${itemId}/attachments`, {
      token,
      method: "POST",
      body: { ciphertextB64: Buffer.from("hi").toString("base64"), wrappedKey: fakeEnvelope(), encMetadata: fakeEnvelope(), vaultKeyVersion: 1 },
    });
    const { id: attId } = (await up.json()) as { id: string };
    await call(`/vaults/${vaultId}/items/${itemId}/attachments/${attId}`, { token, method: "DELETE" });

    const audit = await A.listAudit(vaultId, { limit: 50 });
    const actions = audit.map((e) => e.action);
    expect(actions).toContain("attachment_added");
    expect(actions).toContain("attachment_deleted");
    // Metadata-only: no ciphertext text leaks into the audit row.
    expect(JSON.stringify(audit)).not.toContain("ciphertextB64");
  });
});
