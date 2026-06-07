/**
 * Reconcile a single `ArcDynamicCredential` CR.
 *
 * Each pass we compare the current lease's `expiresAt` against `now + refreshLeadSeconds`.
 *  - If the lease is missing, expired, or about to expire: re-issue from arc-server, write
 *    the new credentials into the target Secret, record the new lease in `.status`, and
 *    best-effort revoke the previous lease.
 *  - Otherwise: no-op. We just schedule the next reconcile.
 *
 * The next reconcile is scheduled for `min(refreshLeadSeconds, leaseDuration / 2)` ahead of
 * expiry — so a 60-second lead on a 30-second lease still reschedules sensibly.
 */
import type { ArcClient } from "../arc-client.js";
import type { KubeClient } from "../k8s/client.js";
import { projectFields } from "../templating.js";
import type { ArcDynamicCredential, Condition } from "../types.js";
import type { ReconcileResult } from "./arc-secret.js";

const DEFAULT_LEAD_SECONDS = 60;

export async function reconcileArcDynamicCredential(
  cr: ArcDynamicCredential,
  deps: { kube: KubeClient; arc: ArcClient; now: () => number },
): Promise<ReconcileResult> {
  const ns = cr.metadata.namespace;
  const name = cr.metadata.name;
  const leadSec = cr.spec.refreshLeadSeconds ?? DEFAULT_LEAD_SECONDS;
  const nowMs = deps.now();
  const leadMs = leadSec * 1000;

  try {
    const expiresAtMs = cr.status?.expiresAt ? Date.parse(cr.status.expiresAt) : 0;
    const needIssue = !cr.status?.leaseId || !Number.isFinite(expiresAtMs) || expiresAtMs - leadMs <= nowMs;

    if (!needIssue) {
      // Still valid — reschedule for just before expiry.
      const sleepMs = Math.max(1_000, expiresAtMs - leadMs - nowMs);
      return { ok: true, message: "lease still valid", nextRunAtMs: nowMs + sleepMs };
    }

    const previousLeaseId = cr.status?.leaseId;
    const issued = await deps.arc.issueDynamic(cr.spec.source.mount, cr.spec.source.role, cr.spec.source.ttlSeconds);
    const leaseDurationSec = issued.lease_duration ?? 0;
    const newExpiresAtMs = nowMs + leaseDurationSec * 1000;

    const stringData = projectFields(cr.spec.target.template, issued.data, `${ns}/${name}`);
    await deps.kube.applySecret({
      namespace: ns,
      name: cr.spec.target.name,
      type: cr.spec.target.type ?? "Opaque",
      stringData,
      ownerReferences: ownerRefFor(cr),
    });

    const nowIso = new Date(nowMs).toISOString();
    await deps.kube.patchArcDynamicCredentialStatus(ns, name, {
      leaseId: issued.lease_id,
      expiresAt: new Date(newExpiresAtMs).toISOString(),
      lastIssueTime: nowIso,
      conditions: [condition("Ready", "True", "IssueSucceeded", `lease ${issued.lease_id} valid for ${leaseDurationSec}s`, nowIso)],
    });

    // Best-effort revoke of the previous lease — failures don't block the new lease being
    // in service.
    if (previousLeaseId && previousLeaseId !== issued.lease_id) {
      void deps.arc.revokeLease(previousLeaseId).catch(() => undefined);
    }

    const halfLifeMs = Math.floor((leaseDurationSec * 1000) / 2);
    const nextRunMs = nowMs + Math.max(1_000, Math.min(leadMs, halfLifeMs > 0 ? halfLifeMs : leadMs));
    return { ok: true, message: "issued", nextRunAtMs: nowMs + (newExpiresAtMs - nowMs - leadMs > 0 ? Math.max(1_000, newExpiresAtMs - nowMs - leadMs) : nextRunMs - nowMs) };
  } catch (err) {
    const nowIso = new Date(nowMs).toISOString();
    await deps.kube
      .patchArcDynamicCredentialStatus(ns, name, {
        conditions: [condition("Ready", "False", "IssueFailed", (err as Error).message, nowIso)],
      })
      .catch(() => undefined);
    return { ok: false, message: (err as Error).message, nextRunAtMs: nowMs + leadMs };
  }
}

function ownerRefFor(cr: ArcDynamicCredential) {
  if (!cr.metadata.uid) return undefined;
  return [
    {
      apiVersion: cr.apiVersion,
      kind: cr.kind,
      name: cr.metadata.name,
      uid: cr.metadata.uid,
      controller: true,
      blockOwnerDeletion: true,
    },
  ];
}

function condition(type: string, status: "True" | "False" | "Unknown", reason: string, message: string, when: string): Condition {
  return { type, status, reason, message, lastTransitionTime: when };
}
