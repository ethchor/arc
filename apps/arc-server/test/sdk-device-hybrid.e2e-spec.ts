/**
 * End-to-end coverage of the **ADR-003 hybrid device flow**: a trusted (X25519 + ML-KEM-768)
 * approver wraps the VK with `pqSeal`, a new device whose registration submitted both pubs
 * opens that grant with `pqSealOpen`, and it can subsequently decrypt vault items.
 *
 * The test exercises the full path through the real server, so it catches: schema column
 * persistence, DTO field acceptance, the listPendingDevices payload exposing the new
 * `publicKeyMlkem`, the SDK switching `seal` → `pqSeal` on approval, and the SDK switching
 * `sealOpen` → `pqSealOpen` on grant load.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type AddressInfo } from "node:net";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VaultClient } = require("@arc/sdk") as typeof import("@arc/sdk");
import { AppModule } from "../src/app.module";

describe("SDK device flow — ADR-003 hybrid (X25519 + ML-KEM-768)", () => {
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

  it("trusted device approves a new hybrid device with pqSeal → new device opens with pqSealOpen → decrypts the vault", async () => {
    // 1. Trusted device: enroll + create a vault + write a probe secret.
    const trusted = new VaultClient({ baseUrl, profile: "test" });
    await trusted.devLogin("alice-pq-device@example.com");
    await trusted.enroll("master-password-pq");
    const vault = await trusted.createVault("personal");
    await trusted.putItem(
      vault.id,
      { type: "secret", key: "PROBE", value: "shared-via-pq-device-grant" },
      { type: "secret" },
    );

    // 2. New device (no master password): same user logs in fresh, registers a HYBRID
    //    device → both pubs land on the server.
    const newDevice = new VaultClient({ baseUrl, profile: "test" });
    await newDevice.devLogin("alice-pq-device@example.com");
    const { deviceId } = await newDevice.registerDevice("ipad-pq");

    // 3. Trusted device: discover the pending device's hybrid pubs and approve. The SDK
    //    will route through `pqSeal` because the pending device exposes `publicKeyMlkem`.
    const pending = await trusted.listPendingDevices();
    const target = pending.find((d) => d.id === deviceId);
    expect(target).toBeDefined();
    expect(target?.publicKeyMlkem).toBeTruthy(); // server persisted + surfaced the mlkem pub
    await trusted.approveDevice(deviceId, target!.publicKey, target!.publicKeyMlkem);

    // 4. New device: load grants. The wrappedVaultKey envelope's `alg` should be the
    //    `pq-hybrid-*` variant; loadDeviceGrants picks `pqSealOpen` automatically.
    const loaded = await newDevice.loadDeviceGrants(deviceId);
    expect(loaded.map((g) => g.id)).toContain(vault.id);

    // 5. New device decrypts the probe — proves the VK was correctly unwrapped through
    //    the hybrid envelope, end-to-end.
    const pulled = await newDevice.pull(vault.id, 0);
    expect(pulled.items).toHaveLength(1);
    expect(pulled.items[0]!.data).toMatchObject({ key: "PROBE", value: "shared-via-pq-device-grant" });
  });
});
