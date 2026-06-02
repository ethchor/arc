/**
 * Integration coverage for the GCP + GitHub plugins through PluginsService + EnginesService.
 * Same pattern as `aws-plugin.spec.ts` — fake clients keep these hermetic; the goal is to
 * prove the plugin host handles vendor variety, not to test the SDK adapters (which are
 * unit-tested in each plugin's own suite).
 */
import { BadRequestException } from "@nestjs/common";
import { GcpSecretsPlugin } from "@arc/plugin-gcp";
import type { GenerateAccessTokenInput, IamCredentialsClient } from "@arc/plugin-gcp";
import { GitHubAppPlugin } from "@arc/plugin-github";
import type {
  CreateInstallationTokenInput,
  GitHubAppClient,
} from "@arc/plugin-github";
import { LeaseManager } from "@arc/leasing";
import { MountRegistry, type SecretsEngine } from "@arc/secrets-engine";
import { EnginesService, type EnginesConfig } from "../engines/engines.service";
import { PluginsService } from "./plugins.service";

/** EnginesService.get returns Record<string, unknown>; narrow the `data` payload for asserts. */
function data(result: Record<string, unknown>): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

function buildHarness() {
  const registry = new MountRegistry();
  const leases = new LeaseManager();
  const enginesByMount = new Map<string, SecretsEngine>();
  const config: EnginesConfig = { client: null, registry, enginesByMount, leases };
  return {
    enginesService: new EnginesService(config),
    plugins: new PluginsService(config),
    config,
  };
}

function fakeGcpIam(): IamCredentialsClient & { calls: GenerateAccessTokenInput[] } {
  const calls: GenerateAccessTokenInput[] = [];
  return {
    calls,
    async generateAccessToken(input) {
      calls.push(input);
      return {
        accessToken: `ya29.${input.targetServiceAccount}`,
        expirationSeconds: input.lifetimeSeconds,
      };
    },
  };
}

function fakeGitHub(): GitHubAppClient & { calls: CreateInstallationTokenInput[] } {
  const calls: CreateInstallationTokenInput[] = [];
  return {
    calls,
    async createInstallationToken(input) {
      calls.push(input);
      return {
        token: `ghs_${input.installationId}`,
        expirationSeconds: 3600,
        permissions: input.permissions ?? { contents: "read" },
        repositorySelection: input.repositories ? "selected" : "all",
      };
    },
  };
}

