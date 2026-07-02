/**
 * Regression for the revoked-member device-grant hole (SEC-C1).
 *
 * `removeMember` used to delete only the target's `granteeUserId` grants, leaving their
 * per-device `granteeDeviceId` grants intact — and `GET /vault/devices/me/keyset` handed those
 * back on nothing more than device ownership. A just-revoked member could therefore keep pulling
 * the wrapped vault key from their own device. This suite proves both halves of the fix:
 *   (1) removeMember now also drops the target's device grants for that vault, and
 *   (2) getDeviceKeyset only surfaces grants for vaults where the owner is still an active member
 *       (defense-in-depth against any lingering grant).
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Repository } from "typeorm";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AppModule } from "../src/app.module";
import { VaultService } from "../src/vault/vault.service";
import {
  VaultEntity,
  VaultMembershipEntity,
  VaultKeyGrantEntity,
  VaultDeviceEntity,
} from "../src/database/entities";

describe("removeMember revokes device grants (SEC-C1)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let vaults: Repository<VaultEntity>;
  let memberships: Repository<VaultMembershipEntity>;
  let grants: Repository<VaultKeyGrantEntity>;
  let devices: Repository<VaultDeviceEntity>;
  let svc: VaultService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    baseUrl = await app.getUrl();
    vaults = app.get(getRepositoryToken(VaultEntity));
    memberships = app.get(getRepositoryToken(VaultMembershipEntity));
    grants = app.get(getRepositoryToken(VaultKeyGrantEntity));
    devices = app.get(getRepositoryToken(VaultDeviceEntity));
    svc = app.get(VaultService);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function devLogin(email: string): Promise<{ token: string; userId: number }> {
    const res = await fetch(`${baseUrl}/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = (await res.json()) as { accessToken: string };
    const userId = JSON.parse(Buffer.from(body.accessToken.split(".")[1]!, "base64").toString("utf8")).sub;
    return { token: body.accessToken, userId };
  }

  function keyset(token: string, deviceId: string) {
    return fetch(`${baseUrl}/vault/devices/me/keyset?deviceId=${deviceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json() as Promise<Array<{ vaultId: string; keyVersion: number }>>);
  }

  it("drops the removed member's device grants and never serves them back", async () => {
    const owner = await devLogin("c1-owner@example.com");
    const member = await devLogin("c1-member@example.com");

    // Seed a team vault with owner + member memberships, a member device, and that device's
    // VK grant — the exact state an approve-device flow produces.
    const vault = await vaults.save(
      vaults.create({ type: "team", ownerUserId: owner.userId, currentKeyVersion: 1, seqCounter: 0 }),
    );
    await memberships.save(
      memberships.create({ vaultId: vault.id, userId: owner.userId, role: "owner", status: "active" }),
    );
    await memberships.save(
      memberships.create({ vaultId: vault.id, userId: member.userId, role: "editor", status: "active" }),
    );
    const device = await devices.save(
      devices.create({ userId: member.userId, name: "member-laptop", publicKey: "pk", approved: true }),
    );
    const seedGrant = () =>
      grants.save(
        grants.create({
          vaultId: vault.id,
          keyVersion: 1,
          granteeDeviceId: device.id,
          wrappedVaultKey: { alg: "seal-x25519-hkdf-xc20p", ct: "opaque" },
          wrappedByUserId: member.userId,
        }),
      );
    await seedGrant();

    // Before removal the member's device legitimately sees the vault's grant.
    const before = await keyset(member.token, device.id);
    expect(before.map((g) => g.vaultId)).toContain(vault.id);

    // Owner revokes the membership.
    await svc.removeMember(owner.userId, vault.id, member.userId);

    // (1) The device grant row is gone.
    expect(await grants.findOne({ where: { vaultId: vault.id, granteeDeviceId: device.id } })).toBeNull();
    // ...and the endpoint no longer serves it.
    expect(await keyset(member.token, device.id)).toEqual([]);

    // (2) Defense-in-depth: even a *lingering* grant (re-seeded to simulate any cleanup gap)
    // is filtered out, because the member is no longer active in the vault.
    await seedGrant();
    expect(await grants.findOne({ where: { vaultId: vault.id, granteeDeviceId: device.id } })).not.toBeNull();
    expect(await keyset(member.token, device.id)).toEqual([]);
  });
});
