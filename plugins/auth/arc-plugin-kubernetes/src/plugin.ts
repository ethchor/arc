import type { AuthPlugin, AuthResult, LoginRequest, PluginMeta } from "@arc/plugin-sdk";
import type { KubernetesPluginConfig, KubernetesRoleConfig, TokenReviewer } from "./types";

const PLUGIN_NAME = "arc-plugin-kubernetes";
const PLUGIN_VERSION = "0.0.0";
const DEFAULT_TTL = 3600;
const SA_USERNAME = /^system:serviceaccount:(?<namespace>[^:]+):(?<name>.+)$/;

/**
 * Kubernetes auth method. Implements `@arc/plugin-sdk`'s `AuthPlugin`; the plugin host mounts
 * it under `auth/<mount>/` and routes `POST /v1/auth/<mount>/login` into `login()`.
 *
 * A login carries `{ role, jwt }` where `jwt` is the caller's ServiceAccount token. The
 * plugin submits it to the cluster's TokenReview API via the injected {@link TokenReviewer},
 * then enforces the role's bound namespaces + service-account names before resolving arc
 * policies.
 *
 * Security invariants:
 *  - Authentication is delegated to the cluster (TokenReview) — the plugin never inspects the
 *    token's signature itself, so a forged token is rejected by the API server.
 *  - Policies come from the *role*, never the token, so a workload can't escalate by minting
 *    a token with extra claims.
 */
export class KubernetesAuthPlugin implements AuthPlugin {
  readonly meta: PluginMeta = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    kind: "auth",
    description: "Kubernetes ServiceAccount authentication (TokenReview)",
  };

  private config: KubernetesPluginConfig | undefined;

  constructor(private readonly reviewer: TokenReviewer) {}

  async configure(input: unknown): Promise<void> {
    this.config = validateConfig(input);
  }

  async login(req: LoginRequest): Promise<AuthResult> {
    if (!this.config) throw new Error("kubernetes plugin not configured; call configure() first");

    const roleName = stringCred(req.credentials, "role");
    const jwt = stringCred(req.credentials, "jwt");
    const role = this.config.roles[roleName];
    if (!role) throw new Error(`unknown role: ${roleName}`);

    const review = await this.reviewer.review(jwt, role.audiences);
    if (!review.authenticated) {
      throw new Error(`kubernetes: token did not authenticate${review.error ? `: ${review.error}` : ""}`);
    }

    const match = review.username ? SA_USERNAME.exec(review.username) : null;
    if (!match?.groups) {
      throw new Error(`kubernetes: not a ServiceAccount token (user "${review.username ?? "(none)"}")`);
    }
    const namespace = match.groups.namespace as string;
    const name = match.groups.name as string;

    if (!allowed(role.boundNamespaces, namespace)) {
      throw new Error(`kubernetes role ${roleName}: namespace "${namespace}" not permitted`);
    }
    if (!allowed(role.boundServiceAccountNames, name)) {
      throw new Error(`kubernetes role ${roleName}: service account "${name}" not permitted`);
    }

    const metadata: Record<string, string> = { role: roleName, namespace, serviceAccountName: name };
    if (review.uid) metadata.uid = review.uid;

    return {
      identityId: review.username as string,
      alias: review.username as string,
      policies: [...role.policies],
      tokenTtlSeconds: role.tokenTtlSeconds ?? DEFAULT_TTL,
      metadata,
    };
  }

  configuredRoles(): string[] {
    return this.config ? Object.keys(this.config.roles) : [];
  }
}

/** A bound list permits `value` when it contains the value, or the `*` wildcard. */
function allowed(list: string[], value: string): boolean {
  return list.includes("*") || list.includes(value);
}

function stringCred(creds: Record<string, unknown>, key: string): string {
  const v = creds[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`kubernetes login requires a non-empty "${key}" credential`);
  }
  return v;
}

function validateConfig(raw: unknown): KubernetesPluginConfig {
  if (!raw || typeof raw !== "object") throw new Error("kubernetes plugin config must be an object");
  const obj = raw as Record<string, unknown>;
  if (!obj.roles || typeof obj.roles !== "object") {
    throw new Error("kubernetes plugin config requires a `roles` map");
  }
  const roles: Record<string, KubernetesRoleConfig> = {};
  for (const [name, rawRole] of Object.entries(obj.roles as Record<string, unknown>)) {
    if (!rawRole || typeof rawRole !== "object") throw new Error(`kubernetes role ${name}: must be an object`);
    const r = rawRole as Record<string, unknown>;
    const boundServiceAccountNames = stringArray(r.boundServiceAccountNames, `${name}.boundServiceAccountNames`);
    const boundNamespaces = stringArray(r.boundNamespaces, `${name}.boundNamespaces`);
    const policies = stringArray(r.policies, `${name}.policies`);
    if (policies.length === 0) throw new Error(`kubernetes role ${name}: requires at least one policy`);
    const role: KubernetesRoleConfig = { boundServiceAccountNames, boundNamespaces, policies };
    if (r.audiences !== undefined) role.audiences = stringArray(r.audiences, `${name}.audiences`);
    if (r.tokenTtlSeconds !== undefined) {
      const ttl = Number(r.tokenTtlSeconds);
      if (!Number.isInteger(ttl) || ttl <= 0) throw new Error(`kubernetes role ${name}: tokenTtlSeconds must be a positive integer`);
      role.tokenTtlSeconds = ttl;
    }
    roles[name] = role;
  }
  if (Object.keys(roles).length === 0) throw new Error("kubernetes plugin config requires at least one role");
  return { roles };
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`kubernetes config ${label} must be an array`);
  return value.map((v, i) => {
    if (typeof v !== "string") throw new Error(`kubernetes config ${label}[${i}] must be a string`);
    return v;
  });
}
