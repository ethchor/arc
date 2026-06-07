#!/usr/bin/env node
/**
 * arc-operator entry point. Configured entirely via environment so the same binary works in
 * the helm chart, a local kind cluster, and ad-hoc kubectl runs.
 *
 *   ARC_SERVER_URL       required — base URL of the arc-server REST API
 *   ARC_AUTH_MOUNT       optional — auth method to log into (default "kubernetes")
 *   ARC_AUTH_ROLE        required — role configured on that auth mount
 *   POLL_INTERVAL_SECONDS  optional — default 30
 *
 * The operator authenticates with its own pod's ServiceAccount token via
 * `POST /v1/auth/<mount>/login` (using the Kubernetes auth plugin shipped in #7), which
 * returns an arc JWT scoped to the role's policies — that's what gates every subsequent
 * call against `@arc/grants`.
 */
import { ArcClient } from "./arc-client.js";
import { createKubeClient } from "./k8s/kube-client.js";
import { runReconcileLoop } from "./reconciler/loop.js";

function envRequired(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    process.stderr.write(`[arc-operator] missing required env var: ${name}\n`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const arcServerUrl = envRequired("ARC_SERVER_URL");
  const authMount = process.env.ARC_AUTH_MOUNT ?? "kubernetes";
  const authRole = envRequired("ARC_AUTH_ROLE");
  const pollIntervalSeconds = Number(process.env.POLL_INTERVAL_SECONDS ?? 30);

  const arc = new ArcClient({ baseUrl: arcServerUrl, authMount, authRole });
  const kube = createKubeClient();

  // Cold-start sanity: make sure we can actually log in before announcing ready. If the
  // auth method / role aren't configured correctly, fail fast rather than poll-spin.
  await arc.login();
  process.stdout.write(`[arc-operator] logged in via auth/${authMount}/${authRole}; polling every ${pollIntervalSeconds}s\n`);

  let stop = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      process.stdout.write(`[arc-operator] ${sig} received, draining...\n`);
      stop = true;
    });
  }

  await runReconcileLoop({
    arc,
    kube,
    pollIntervalSeconds,
    shouldStop: () => stop,
    onIteration: (s) => {
      process.stdout.write(
        `[arc-operator] iter: arcSecrets=${s.arcSecrets.processed}(${s.arcSecrets.failed} failed) ` +
          `dynamic=${s.dynamic.processed}(${s.dynamic.failed} failed)\n`,
      );
    },
  });
}

main().catch((err) => {
  process.stderr.write(`[arc-operator] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
