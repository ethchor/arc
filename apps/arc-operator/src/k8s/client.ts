/**
 * Narrow Kubernetes API surface the reconcilers actually use. Keeping this small means tests
 * inject a tiny in-memory fake instead of mocking the whole `@kubernetes/client-node`
 * surface, and an alternate transport (e.g. service-to-service in-process) could swap in.
 */
import type { ArcDynamicCredential, ArcSecret } from "../types.js";

export interface SecretApplySpec {
  namespace: string;
  name: string;
  type?: string;
  /** Plaintext key/value map; we base64-encode at write time. */
  stringData: Record<string, string>;
  /** Owner metadata so `kubectl get arc...` cleanup propagates via OwnerReferences. */
  ownerReferences?: {
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
    controller?: boolean;
    blockOwnerDeletion?: boolean;
  }[];
}

export interface ArcSecretStatusPatch {
  lastSyncTime?: string;
  observedVersion?: number;
  conditions?: { type: string; status: "True" | "False" | "Unknown"; reason?: string; message?: string; lastTransitionTime?: string }[];
}

export interface ArcDynamicCredentialStatusPatch {
  leaseId?: string;
  expiresAt?: string;
  lastIssueTime?: string;
  conditions?: { type: string; status: "True" | "False" | "Unknown"; reason?: string; message?: string; lastTransitionTime?: string }[];
}

export interface KubeClient {
  /** Apply (create or update) a K8s Secret. Idempotent. */
  applySecret(spec: SecretApplySpec): Promise<void>;
  /** List ArcSecret CRs across all namespaces the operator can see. */
  listArcSecrets(): Promise<ArcSecret[]>;
  /** List ArcDynamicCredential CRs across all namespaces the operator can see. */
  listArcDynamicCredentials(): Promise<ArcDynamicCredential[]>;
  /** Patch the `.status` subresource of an ArcSecret. */
  patchArcSecretStatus(namespace: string, name: string, status: ArcSecretStatusPatch): Promise<void>;
  /** Patch the `.status` subresource of an ArcDynamicCredential. */
  patchArcDynamicCredentialStatus(namespace: string, name: string, status: ArcDynamicCredentialStatusPatch): Promise<void>;
}
