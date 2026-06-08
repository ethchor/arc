/**
 * Integration spec for the second batch of plugins (Azure / GitLab / Bitbucket) through
 * PluginsService + EnginesService. Same shape as `aws-plugin.spec.ts` and
 * `cloud-scm-plugins.spec.ts` — fake clients keep these hermetic; the goal is to prove
 * the plugin host handles vendor variety, not to retest the SDK adapters that have their
 * own unit suites.
 */
import { BadRequestException } from "@nestjs/common";
import { AzureSecretsPlugin } from "@arc/plugin-azure";
import type { AcquireTokenInput, AzureTokenClient } from "@arc/plugin-azure";
import { GitLabSecretsPlugin } from "@arc/plugin-gitlab";
import type {
  CreateProjectTokenInput,
  CreateProjectTokenOutput,
  GitLabClient,
} from "@arc/plugin-gitlab";
import { BitbucketSecretsPlugin } from "@arc/plugin-bitbucket";
import type {
  BitbucketClient,
  CreateRepoTokenInput,
  CreateRepoTokenOutput,
} from "@arc/plugin-bitbucket";
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import { EnginesService, type EnginesConfig } from "../engines/engines.service";
import { PluginsService } from "./plugins.service";
import { PluginManifestService } from "./plugin-manifest.service";

function data(result: Record<string, unknown>): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

function buildHarness() {
  const registry = new MountRegistry();
  const leases = new LeaseManager();
  const enginesByMount = new Map<string, SecretsEngine>();
  const config: EnginesConfig = { client: null, registry, enginesByMount, leases, manifestCapsByMount: new Map() };
  return {
    enginesService: new EnginesService(config),
    plugins: new PluginsService(config, new PluginManifestService()),
    config,
  };
}

function fakeAad(): AzureTokenClient & { calls: AcquireTokenInput[] } {
  const calls: AcquireTokenInput[] = [];
  return {
    calls,
    async acquireToken(input) {
      calls.push(input);
      return {
        accessToken: `eyJ.${input.clientId}.${input.scope}`,
        expirationSeconds: 3600,
        scope: input.scope,
      };
    },
  };
}

function fakeGitLab(): GitLabClient & {
  createCalls: CreateProjectTokenInput[];
  revokeCalls: Array<{ projectId: string; tokenId: number }>;
} {
  const createCalls: CreateProjectTokenInput[] = [];
  const revokeCalls: Array<{ projectId: string; tokenId: number }> = [];
  let nextId = 1000;
  return {
    createCalls,
    revokeCalls,
    async createProjectToken(input): Promise<CreateProjectTokenOutput> {
      createCalls.push(input);
      const id = nextId++;
      return { token: `glpat-${id}-${input.name}`, expirationSeconds: 30 * 24 * 3600, tokenId: id };
    },
    async revokeProjectToken(input) {
      revokeCalls.push({ projectId: input.projectId, tokenId: input.tokenId });
    },
  };
}

function fakeBitbucket(): BitbucketClient & {
  createCalls: CreateRepoTokenInput[];
  revokeCalls: Array<{ workspace: string; repoSlug: string; tokenUuid: string }>;
} {
  const createCalls: CreateRepoTokenInput[] = [];
  const revokeCalls: Array<{ workspace: string; repoSlug: string; tokenUuid: string }> = [];
  let n = 0;
  return {
    createCalls,
    revokeCalls,
    async createRepoToken(input): Promise<CreateRepoTokenOutput> {
      createCalls.push(input);
      n++;
      return { token: `BBAT-${n}-${input.name}`, tokenUuid: `{uuid-${n}}` };
    },
    async revokeRepoToken(input) {
      revokeCalls.push({
        workspace: input.workspace,
        repoSlug: input.repoSlug,
        tokenUuid: input.tokenUuid,
      });
    },
  };
}

