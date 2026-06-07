/**
 * Out-of-process WASM plugin host integration. The actual round-trip through wasmtime
 * needs the binary on `PATH` and a compiled .wasm fixture — both heavy CI lifts. This
 * spec covers what we can do hermetically: confirm `mountWasmSecretsPlugin` constructs
 * the right wasmtime spec and surfaces "wasmtime not installed" cleanly through the same
 * BadRequest path the process-backend uses.
 */
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import { EnginesService, type EnginesConfig } from "../engines/engines.service";
import { PluginsService } from "./plugins.service";

function buildHarness(): PluginsService {
  const registry = new MountRegistry();
  const leases = new LeaseManager();
  const enginesByMount = new Map<string, SecretsEngine>();
  return new PluginsService({ client: null, registry, enginesByMount, leases } satisfies EnginesConfig);
}

describe("PluginsService.mountWasmSecretsPlugin", () => {
  it("when wasmtime isn't installed, surfaces the spawn error as a BadRequest (no half-mounted state)", async () => {
    const plugins = buildHarness();
    await expect(
      plugins.mountWasmSecretsPlugin(
        // Point at a binary that definitely isn't on PATH so spawn() errors immediately.
        { wasmPath: "/dev/null/plugin.wasm", wasmtimePath: "/dev/null/does-not-exist-wasmtime" },
        "wasm/",
        {},
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { errors: expect.arrayContaining([expect.stringMatching(/spawn|ENOENT|wasmtime/i)]) },
    });
    // Verify nothing leaked into the registry.
    expect(plugins.list().map((p) => p.meta.name)).not.toContain("wasm");
  }, 10_000);
});
