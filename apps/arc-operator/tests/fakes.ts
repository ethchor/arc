/**
 * In-memory fakes for the operator's two external dependencies. Tests use these to assert
 * what the reconcilers fetched / wrote without touching the network or `@kubernetes/client-node`.
 */
import type {
  ArcDynamicCredentialStatusPatch,
  ArcSecretStatusPatch,
  KubeClient,
  SecretApplySpec,
} from "../src/k8s/client";
import type { ArcDynamicCredential, ArcSecret } from "../src/types";

export class FakeKubeClient implements KubeClient {
  arcSecrets: ArcSecret[] = [];
  dynamics: ArcDynamicCredential[] = [];
  /** Most recently applied Secret per (namespace, name). */
  appliedSecrets = new Map<string, SecretApplySpec>();
  /** Patch history per (namespace, name) for ArcSecret status. */
  arcSecretStatusPatches: { namespace: string; name: string; status: ArcSecretStatusPatch }[] = [];
  /** Patch history for ArcDynamicCredential status. */
  dynamicStatusPatches: { namespace: string; name: string; status: ArcDynamicCredentialStatusPatch }[] = [];

  async applySecret(spec: SecretApplySpec): Promise<void> {
    this.appliedSecrets.set(`${spec.namespace}/${spec.name}`, spec);
  }

  async listArcSecrets(): Promise<ArcSecret[]> {
    return this.arcSecrets;
  }

  async listArcDynamicCredentials(): Promise<ArcDynamicCredential[]> {
    return this.dynamics;
  }

  async patchArcSecretStatus(namespace: string, name: string, status: ArcSecretStatusPatch): Promise<void> {
    this.arcSecretStatusPatches.push({ namespace, name, status });
  }

  async patchArcDynamicCredentialStatus(
    namespace: string,
    name: string,
    status: ArcDynamicCredentialStatusPatch,
  ): Promise<void> {
    this.dynamicStatusPatches.push({ namespace, name, status });
  }
}

/** Stand-in for {@link ArcClient}. Records all calls; returns canned responses. */
export class FakeArcClient {
  kvGetResponses = new Map<string, { data: { data: Record<string, unknown>; metadata: { version: number } } }>();
  kvGetErrors = new Map<string, Error>();
  dynamicResponses: { data: Record<string, unknown>; lease_id: string; lease_duration: number; renewable: boolean }[] = [];
  dynamicErrors: Error[] = [];
  calls: { kind: string; payload: unknown }[] = [];
  revoked: string[] = [];
  loginCount = 0;

  async login(): Promise<string> {
    this.loginCount++;
    return "fake-jwt";
  }
  forgetToken(): void {}

  async kvGet(mount: string, path: string, version?: number) {
    const key = `${mount}|${path}|${version ?? "latest"}`;
    this.calls.push({ kind: "kvGet", payload: { mount, path, version } });
    const err = this.kvGetErrors.get(key);
    if (err) throw err;
    const hit = this.kvGetResponses.get(key);
    if (!hit) throw new Error(`fake: no canned kvGet for ${key}`);
    return hit;
  }

  async issueDynamic(mount: string, role: string, ttlSeconds?: number) {
    this.calls.push({ kind: "issueDynamic", payload: { mount, role, ttlSeconds } });
    const err = this.dynamicErrors.shift();
    if (err) throw err;
    const r = this.dynamicResponses.shift();
    if (!r) throw new Error(`fake: no canned issueDynamic`);
    return r;
  }

  async revokeLease(leaseId: string): Promise<void> {
    this.revoked.push(leaseId);
  }
}

export function makeArcSecretCR(spec: ArcSecret["spec"], opts: Partial<{ name: string; namespace: string; uid: string }> = {}): ArcSecret {
  return {
    apiVersion: "arc.io/v1alpha1",
    kind: "ArcSecret",
    metadata: {
      name: opts.name ?? "test-secret",
      namespace: opts.namespace ?? "test",
      uid: opts.uid ?? "uid-1",
    },
    spec,
  };
}

export function makeDynamicCR(
  spec: ArcDynamicCredential["spec"],
  opts: Partial<{ name: string; namespace: string; uid: string; status: ArcDynamicCredential["status"] }> = {},
): ArcDynamicCredential {
  return {
    apiVersion: "arc.io/v1alpha1",
    kind: "ArcDynamicCredential",
    metadata: {
      name: opts.name ?? "test-cred",
      namespace: opts.namespace ?? "test",
      uid: opts.uid ?? "uid-1",
    },
    spec,
    ...(opts.status ? { status: opts.status } : {}),
  };
}
