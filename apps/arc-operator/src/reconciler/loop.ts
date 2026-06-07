/**
 * Generic poll loop. Every `pollIntervalSeconds` we list both CR kinds and reconcile each
 * one in sequence. This is intentionally simple — no informer cache, no watch streams, no
 * leader election. For the first cut, polling is deterministic, easy to reason about, and
 * adequate for the secret-injection workload (latency is bounded by `pollIntervalSeconds`).
 *
 * Errors from individual reconciliations are swallowed so a single bad CR can't kill the
 * loop; each reconciler is responsible for surfacing its own failure into the CR's `.status`.
 */
import type { ArcClient } from "../arc-client.js";
import type { KubeClient } from "../k8s/client.js";
import { reconcileArcDynamicCredential } from "./arc-dynamic-credential.js";
import { reconcileArcSecret } from "./arc-secret.js";

export interface LoopOptions {
  kube: KubeClient;
  arc: ArcClient;
  pollIntervalSeconds: number;
  /** Test seam for the clock. */
  now?: () => number;
  /** Test seam for the sleep — return a promise we can resolve synchronously. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for early termination. */
  shouldStop?: () => boolean;
  /** Test seam for per-iteration callback (e.g. to assert what was reconciled). */
  onIteration?: (summary: IterationSummary) => void;
}

export interface IterationSummary {
  arcSecrets: { processed: number; failed: number };
  dynamic: { processed: number; failed: number };
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref());

export async function runReconcileLoop(opts: LoopOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const intervalMs = opts.pollIntervalSeconds * 1000;

  while (!opts.shouldStop?.()) {
    const summary: IterationSummary = { arcSecrets: { processed: 0, failed: 0 }, dynamic: { processed: 0, failed: 0 } };

    try {
      const arcSecrets = await opts.kube.listArcSecrets();
      for (const cr of arcSecrets) {
        const result = await reconcileArcSecret(cr, { kube: opts.kube, arc: opts.arc, now });
        summary.arcSecrets.processed++;
        if (!result.ok) summary.arcSecrets.failed++;
      }
    } catch {
      // listing failed; the next iteration will retry.
    }

    try {
      const dynamics = await opts.kube.listArcDynamicCredentials();
      for (const cr of dynamics) {
        const result = await reconcileArcDynamicCredential(cr, { kube: opts.kube, arc: opts.arc, now });
        summary.dynamic.processed++;
        if (!result.ok) summary.dynamic.failed++;
      }
    } catch {
      // listing failed; the next iteration will retry.
    }

    opts.onIteration?.(summary);
    if (opts.shouldStop?.()) return;
    await sleep(intervalMs);
  }
}
