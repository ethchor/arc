import { describe, expect, it } from "vitest";
import { runReconcileLoop } from "../src/reconciler/loop";
import type { ArcClient } from "../src/arc-client";
import { FakeArcClient, FakeKubeClient, makeArcSecretCR, makeDynamicCR } from "./fakes";

const NOW = 1_700_000_000_000;

describe("runReconcileLoop", () => {
  it("processes every ArcSecret and ArcDynamicCredential in a single iteration", async () => {
    const arc = new FakeArcClient();
    arc.kvGetResponses.set("secret|a|latest", { data: { data: { k: "v1" }, metadata: { version: 1 } } });
    arc.kvGetResponses.set("secret|b|latest", { data: { data: { k: "v2" }, metadata: { version: 1 } } });
    arc.dynamicResponses.push(
      { data: { token: "t1" }, lease_id: "L1", lease_duration: 900, renewable: false },
      { data: { token: "t2" }, lease_id: "L2", lease_duration: 900, renewable: false },
    );

    const kube = new FakeKubeClient();
    kube.arcSecrets = [
      makeArcSecretCR({ source: { path: "a" }, target: { name: "ka" } }, { name: "ka" }),
      makeArcSecretCR({ source: { path: "b" }, target: { name: "kb" } }, { name: "kb" }),
    ];
    kube.dynamics = [
      makeDynamicCR({ source: { mount: "aws", role: "r1" }, target: { name: "d1" } }, { name: "d1" }),
      makeDynamicCR({ source: { mount: "aws", role: "r2" }, target: { name: "d2" } }, { name: "d2" }),
    ];

    let iters = 0;
    await runReconcileLoop({
      arc: arc as unknown as ArcClient,
      kube,
      pollIntervalSeconds: 1,
      now: () => NOW,
      sleep: async () => undefined,
      shouldStop: () => iters >= 1,
      onIteration: (s) => {
        iters++;
        expect(s.arcSecrets.processed).toBe(2);
        expect(s.arcSecrets.failed).toBe(0);
        expect(s.dynamic.processed).toBe(2);
        expect(s.dynamic.failed).toBe(0);
      },
    });

    expect(kube.appliedSecrets.size).toBe(4);
    expect(kube.appliedSecrets.get("test/ka")?.stringData).toEqual({ k: "v1" });
    expect(kube.appliedSecrets.get("test/d1")?.stringData).toEqual({ token: "t1" });
  });

  it("a single bad CR does not block the rest of the iteration", async () => {
    const arc = new FakeArcClient();
    // First CR will fail (no canned response), second CR will succeed.
    arc.kvGetResponses.set("secret|ok|latest", { data: { data: { k: "v" }, metadata: { version: 1 } } });
    const kube = new FakeKubeClient();
    kube.arcSecrets = [
      makeArcSecretCR({ source: { path: "missing" }, target: { name: "missing" } }, { name: "missing" }),
      makeArcSecretCR({ source: { path: "ok" }, target: { name: "ok" } }, { name: "ok" }),
    ];

    let iters = 0;
    await runReconcileLoop({
      arc: arc as unknown as ArcClient,
      kube,
      pollIntervalSeconds: 1,
      now: () => NOW,
      sleep: async () => undefined,
      shouldStop: () => iters >= 1,
      onIteration: (s) => {
        iters++;
        expect(s.arcSecrets.processed).toBe(2);
        expect(s.arcSecrets.failed).toBe(1);
      },
    });
    expect(kube.appliedSecrets.has("test/ok")).toBe(true);
    expect(kube.appliedSecrets.has("test/missing")).toBe(false);
  });

  it("stops cleanly when shouldStop returns true between iterations", async () => {
    const arc = new FakeArcClient();
    const kube = new FakeKubeClient();
    let iters = 0;
    await runReconcileLoop({
      arc: arc as unknown as ArcClient,
      kube,
      pollIntervalSeconds: 1,
      now: () => NOW,
      sleep: async () => undefined,
      shouldStop: () => iters >= 2,
      onIteration: () => iters++,
    });
    expect(iters).toBe(2);
  });
});
