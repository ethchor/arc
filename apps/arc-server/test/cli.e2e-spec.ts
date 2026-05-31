import { type INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AddressInfo } from "node:net";
import { runCli } from "@arc/cli";
import { AppModule } from "../src/app.module";

describe("vault CLI e2e (developer workflow)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let configDir: string;
  const out: string[] = [];
  const err: string[] = [];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.listen(0);
    const addr = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    configDir = mkdtempSync(join(tmpdir(), "arc-cli-"));
  });

  afterAll(async () => {
    await app.close();
  });

  const run = (...argv: string[]) =>
    runCli({
      argv,
      env: {
        ARC_BASE_URL: baseUrl,
        ARC_MASTER_PASSWORD: "cli-master-pw",
        ARC_ARGON_PROFILE: "test",
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      configDir,
    });

  it("logs in, enrolls, creates a vault, sets and gets a secret", async () => {
    expect(await run("login", "dev@cli.example")).toBe(0);
    expect(await run("enroll")).toBe(0);

    const beforeCreate = out.length;
    expect(await run("create-vault", "team")).toBe(0);
    const vaultId = out[beforeCreate]!;
    expect(vaultId).toMatch(/[0-9a-f-]{36}/);

    expect(await run("set", vaultId, "API_KEY", "sk-test-123")).toBe(0);

    const beforeGet = out.length;
    expect(await run("get", vaultId, "API_KEY")).toBe(0);
    expect(out[beforeGet]).toBe("sk-test-123");

    // update the same key, then read the new value
    expect(await run("set", vaultId, "API_KEY", "sk-test-456")).toBe(0);
    const beforeGet2 = out.length;
    expect(await run("get", vaultId, "API_KEY")).toBe(0);
    expect(out[beforeGet2]).toBe("sk-test-456");

    // missing key returns non-zero
    expect(await run("get", vaultId, "NOPE")).toBe(1);
  });
});
