import { describe, expect, it } from "vitest";
import { reconcileArcDynamicCredential } from "../src/reconciler/arc-dynamic-credential";
import type { ArcClient } from "../src/arc-client";
import { FakeArcClient, FakeKubeClient, makeDynamicCR } from "./fakes";

const NOW = 1_700_000_000_000;
const ISO_NOW = new Date(NOW).toISOString();

describe("reconcileArcDynamicCredential", () => {
  it("issues a new credential on the first pass and writes it as a Secret", async () => {
    const arc = new FakeArcClient();
    arc.dynamicResponses.push({
      data: { access_key: "AKIA...", secret_key: "secret", session_token: "TOK" },
      lease_id: "aws/creds/deploy/abc",
      lease_duration: 900,
      renewable: false,
    });
    const kube = new FakeKubeClient();

    const result = await reconcileArcDynamicCredential(
      makeDynamicCR({
        source: { mount: "aws", role: "deploy", ttlSeconds: 900 },
        target: { name: "aws-deploy-creds" },
        refreshLeadSeconds: 60,
      }),
      { arc: arc as unknown as ArcClient, kube, now: () => NOW },
    );

    expect(result.ok).toBe(true);
    expect(arc.calls[0]).toMatchObject({ kind: "issueDynamic", payload: { mount: "aws", role: "deploy", ttlSeconds: 900 } });
    expect(kube.appliedSecrets.get("test/aws-deploy-creds")?.stringData).toEqual({
      access_key: "AKIA...",
      secret_key: "secret",
      session_token: "TOK",
    });
    expect(kube.dynamicStatusPatches[0]?.status).toMatchObject({
      leaseId: "aws/creds/deploy/abc",
      expiresAt: new Date(NOW + 900_000).toISOString(),
      lastIssueTime: ISO_NOW,
    });
    expect(arc.revoked).toEqual([]); // no previous lease
  });

  it("re-issues + revokes the previous lease when within the refresh lead window", async () => {
    const arc = new FakeArcClient();
    arc.dynamicResponses.push({
      data: { access_key: "AKIA_NEW", secret_key: "new", session_token: "NEW" },
      lease_id: "aws/creds/deploy/new",
      lease_duration: 900,
      renewable: false,
    });
    const kube = new FakeKubeClient();

    // Previous lease expires in 30 seconds — inside the 60s refresh lead → must re-issue.
    const cr = makeDynamicCR(
      { source: { mount: "aws", role: "deploy" }, target: { name: "aws" }, refreshLeadSeconds: 60 },
      { status: { leaseId: "aws/creds/deploy/old", expiresAt: new Date(NOW + 30_000).toISOString() } },
    );
    const result = await reconcileArcDynamicCredential(cr, { arc: arc as unknown as ArcClient, kube, now: () => NOW });

    expect(result.ok).toBe(true);
    expect(arc.calls[0]?.kind).toBe("issueDynamic");
    expect(kube.appliedSecrets.get("test/aws")?.stringData.access_key).toBe("AKIA_NEW");
    // Best-effort revoke of the old lease — scheduled in the background, so wait a tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(arc.revoked).toEqual(["aws/creds/deploy/old"]);
  });

  it("no-ops when the lease is still valid and outside the refresh lead window", async () => {
    const arc = new FakeArcClient();
    const kube = new FakeKubeClient();

    // Previous lease expires in 10 minutes; lead is 60s → no re-issue.
    const cr = makeDynamicCR(
      { source: { mount: "aws", role: "deploy" }, target: { name: "aws" }, refreshLeadSeconds: 60 },
      { status: { leaseId: "aws/creds/deploy/cur", expiresAt: new Date(NOW + 600_000).toISOString() } },
    );
    const result = await reconcileArcDynamicCredential(cr, { arc: arc as unknown as ArcClient, kube, now: () => NOW });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/still valid/);
    expect(arc.calls).toEqual([]);
    expect(kube.appliedSecrets.size).toBe(0);
    expect(kube.dynamicStatusPatches).toEqual([]);
  });

  it("uses spec.target.template when provided", async () => {
    const arc = new FakeArcClient();
    arc.dynamicResponses.push({
      data: { token: "ya29.abc", expires_in: 3600 },
      lease_id: "gcp/.../1",
      lease_duration: 3600,
      renewable: false,
    });
    const kube = new FakeKubeClient();
    await reconcileArcDynamicCredential(
      makeDynamicCR({
        source: { mount: "gcp", role: "viewer" },
        target: { name: "gcp", template: { BEARER: "Bearer {{ .token }}" } },
      }),
      { arc: arc as unknown as ArcClient, kube, now: () => NOW },
    );
    expect(kube.appliedSecrets.get("test/gcp")?.stringData).toEqual({ BEARER: "Bearer ya29.abc" });
  });

  it("surfaces an issue failure as a Failed Ready condition without writing a Secret", async () => {
    const arc = new FakeArcClient();
    arc.dynamicErrors.push(new Error("arc-server GET aws/creds/deploy failed (500): boom"));
    const kube = new FakeKubeClient();
    const res = await reconcileArcDynamicCredential(
      makeDynamicCR({ source: { mount: "aws", role: "deploy" }, target: { name: "aws" } }),
      { arc: arc as unknown as ArcClient, kube, now: () => NOW },
    );
    expect(res.ok).toBe(false);
    expect(kube.appliedSecrets.size).toBe(0);
    expect(kube.dynamicStatusPatches[0]?.status.conditions?.[0]).toMatchObject({
      type: "Ready",
      status: "False",
      reason: "IssueFailed",
    });
  });
});