describe("@arc/plugin-gcp end-to-end through PluginsService + EnginesService", () => {
  it("mounts, dispatches gcp/creds/<role>, surfaces an access token with renewable=false", async () => {
    const { enginesService, plugins } = buildHarness();
    const iam = fakeGcpIam();
    const gcp = new GcpSecretsPlugin(iam);

    await plugins.mountSecretsPlugin(gcp, "gcp/", {
      roles: {
        deploy: {
          targetServiceAccount: "deploy@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
          defaultTtlSeconds: 1800,
        },
      },
    });

    const mounts = await enginesService.listMounts();
    expect(mounts.find((m) => m.path === "gcp/")?.type).toBe("plugin:arc-plugin-gcp");

    const issued = await enginesService.get("gcp/creds/deploy", {});
    expect(iam.calls).toHaveLength(1);
    expect(iam.calls[0]!.targetServiceAccount).toBe("deploy@arc.iam.gserviceaccount.com");
    expect(iam.calls[0]!.lifetimeSeconds).toBe(1800);
    expect(iam.calls[0]!.scopes).toEqual(["https://www.googleapis.com/auth/cloud-platform"]);
    expect(data(issued).access_token).toMatch(/^ya29\./);
    expect(data(issued).scopes).toEqual(["https://www.googleapis.com/auth/cloud-platform"]);
    expect(issued.renewable).toBe(false);
    expect(issued.lease_duration).toBeGreaterThanOrEqual(1799);
  });

  it("refuses to renew a GCP-issued lease and supports unmount + lease revocation", async () => {
    const { enginesService, plugins, config } = buildHarness();
    const gcp = new GcpSecretsPlugin(fakeGcpIam());
    await plugins.mountSecretsPlugin(gcp, "gcp/", {
      roles: {
        app: {
          targetServiceAccount: "app@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      },
    });

    const issued = await enginesService.get("gcp/creds/app", {});
    await expect(enginesService.renewLease(issued.lease_id as string)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(await plugins.unmount("arc-plugin-gcp")).toBe(true);
    expect((await enginesService.listMounts()).map((m) => m.path)).not.toContain("gcp/");
    expect(config.leases.state(issued.lease_id as string)).toBe("revoked");
  });

  it("rejects invalid GCP config at mount time without leaving the plugin half-registered", async () => {
    const { plugins } = buildHarness();
    const gcp = new GcpSecretsPlugin(fakeGcpIam());
    await expect(
      // No `roles` map.
      plugins.mountSecretsPlugin(gcp, "gcp/", { region: "x" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(plugins.has("arc-plugin-gcp")).toBe(false);
  });
});

describe("@arc/plugin-github end-to-end through PluginsService + EnginesService", () => {
  const STUB_PEM = "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----\n";

  it("mounts, dispatches github/creds/<role>, returns an installation token with the install id", async () => {
    const { enginesService, plugins } = buildHarness();
    const gh = fakeGitHub();
    const plugin = new GitHubAppPlugin(gh);

    await plugins.mountSecretsPlugin(plugin, "github/", {
      appId: 1,
      privateKeyPem: STUB_PEM,
      roles: {
        deploy: {
          installationId: 555,
          repositories: ["acme/api"],
          permissions: { contents: "write" },
        },
      },
    });

    const mounts = await enginesService.listMounts();
    expect(mounts.find((m) => m.path === "github/")?.type).toBe("plugin:arc-plugin-github");

    const issued = await enginesService.get("github/creds/deploy", {});
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]!.installationId).toBe(555);
    expect(gh.calls[0]!.repositories).toEqual(["acme/api"]);
    expect(data(issued).token).toBe("ghs_555");
    expect(data(issued).installation_id).toBe(555);
    expect(data(issued).repository_selection).toBe("selected");
    expect(issued.renewable).toBe(false);
    expect(issued.lease_duration).toBeGreaterThanOrEqual(3599);
  });

  it("refuses to renew a GitHub-issued lease + revokeLease delegates the no-op", async () => {
    const { enginesService, plugins, config } = buildHarness();
    const gh = fakeGitHub();
    const plugin = new GitHubAppPlugin(gh);
    await plugins.mountSecretsPlugin(plugin, "github/", {
      appId: 1,
      privateKeyPem: STUB_PEM,
      roles: { r: { installationId: 1 } },
    });

    const issued = await enginesService.get("github/creds/r", {});
    await expect(enginesService.renewLease(issued.lease_id as string)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await enginesService.revokeLease(issued.lease_id as string);
    expect(config.leases.state(issued.lease_id as string)).toBe("revoked");
    // revoke didn't round-trip to GitHub — the only GH call was the issue.
    expect(gh.calls).toHaveLength(1);
  });

  it("rejects invalid GitHub config (no appId) at mount time", async () => {
    const { plugins } = buildHarness();
    const plugin = new GitHubAppPlugin(fakeGitHub());
    await expect(
      plugins.mountSecretsPlugin(plugin, "github/", {
        privateKeyPem: STUB_PEM,
        roles: { r: { installationId: 1 } },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(plugins.has("arc-plugin-github")).toBe(false);
  });
});

describe("Plugin host handles multiple vendors mounted side-by-side", () => {
  it("AWS-style + GCP-style + GitHub-style plugins all dispatch independently from the same registry", async () => {
    const { enginesService, plugins } = buildHarness();
    const gcp = new GcpSecretsPlugin(fakeGcpIam());
    const gh = new GitHubAppPlugin(fakeGitHub());
    await plugins.mountSecretsPlugin(gcp, "gcp/", {
      roles: {
        r: {
          targetServiceAccount: "x@arc.iam.gserviceaccount.com",
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      },
    });
    await plugins.mountSecretsPlugin(gh, "github/", {
      appId: 1,
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
      roles: { r: { installationId: 1 } },
    });

    const paths = (await enginesService.listMounts()).map((m) => m.path).sort();
    expect(paths).toEqual(["gcp/", "github/"]);

    const gcpResult = await enginesService.get("gcp/creds/r", {});
    const ghResult = await enginesService.get("github/creds/r", {});
    expect(data(gcpResult).access_token).toMatch(/^ya29\./);
    expect(data(ghResult).token).toMatch(/^ghs_/);
    expect(gcpResult.lease_id).not.toBe(ghResult.lease_id);
  });
});
