/**
 * Reconcile a single `ArcSecret` CR.
 *
 * Flow:
 *  1. Read the source from arc-server (KV v2 `data/<path>`).
 *  2. Apply `spec.target.template` (or copy fields verbatim) to produce the Secret payload.
 *  3. Upsert the target K8s Secret in the CR's namespace, with the CR as OwnerReference so
 *     `kubectl delete arcsecret X` garbage-collects the Secret.
 *  4. Patch `.status` with the observed KV version + a `Synced` condition.
 *
 * Errors are caught, recorded as a `Failed` condition, and re-raised so the outer loop logs
 * and continues with the next CR — one bad source can't block the rest of the workload.
 */
import type { ArcClient } from "../arc-client.js";
import type { KubeClient } from "../k8s/client.js";
import { projectFields } from "../templating.js";
import type { ArcSecret, Condition } from "../types.js";

export interface ReconcileResult {
  ok: boolean;
  message: string;
  /** Time at which the CR should next be reconciled (ms epoch). */
  nextRunAtMs: number;
}

export async function reconcileArcSecret(
  cr: ArcSecret,
  deps: { kube: KubeClient; arc: ArcClient; now: () => number },
): Promise<ReconcileResult> {
  const ns = cr.metadata.namespace;
  const name = cr.metadata.name;
  const intervalSec = cr.spec.refreshIntervalSeconds ?? 300;

  try {
    const mount = cr.spec.source.mount ?? "secret";
    const path = cr.spec.source.path;
    const version = cr.spec.source.version;

    const response = await deps.arc.kvGet(mount, path, version);
    const sourceData = response.data?.data ?? {};
    const observedVersion = response.data?.metadata?.version;

    const stringData = projectFields(cr.spec.target.template, sourceData, `${ns}/${name}`);

    await deps.kube.applySecret({
      namespace: ns,
      name: cr.spec.target.name,
      type: cr.spec.target.type ?? "Opaque",
      stringData,
      ownerReferences: ownerRefFor(cr),
    });

    const nowIso = new Date(deps.now()).toISOString();
    await deps.kube.patchArcSecretStatus(ns, name, {
      lastSyncTime: nowIso,
      observedVersion,
      conditions: [condition("Synced", "True", "ReconcileSucceeded", `synced KV version ${observedVersion ?? "?"}`, nowIso)],
    });
    return { ok: true, message: "synced", nextRunAtMs: deps.now() + intervalSec * 1000 };
  } catch (err) {
    const nowIso = new Date(deps.now()).toISOString();
    // Best-effort status patch; if patching itself fails we still surface the original.
    await deps.kube
      .patchArcSecretStatus(ns, name, {
        conditions: [condition("Synced", "False", "ReconcileFailed", (err as Error).message, nowIso)],
      })
      .catch(() => undefined);
    return { ok: false, message: (err as Error).message, nextRunAtMs: deps.now() + intervalSec * 1000 };
  }
}

function ownerRefFor(cr: ArcSecret) {
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
