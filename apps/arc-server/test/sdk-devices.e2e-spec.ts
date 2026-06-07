/**
 * SDK-level coverage for the new device-management surface: `listDevices`, `touchDevice`,
 * `revokeDevice`. Boots the real server, drives it through `VaultClient` (CJS dist), and
 * asserts the round-trip — type shapes, server state, audit rows.
 *
 * The auto-revoke loop itself is covered by `devices-auto-revoke.e2e-spec.ts`; this suite
 * is the client API contract.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Repository } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VaultClient } = require("@arc/sdk") as typeof import("@arc/sdk");
import { AppModule } from "../src/app.module";
import { VaultDeviceEntity, VaultAuditLogEntity } from "../src/database/entities";

describe("SDK — device management", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let baseUrl: string;
  let devices: Repository<VaultDeviceEntity>;
  let audit: Repository<VaultAuditLogEntity>;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseUrl = await (app.getUrl() as any);
    devices = app.get(getRepositoryToken(VaultDeviceEntity));
    audit = app.get(getRepositoryToken(VaultAuditLogEntity));
  });

  afterAll(async () => {
    await app?.close();
  });

  async function devLogin(email: string): Promise<string> {
    const res = await fetch(`${baseUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = (await res.json()) as { accessToken: string };
    return body.accessToken;
  }

  function getUserId(token: string): number {
    return JSON.parse(Buffer.from(token.split(".")[1]!, "base64").toString("utf8")).sub;
  }

  it("listDevices → touchDevice → revokeDevice round-trip via the SDK", async () => {
    const token = await devLogin("sdk-devices@example.com");
    const userId = getUserId(token);

    // Seed two approved devices directly — easier than driving the full enroll/approve flow
    // (which we already cover elsewhere).
    await devices.delete({ userId });
    const phone = await devices.save(devices.create({
      userId,
      name: "phone",
      publicKey: "pk-phone",
      approved: true,
      trusted: false,
      lastSeenAt: new Date(Date.now() - 86_400_000),
    }));
    const laptop = await devices.save(devices.create({
      userId,
      name: "laptop",
      publicKey: "pk-laptop",
      approved: true,
      trusted: true,
      lastSeenAt: null,
    }));

    const client = new VaultClient({ baseUrl });
    client.setToken(token);
    const list = await client.listDevices();
    const byId = new Map(list.map((d) => [d.id, d] as const));
    expect(byId.get(phone.id)).toMatchObject({ name: "phone", trusted: false });
    expect(byId.get(laptop.id)).toMatchObject({ name: "laptop", trusted: true, lastSeenAt: null });

    // Touch → lastSeenAt updated.
    const beforeTouch = Date.now();
    const touched = await client.touchDevice(phone.id);
    expect(touched.ok).toBe(true);
    const reloaded = await devices.findOneOrFail({ where: { id: phone.id } });
    expect(reloaded.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(beforeTouch);

    // Revoke → device row gone + audit row written.
    const r = await client.revokeDevice(laptop.id);
    expect(r.ok).toBe(true);
    expect(await devices.findOne({ where: { id: laptop.id } })).toBeNull();
    const acts = await audit.find({ where: { actorUserId: userId, targetId: laptop.id } });
    expect(acts.some((a) => a.action === "device_revoked")).toBe(true);
  });
});
