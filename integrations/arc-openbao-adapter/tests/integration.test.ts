/**
 * Live OpenBao smoke test. Drives the documented HTTP API end-to-end against a real
 * OpenBao server: the `bao status` round-trip (sealStatus) plus a full KV v2
 * put → get → list → delete cycle through `OpenBaoKvEngine`.
 *
 * **Runs only when `BAO_ADDR` is set.** Otherwise the whole suite skips so `pnpm test`
 * still passes locally without OpenBao running. Start a dev server with the snippet from
 * `docs/CLAUDE.md` (or `docker-compose -f integrations/arc-openbao-adapter/docker-compose.yml
 * up -d`) and rerun with `BAO_ADDR=http://127.0.0.1:8200 BAO_TOKEN=root pnpm --filter
 * @arc/openbao-adapter test`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { OpenBaoClient } from "../src/client";
import { OpenBaoKvEngine } from "../src/kv-engine";
import { OpenBaoTransitEngine } from "../src/transit-engine";

const addr = process.env.BAO_ADDR;
const token = process.env.BAO_TOKEN ?? "root";
const integration = describe.skipIf(!addr);

integration("OpenBao smoke test (BAO_ADDR set)", () => {
  // Lazy: vitest still evaluates a skipped describe body to collect its test ids, so the
  // client must not be constructed until a test actually runs (otherwise an unset
  // BAO_ADDR would crash before .skipIf could short-circuit the suite).
  let client: OpenBaoClient;
  beforeAll(() => {
    client = new OpenBaoClient({ addr: addr!, token });
  });

  it("seal status round-trips (the `bao status` equivalent)", async () => {
    const status = await client.sealStatus();
    // Dev mode boots auto-unsealed + auto-initialized.
    expect(status.sealed).toBe(false);
    expect(status.initialized).toBe(true);
    expect(typeof status.version).toBe("string");
  });

  it("health endpoint returns a shape with `initialized` and `sealed`", async () => {
    const health = await client.health();
    expect(health).toBeTypeOf("object");
    // Both keys appear regardless of standby/active state.
    expect(health).toHaveProperty("initialized");
    expect(health).toHaveProperty("sealed");
  });

  it("KV v2: put → get → list → soft-delete round-trips through OpenBaoKvEngine", async () => {
    // The dev-mode server mounts KV v2 at `secret/` by default.
    const kv = new OpenBaoKvEngine(client, "secret");
    const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const key = `arc-smoke/${id}`;
    const value = { apiKey: "sk-smoke", note: "delete me" };

    const write = await kv.put(key, value);
    expect(write.version).toBeGreaterThan(0);

    const read = await kv.get(key);
    expect(read.data).toEqual(value);
    expect(read.metadata.version).toBe(write.version);
    expect(read.metadata.deleted).toBe(false);

    // List is metadata-scoped (`secret/metadata/arc-smoke/`).
    const list = await kv.list("arc-smoke");
    expect(list).toContain(id);

    // `deleteLatest` marks the latest version deleted but keeps the row + metadata.
    await kv.deleteLatest(key);
    const afterDelete = await kv.get(key);
    expect(afterDelete.metadata.deleted).toBe(true);
  });

  it("transit: create key → encrypt → decrypt → rotate → still decrypts old ciphertext", async () => {
    // Mounting transit requires the root token, which dev mode provides.
    await client.write("sys/mounts/transit", { type: "transit" }).catch((err: { status?: number }) => {
      // Re-running the suite leaves the mount in place; OpenBao returns 400 with
      // 'path is already in use' which we treat as a no-op.
      if (err.status !== 400) throw err;
    });
    const transit = new OpenBaoTransitEngine(client);
    const keyName = `arc-smoke-${Date.now()}`;

    await transit.createKey(keyName);

    const plaintext = new TextEncoder().encode("encryption-as-a-service");
    const ct1 = await transit.encrypt(keyName, plaintext);
    expect(ct1.ciphertext.startsWith(`vault:v1:`)).toBe(true);
    expect(ct1.keyVersion).toBe(1);

    const pt1 = await transit.decrypt(keyName, ct1.ciphertext);
    expect(new TextDecoder().decode(pt1)).toBe("encryption-as-a-service");

    const { latestVersion } = await transit.rotateKey(keyName);
    expect(latestVersion).toBe(2);

    // Old v1 ciphertext still decrypts under the rotated key (engine retains prior versions).
    const ptAfterRotate = await transit.decrypt(keyName, ct1.ciphertext);
    expect(new TextDecoder().decode(ptAfterRotate)).toBe("encryption-as-a-service");

    // New ciphertext now uses v2.
    const ct2 = await transit.encrypt(keyName, plaintext);
    expect(ct2.keyVersion).toBe(2);
  });
});
