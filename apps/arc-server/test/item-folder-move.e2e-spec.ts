/**
 * Moving an item out of its folder. `putItem(..., { folderId: null })` used to be a silent
 * no-op: the SDK dropped a null folderId from the request, and the server read a null as
 * "keep the current folder". The web app's "Move to Folder → No Folder" action and its Undo
 * toast both depend on null clearing the folder, while an absent folderId must still keep it.
 */
import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type AddressInfo } from "node:net";
import { VaultClient } from "@arc/sdk";
import { AppModule } from "../src/app.module";

describe("item folder moves", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("moves an item into a folder, keeps it there when folderId is omitted, and moves it out with null", async () => {
    const C = new VaultClient({ baseUrl, profile: "test" });
    await C.devLogin("folder-move@example.com");
    await C.enroll("master-password-F");
    const v = await C.createVault("team", "Folders");
    const folder = await C.createFolder(v.id, "Work");
    const folderOf = async (id: string) => (await C.pull(v.id, 0)).items.find((i) => i.id === id)?.folderId;

    const data = { type: "secret", key: "K", value: "v1" };
    const created = await C.putItem(v.id, data, { type: "secret" });
    expect(await folderOf(created.id)).toBeNull();

    const moved = await C.putItem(v.id, data, {
      id: created.id,
      baseVersion: created.version,
      type: "secret",
      folderId: folder.id,
    });
    expect(await folderOf(created.id)).toBe(folder.id);

    // An edit that doesn't mention the folder leaves the item where it is.
    const edited = await C.putItem(v.id, { ...data, value: "v2" }, {
      id: created.id,
      baseVersion: moved.version,
      type: "secret",
    });
    expect(await folderOf(created.id)).toBe(folder.id);

    await C.putItem(v.id, data, {
      id: created.id,
      baseVersion: edited.version,
      type: "secret",
      folderId: null,
    });
    expect(await folderOf(created.id)).toBeNull();
  });
});
