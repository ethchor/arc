/**
 * Custom-resource shapes the operator watches. Numeric defaults come from the CRD's
 * openAPIV3Schema — the kube-apiserver fills them in before we see the resource — but the
 * operator still treats them as optional in TS to stay forward-compatible if the schema
 * changes without an operator redeploy.
 */

export interface ObjectMeta {
  name: string;
  namespace: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
}

export type ConditionStatus = "True" | "False" | "Unknown";

export interface Condition {
  type: string;
  status: ConditionStatus;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

/** ----- ArcSecret ----------------------------------------------------------- */

export interface ArcSecretSource {
  mount?: string;
  path: string;
  version?: number;
}

export interface ArcSecretTarget {
  name: string;
  type?: string;
  /** Map of secret-key → template string. Omit to copy fields verbatim. */
  template?: Record<string, string>;
}

export interface ArcSecretSpec {
  source: ArcSecretSource;
  target: ArcSecretTarget;
  refreshIntervalSeconds?: number;
}

export interface ArcSecretStatus {
  lastSyncTime?: string;
  observedVersion?: number;
  conditions?: Condition[];
}

export interface ArcSecret {
  apiVersion: "arc.io/v1alpha1";
  kind: "ArcSecret";
  metadata: ObjectMeta;
  spec: ArcSecretSpec;
  status?: ArcSecretStatus;
}

/** ----- ArcDynamicCredential ------------------------------------------------ */

export interface DynamicSource {
  mount: string;
  role: string;
  ttlSeconds?: number;
}

export interface DynamicTarget {
  name: string;
  type?: string;
  template?: Record<string, string>;
}

export interface DynamicSpec {
  source: DynamicSource;
  target: DynamicTarget;
  refreshLeadSeconds?: number;
}

export interface DynamicStatus {
  leaseId?: string;
  expiresAt?: string;
  lastIssueTime?: string;
  conditions?: Condition[];
}

export interface ArcDynamicCredential {
  apiVersion: "arc.io/v1alpha1";
  kind: "ArcDynamicCredential";
  metadata: ObjectMeta;
  spec: DynamicSpec;
  status?: DynamicStatus;
}
