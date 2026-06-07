/**
 * `@kubernetes/client-node`-backed implementation of {@link KubeClient}.
 *
 * Authentication: `KubeConfig.loadFromDefault()` picks up the cluster context from
 * (in order) `KUBECONFIG`, `~/.kube/config`, then the in-cluster `/var/run/secrets/...`
 * ServiceAccount mount. Same precedence the official client uses everywhere.
 *
 * RBAC the operator needs:
 *   - `secrets`            — `get`, `create`, `update`, `patch` in every namespace it serves
 *   - `arcsecrets.arc.io`   — `get`, `list`, `watch`; plus `patch` on `arcsecrets/status`
 *   - `arcdynamiccredentials.arc.io` — same shape
 */
import * as k8s from "@kubernetes/client-node";
import type {
  ArcDynamicCredentialStatusPatch,
  ArcSecretStatusPatch,
  KubeClient,
  SecretApplySpec,
} from "./client.js";
import type { ArcDynamicCredential, ArcSecret } from "../types.js";

const ARC_GROUP = "arc.io";
const ARC_VERSION = "v1alpha1";

export function createKubeClient(kc?: k8s.KubeConfig): KubeClient {
  const config = kc ?? loadKubeConfig();
  const core = config.makeApiClient(k8s.CoreV1Api);
  const custom = config.makeApiClient(k8s.CustomObjectsApi);
  return new RealKubeClient(core, custom);
}

function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  return kc;
}

class RealKubeClient implements KubeClient {
  constructor(
    private readonly core: k8s.CoreV1Api,
    private readonly custom: k8s.CustomObjectsApi,
  ) {}

  async applySecret(spec: SecretApplySpec): Promise<void> {
    const secret: k8s.V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: spec.name,
        namespace: spec.namespace,
        ownerReferences: spec.ownerReferences?.map((o) => ({
          apiVersion: o.apiVersion,
          kind: o.kind,
          name: o.name,
          uid: o.uid,
          controller: o.controller,
          blockOwnerDeletion: o.blockOwnerDeletion,
        })),
      },
      type: spec.type ?? "Opaque",
      stringData: spec.stringData,
    };

    try {
      await this.core.readNamespacedSecret({ name: spec.name, namespace: spec.namespace });
      await this.core.replaceNamespacedSecret({ name: spec.name, namespace: spec.namespace, body: secret });
    } catch (err) {
      if (httpStatus(err) === 404) {
        await this.core.createNamespacedSecret({ namespace: spec.namespace, body: secret });
        return;
      }
      throw err;
    }
  }

  async listArcSecrets(): Promise<ArcSecret[]> {
    const res = (await this.custom.listClusterCustomObject({
      group: ARC_GROUP,
      version: ARC_VERSION,
      plural: "arcsecrets",
    })) as { items?: ArcSecret[] };
    return res.items ?? [];
  }

  async listArcDynamicCredentials(): Promise<ArcDynamicCredential[]> {
    const res = (await this.custom.listClusterCustomObject({
      group: ARC_GROUP,
      version: ARC_VERSION,
      plural: "arcdynamiccredentials",
    })) as { items?: ArcDynamicCredential[] };
    return res.items ?? [];
  }

  async patchArcSecretStatus(namespace: string, name: string, status: ArcSecretStatusPatch): Promise<void> {
    await this.custom.patchNamespacedCustomObjectStatus(
      {
        group: ARC_GROUP,
        version: ARC_VERSION,
        namespace,
        plural: "arcsecrets",
        name,
        body: { status },
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
    );
  }

  async patchArcDynamicCredentialStatus(
    namespace: string,
    name: string,
    status: ArcDynamicCredentialStatusPatch,
  ): Promise<void> {
    await this.custom.patchNamespacedCustomObjectStatus(
      {
        group: ARC_GROUP,
        version: ARC_VERSION,
        namespace,
        plural: "arcdynamiccredentials",
        name,
        body: { status },
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.MergePatch),
    );
  }
}

function httpStatus(err: unknown): number | undefined {
  const status = (err as { code?: number; statusCode?: number; response?: { statusCode?: number } } | null)?.code
    ?? (err as { statusCode?: number })?.statusCode
    ?? (err as { response?: { statusCode?: number } })?.response?.statusCode;
  return typeof status === "number" ? status : undefined;
}