describe("@arc/plugin-azure end-to-end through PluginsService + EnginesService", () => {
  it("mounts, dispatches azure/creds/<role>, surfaces an AAD access token", async () => {
    const { enginesService, plugins } = buildHarness();
    const aad = fakeAad();
    const plugin = new AzureSecretsPlugin(aad);

    await plugins.mountSecretsPlugin(plugin, "azure/", {
      roles: {
        prod: {
          tenantId: "11111111-2222-3333-4444-555555555555",
          clientId: "client-id",
          clientSecret: "shh",
          scope: "https://management.azure.com/.default",
        },
      },
    });

    expect((await enginesService.listMounts()).find((m) => m.path === "azure/")?.type).toBe(
      "plugin:arc-plugin-azure",
    );

    const issued = await enginesService.get("azure/creds/prod", {});
    expect(aad.calls).toHaveLength(1);
    expect(data(issued).access_token).toMatch(/^eyJ\./);
    expect(data(issued).tenant_id).toBe("11111111-2222-3333-4444-555555555555");
    expect(issued.renewable).toBe(false);
  });

  it("refuses to renew an Azure-issued lease + revoke is a no-op at AAD", async () => {
    const { enginesService, plugins, config } = buildHarness();
    const aad = fakeAad();
    await plugins.mountSecretsPlugin(new AzureSecretsPlugin(aad), "azure/", {
      roles: { r: { tenantId: "t", clientId: "c", clientSecret: "s", scope: "x" } },
    });

    const issued = await enginesService.get("azure/creds/r", {});
    await expect(enginesService.renewLease(issued.lease_id as string)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await enginesService.revokeLease(issued.lease_id as string);
    expect(config.leases.state(issued.lease_id as string)).toBe("revoked");
    expect(aad.calls).toHaveLength(1); // no extra AAD round-trip for revoke
  });
});

describe("@arc/plugin-gitlab end-to-end through PluginsService + EnginesService", () => {
  it("mounts, dispatches gitlab/creds/<role>, surfaces a project access token", async () => {
    const { enginesService, plugins } = buildHarness();
    const gl = fakeGitLab();

    await plugins.mountSecretsPlugin(new GitLabSecretsPlugin(gl), "gitlab/", {
      adminToken: "glpat-admin",
      roles: {
        deploy: { projectId: "42", scopes: ["read_repository"], accessLevel: 30 },
      },
    });

    expect((await enginesService.listMounts()).find((m) => m.path === "gitlab/")?.type).toBe(
      "plugin:arc-plugin-gitlab",
    );

    const issued = await enginesService.get("gitlab/creds/deploy", {});
    expect(gl.createCalls).toHaveLength(1);
    expect(gl.createCalls[0]!.projectId).toBe("42");
    expect(gl.createCalls[0]!.accessLevel).toBe(30);
    expect(data(issued).token).toMatch(/^glpat-/);
    expect(data(issued).access_level).toBe(30);
    expect(issued.renewable).toBe(false);
  });

  it("revoke flows DELETE through to GitLab via the stored projectId + tokenId", async () => {
    const { enginesService, plugins, config } = buildHarness();
    const gl = fakeGitLab();
    await plugins.mountSecretsPlugin(new GitLabSecretsPlugin(gl), "gitlab/", {
      adminToken: "x",
      roles: { r: { projectId: "9", scopes: ["api"], accessLevel: 20 } },
    });

    const issued = await enginesService.get("gitlab/creds/r", {});
    await enginesService.revokeLease(issued.lease_id as string);
    expect(config.leases.state(issued.lease_id as string)).toBe("revoked");
    expect(gl.revokeCalls).toHaveLength(1);
    expect(gl.revokeCalls[0]!.projectId).toBe("9");
  });
});

describe("@arc/plugin-bitbucket end-to-end through PluginsService + EnginesService", () => {
  it("mounts, dispatches bitbucket/creds/<role>, surfaces a repo access token", async () => {
    const { enginesService, plugins } = buildHarness();
    const bb = fakeBitbucket();
    await plugins.mountSecretsPlugin(new BitbucketSecretsPlugin(bb), "bitbucket/", {
      adminToken: "BBA-admin",
      roles: { read: { workspace: "acme", repoSlug: "platform", scopes: ["repository:read"] } },
    });

    expect((await enginesService.listMounts()).find((m) => m.path === "bitbucket/")?.type).toBe(
      "plugin:arc-plugin-bitbucket",
    );

    const issued = await enginesService.get("bitbucket/creds/read", {});
    expect(bb.createCalls).toHaveLength(1);
    expect(bb.createCalls[0]!.workspace).toBe("acme");
    expect(bb.createCalls[0]!.repoSlug).toBe("platform");
    expect(data(issued).token).toMatch(/^BBAT-/);
    expect(data(issued).token_uuid).toMatch(/^\{uuid-/);
    expect(issued.renewable).toBe(false);
  });

  it("revoke flows DELETE through to Bitbucket via the stored uuid", async () => {
    const { enginesService, plugins, config } = buildHarness();
    const bb = fakeBitbucket();
    await plugins.mountSecretsPlugin(new BitbucketSecretsPlugin(bb), "bitbucket/", {
      adminToken: "x",
      roles: { r: { workspace: "acme", repoSlug: "platform", scopes: ["repository:read"] } },
    });

    const issued = await enginesService.get("bitbucket/creds/r", {});
    await enginesService.revokeLease(issued.lease_id as string);
    expect(config.leases.state(issued.lease_id as string)).toBe("revoked");
    expect(bb.revokeCalls).toHaveLength(1);
    expect(bb.revokeCalls[0]!.workspace).toBe("acme");
    expect(bb.revokeCalls[0]!.tokenUuid).toMatch(/^\{uuid-/);
  });
});

describe("All six plugins (AWS + GCP + GitHub + Azure + GitLab + Bitbucket) can co-mount", () => {
  it("each renders its own mount type, dispatches independently from the same MountRegistry", async () => {
    const { enginesService, plugins } = buildHarness();
    // The "other three" are already integration-tested in their own spec files. Here
    // we just verify the three new plugins co-exist with each other.
    await plugins.mountSecretsPlugin(new AzureSecretsPlugin(fakeAad()), "azure/", {
      roles: { r: { tenantId: "t", clientId: "c", clientSecret: "s", scope: "x" } },
    });
    await plugins.mountSecretsPlugin(new GitLabSecretsPlugin(fakeGitLab()), "gitlab/", {
      adminToken: "x",
      roles: { r: { projectId: "1", scopes: ["api"], accessLevel: 20 } },
    });
    await plugins.mountSecretsPlugin(new BitbucketSecretsPlugin(fakeBitbucket()), "bitbucket/", {
      adminToken: "x",
      roles: { r: { workspace: "a", repoSlug: "b", scopes: ["repository:read"] } },
    });
    const paths = (await enginesService.listMounts()).map((m) => m.path).sort();
    expect(paths).toEqual(["azure/", "bitbucket/", "gitlab/"]);
  });
});
