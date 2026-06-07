import { describe, expect, it } from "vitest";
import { reconcileArcSecret } from "../src/reconciler/arc-secret";
import type { ArcClient } from "../src/arc-client";
import { FakeArcClient, FakeKubeClient, makeArcSecretCR } from "./fakes";

const NOW = 1_700_000_000_000;

describe("reconcileArcSecret", () => {
  it("reads KV → projects fields verbatim → applies a Secret with the right OwnerReference", async () => {
    const arc = new FakeArcClient();
    arc.kvGetResponses.set("secret|app/prod|latest", {
      data: { data: { username: "u", password: "p" }, metadata: { version: 7 } },
    });
    const kube = new FakeKubeClient();
    const cr = makeArcSecretCR({
      source: { mount: "secret", path: "app/prod" },
      target: { name: "app-creds" },
    }, { namespace: "apps", uid: "uid-123" });

    const result = await reconcileArcSecret(cr, { arc: arc as unknown as ArcClient, kube, now: () => NOW });

    expect(result).toMatchObject({ ok: true, message: "synced" });
    expect(result.nextRunAtMs - NOW).toBe(300_000); // default refreshIntervalSeconds=300

    const applied = kube.appliedSecrets.get("apps/app-creds");
    expect(applied?.stringData).toEqual({ username: "u", password: "p" });
    expect(applied?.type).toBe("Opaque");
    expect(applied?.ownerReferences?.[0]).toMatchObject({
      apiVersion: "arc.io/v1alpha1",
      kind: "ArcSecret",
      name: "test-secret",
      uid: "uid-123",
      controller: true,
      blockOwnerDeletion: true,
    });

    expect(kube.arcSecretStatusPatches).toHaveLength(1);
    const patch = kube.arcSecretStatusPatches[0]?.status;
    expect(patch?.observedVersion).toBe(7);
    expect(patch?.conditions?.[0]).toMatchObject({ type: "Synced", status: "True", reason: "ReconcileSucceeded" });
  });

  it("renders {{ .field }} templates and rejects refs to fields not present in the source", async () => {
    const arc = new FakeArcClient();
    arc.kvGetResponses.set("secret|db|latest", {
      data: { data: { user: "alice", pass: "s3cr3t", host: "db", db: "app" }, metadata: { version: 1 } },
    });
    const kube = new FakeKubeClient();
    const ok = await reconcileArcSecret(
      makeArcSecretCR({
        source: { path: "db" },
        target: { name: "db", template: { DATABASE_URL: "postgres://{{ .user }}:{{ .pass }}@{{ .host }}/{{ .db }}" } },
      }),
      { arc: arc as unknown as ArcClient, kube, now: () => NOW },
    );
    expect(ok.ok).toBe(true);
    expect(kube.appliedSecrets.get("test/db")?.stringData).toEqual({
      DATABASE_URL: "postgres://alice:s3cr3t@db/app",
    });

    // Now a template referencing a field that doesn't exist surfaces as a Failed condition.
    const arc2 = new FakeArcClient();
    arc2.kvGetResponses.set("secret|db|latest", {
      data: { data: { user: "alice" }, metadata: { version: 1 } },
    });
    const kube2 = new FakeKubeClient();
    const fail = await reconcileArcSecret(
      makeArcSecretCR({
        source: { path: "db" },
        target: { name: "db", template: { URL: "{{ .password_missing }}" } },
      }),
      { arc: arc2 as unknown as ArcClient, kube: kube2, now: () => NOW },
    );
    expect(fail.ok).toBe(false);
    expect(fail.message).toMatch(/password_missing/);
    expect(kube2.appliedSecrets.size).toBe(0);
    expect(kube2.arcSecretStatusPatches[0]?.status.conditions?.[0]).toMatchObject({
      type: "Synced",
      status: "False",
      reason: "ReconcileFailed",
    });
  });

  it("defaults the mount to `secret` and the type to `Opaque`", async () => {
    const arc = new FakeArcClient();
    arc.kvGetResponses.set("secret|x|latest", { data: { data: { k: "v" }, metadata: { version: 1 } } });
    const kube = new FakeKubeClient();
    await reconcileArcSecret(makeArcSecretCR({ source: { path: "x" }, target: { name: "t" } }), {
      arc: arc as unknown as ArcClient,
      kube,
      now: () => NOW,
    });
    expect(kube.appliedSecrets.get("test/t")?.type).toBe("Opaque");
  });

  it("propagates an arc-server failure to a Failed status condition", async () => {
    const arc = new FakeArcClient();
    arc.kvGetErrors.set("secret|x|latest", new Error("arc-server GET secret/data/x failed (403): forbidden"));
    const kube = new FakeKubeClient();
    const res = await reconcileArcSecret(makeArcSecretCR({ source: { path: "x" }, target: { name: "t" } }), {
      arc: arc as unknown as ArcClient,
      kube,
      now: () => NOW,
    });
    expect(res.ok).toBe(false);
    expect(kube.appliedSecrets.size).toBe(0);
    expect(kube.arcSecretStatusPatches[0]?.status.conditions?.[0]).toMatchObject({
      type: "Synced",
      status: "False",
      reason: "ReconcileFailed",
    });
  });

  it("omits OwnerReferences when the CR has no uid (e.g. dry-run / synthesized CR)", async () => {
    const arc = new FakeArcClient();
    arc.kvGetResponses.set("secret|x|latest", { data: { data: { k: "v" }, metadata: { version: 1 } } });
    const kube = new FakeKubeClient();
    const cr = makeArcSecretCR({ source: { path: "x" }, target: { name: "t" } });
    cr.metadata.uid = undefined;
    await reconcileArcSecret(cr, { arc: arc as unknown as ArcClient, kube, now: () => NOW });
    expect(kube.appliedSecrets.get("test/t")?.ownerReferences).toBeUndefined();
  });
});
