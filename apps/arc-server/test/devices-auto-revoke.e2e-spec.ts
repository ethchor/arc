/**
 * End-to-end coverage of multi-device key rotation: touch keeps a device alive,
 * `DevicesAutoRevokeService` retires the rest, and `trusted: true` is the operator's
 * "exempt this device from the inactivity policy" escape hatch.
 *
 * The whole feature is env-gated by `ARC_DEVICE_INACTIVE_DAYS` so default boots
 * (incl. existing tests) get nothing — `runOnce()` early-exits with `revokedIds: []`
 * and the scheduler doesn't arm.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Repository } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { DevicesAutoRevokeService } from "../src/vault/devices-auto-revoke.service";
import {
  VaultAuditLogEntity,
  VaultDeviceEntity,
} from "../src/database/entities";

async function login(server: unknown, email: string): Promise<{ token: string; userId: number }> {
  const res = await request(server as Parameters<typeof request>[0])
    .post("/auth/dev-login")
    .send({ email })
    .expect(201);
  const body = res.body as { accessToken: string };
  const payload = JSON.parse(Buffer.from(body.accessToken.split(".")[1]!, "base64").toString("utf8")) as { sub: number };
  return { token: body.accessToken, userId: payload.sub };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe("multi-device key rotation — touch + auto-revoke", () => {
  let app: INestApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let devices: Repository<VaultDeviceEntity>;
  let audit: Repository<VaultAuditLogEntity>;
  let autoRevoke: DevicesAutoRevokeService;
  let token: string;
  let userId: number;

  const savedDays = process.env.ARC_DEVICE_INACTIVE_DAYS;
  const savedInterval = process.env.ARC_DEVICE_AUTO_REVOKE_INTERVAL_MS;

  beforeAll(async () => {
    // Enable the feature for this suite. The env vars stay set for the duration —
    // afterAll restores them. Scan interval is irrelevant; we trigger via runOnce().
    process.env.ARC_DEVICE_INACTIVE_DAYS = "7";
    process.env.ARC_DEVICE_AUTO_REVOKE_INTERVAL_MS = "60000";

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    server = app.getHttpServer();
    devices = app.get(getRepositoryToken(VaultDeviceEntity));
    audit = app.get(getRepositoryToken(VaultAuditLogEntity));
    autoRevoke = app.get(DevicesAutoRevokeService);

    const session = await login(server, "device-rotation@example.com");
    token = session.token;
    userId = session.userId;
  });

  afterAll(async () => {
    await app?.close();
    if (savedDays === undefined) delete process.env.ARC_DEVICE_INACTIVE_DAYS;
    else process.env.ARC_DEVICE_INACTIVE_DAYS = savedDays;
    if (savedInterval === undefined) delete process.env.ARC_DEVICE_AUTO_REVOKE_INTERVAL_MS;
    else process.env.ARC_DEVICE_AUTO_REVOKE_INTERVAL_MS = savedInterval;
  });

  async function enroll(name: string, approved: boolean, lastSeenAgo: number | null, trusted = false): Promise<VaultDeviceEntity> {
    const lastSeenAt = lastSeenAgo === null ? null : new Date(Date.now() - lastSeenAgo);
    return devices.save(
      devices.create({
        userId,
        name,
        publicKey: `${name}-pk-${Math.random().toString(36).slice(2)}`,
        approved,
        trusted,
        lastSeenAt,
      }),
    );
  }

  it("POST /vault/devices/me/touch updates lastSeenAt for the calling user's own device", async () => {
    const dev = await enroll("phone", true, 30 * 24 * 60 * 60 * 1000); // 30 days idle
    expect(dev.lastSeenAt?.getTime()).toBeLessThan(Date.now() - 7 * 86_400_000);

    const before = Date.now();
    await request(server).post("/vault/devices/me/touch").set(auth(token)).send({ deviceId: dev.id }).expect(201);
    const after = Date.now();

    const reloaded = await devices.findOneOrFail({ where: { id: dev.id } });
    expect(reloaded.lastSeenAt).not.toBeNull();
    expect(reloaded.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(reloaded.lastSeenAt!.getTime()).toBeLessThanOrEqual(after + 1_000);
  });

  it("rejects touching a device that belongs to a different user (404)", async () => {
    const other = await login(server, "device-rotation-other@example.com");
    const dev = await devices.save(devices.create({
      userId: other.userId,
      name: "other-laptop",
      publicKey: "other-pk",
      approved: true,
      trusted: false,
      lastSeenAt: new Date(),
    }));
    await request(server)
      .post("/vault/devices/me/touch")
      .set(auth(token))
      .send({ deviceId: dev.id })
      .expect(404);
  });

  it("GET /vault/devices?approved=true returns approved devices with lastSeenAt + trusted", async () => {
    await devices.delete({ userId });
    const fresh = await enroll("desktop", true, 60 * 1000);
    await enroll("waiting", false, null); // pending should NOT appear in approved list

    const res = await request(server).get("/vault/devices?approved=true&pending=false").set(auth(token)).expect(200);
    const list = res.body as Array<{ id: string; lastSeenAt: string | null; trusted: boolean; name: string }>;
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(fresh.id);
    expect(list[0]?.trusted).toBe(false);
    expect(list[0]?.lastSeenAt).not.toBeNull();
  });

  it("runOnce() retires stale untrusted devices, keeps fresh + trusted devices, writes device_auto_revoked", async () => {
    await devices.delete({ userId });

    const stale = await enroll("retired-laptop", true, 30 * 86_400_000);    // way past 7 days
    const fresh = await enroll("current-phone", true, 60 * 1000);            // 1 minute ago
    const trustedStale = await enroll("server-rack-key", true, 30 * 86_400_000, true); // trusted, exempt
    const pending = await enroll("just-registered", false, null);            // pending, exempt

    const auditBefore = await audit.count();
    const result = await autoRevoke.runOnce();
    expect(result.revokedIds.sort()).toEqual([stale.id].sort());

    // Verify on-disk state matches the report.
    const remaining = await devices.find({ where: { userId } });
    const remainingIds = remaining.map((d) => d.id).sort();
    expect(remainingIds).toEqual([fresh.id, trustedStale.id, pending.id].sort());

    // Audit row was written with the distinct `device_auto_revoked` action so an
    // investigator can tell apart "user manually retired" vs "platform retired".
    const newAudits = await audit.find({ where: { actorUserId: userId } });
    expect(newAudits.some((a) => a.action === "device_auto_revoked" && a.targetId === stale.id)).toBe(true);
    expect(newAudits.length).toBeGreaterThan(auditBefore - 1);
  });

  it("POST /vault/devices/auto-revoke/run drives the same flow over HTTP and reports `enabled`", async () => {
    await devices.delete({ userId });
    const stale = await enroll("hr-tablet", true, 30 * 86_400_000);
    const fresh = await enroll("laptop", true, 60 * 1000);

    const res = await request(server).post("/vault/devices/auto-revoke/run").set(auth(token)).expect(201);
    const body = res.body as { enabled: boolean; revokedIds: string[] };
    expect(body.enabled).toBe(true);
    expect(body.revokedIds).toEqual([stale.id]);

    const remaining = await devices.find({ where: { userId } });
    expect(remaining.map((d) => d.id)).toEqual([fresh.id]);
  });

  it("manual DELETE /vault/devices/:id still works after the auto-revoke wiring lands", async () => {
    await devices.delete({ userId });
    const a = await enroll("laptop-a", true, 60 * 1000);
    const b = await enroll("laptop-b", true, 60 * 1000);

    await request(server).delete(`/vault/devices/${a.id}`).set(auth(token)).expect(200);
    const left = await devices.find({ where: { userId } });
    expect(left.map((d) => d.id)).toEqual([b.id]);

    // Audit shows the explicit `device_revoked` action (not `device_auto_revoked`).
    const acts = await audit.find({ where: { actorUserId: userId, targetId: a.id } });
    expect(acts.some((r) => r.action === "device_revoked")).toBe(true);
    expect(acts.some((r) => r.action === "device_auto_revoked")).toBe(false);
  });
});

describe("auto-revoke is off by default", () => {
  let app: INestApplication;
  let autoRevoke: DevicesAutoRevokeService;

  beforeAll(async () => {
    delete process.env.ARC_DEVICE_INACTIVE_DAYS; // explicit "feature off"
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    autoRevoke = app.get(DevicesAutoRevokeService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("reports disabled and is a no-op", async () => {
    expect(autoRevoke.enabled).toBe(false);
    const r = await autoRevoke.runOnce();
    expect(r.revokedIds).toEqual([]);
  });
});
