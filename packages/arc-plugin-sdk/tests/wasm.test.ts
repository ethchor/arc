/**
 * Unit tests for `buildWasmtimeSpec`. These check that the sandbox flags + env passthrough +
 * dir mappings end up where they should — without needing wasmtime installed. The
 * end-to-end "wasmtime actually runs the wasm" path is exercised by the arc-server
 * integration spec when the binary is present (and skipped otherwise).
 */
import { describe, expect, it } from "vitest";
import { buildWasmtimeSpec } from "../src/wasm";

describe("buildWasmtimeSpec", () => {
  it("pins the deny-by-default sandbox profile + targets the wasmtime binary by default", () => {
    const spec = buildWasmtimeSpec({ wasmPath: "/p/plug.wasm" });
    expect(spec.command).toBe("wasmtime");
    expect(spec.args).toContain("run");
    expect(spec.args).toContain("--env-inherit=none");
    expect(spec.args).toContain("--dir=none");
    expect(spec.args).toContain("--tcplisten=none");
    // wasm path appears once and is followed by the argv separator.
    const idx = (spec.args ?? []).indexOf("/p/plug.wasm");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(spec.args?.[idx + 1]).toBe("--");
  });

  it("honours `wasmtimePath` for pinned-version deployments", () => {
    const spec = buildWasmtimeSpec({ wasmPath: "/p/plug.wasm", wasmtimePath: "/opt/wasmtime/bin/wasmtime" });
    expect(spec.command).toBe("/opt/wasmtime/bin/wasmtime");
  });

  it("threads each plugin-visible env var through wasmtime's --env=K=V flag", () => {
    const spec = buildWasmtimeSpec({
      wasmPath: "/p.wasm",
      env: { ARC_REGION: "us-east-1", PLUGIN_DEBUG: "1" },
    });
    expect(spec.args).toContain("--env=ARC_REGION=us-east-1");
    expect(spec.args).toContain("--env=PLUGIN_DEBUG=1");
    // The HOST env stays empty — wasmtime itself runs with nothing inherited.
    expect(spec.env).toEqual({});
  });

  it("forwards each --dir mapping the operator opted into (and nothing they didn't)", () => {
    const spec = buildWasmtimeSpec({
      wasmPath: "/p.wasm",
      dirs: ["/etc/plugin-config=/config", "/var/run/state=/state:rw"],
    });
    expect(spec.args).toContain("--dir=/etc/plugin-config=/config");
    expect(spec.args).toContain("--dir=/var/run/state=/state:rw");
    // The default deny-all `--dir=none` is still present — wasmtime treats the later `--dir`
    // flags as additive grants on top of the deny default.
    expect(spec.args).toContain("--dir=none");
  });

  it("places plugin argv after the `--` separator", () => {
    const spec = buildWasmtimeSpec({ wasmPath: "/p.wasm", args: ["--verbose", "extra"] });
    const a = spec.args ?? [];
    const sepIdx = a.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    expect(a.slice(sepIdx + 1)).toEqual(["--verbose", "extra"]);
  });

  it("propagates the optional RPC timeouts so heavyweight plugins can extend them", () => {
    const spec = buildWasmtimeSpec({ wasmPath: "/p.wasm", rpcTimeoutMs: 90_000, shutdownGraceMs: 10_000 });
    expect(spec.rpcTimeoutMs).toBe(90_000);
    expect(spec.shutdownGraceMs).toBe(10_000);
  });
});
