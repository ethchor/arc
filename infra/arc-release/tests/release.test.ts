/**
 * Structural checks for the release pipeline — no Docker / cosign required. Validates:
 *
 *  - `apps/arc-server/Dockerfile` is a multi-stage, non-root build that runs the deployed
 *    `node dist/main.js` and uses the `pnpm deploy --legacy` carve-out.
 *  - `.dockerignore` keeps build artifacts out of the context.
 *  - `.github/workflows/release.yml` is tag-triggered, has the GHCR + OIDC permissions, and
 *    builds → signs (cosign) → SBOMs (syft) the image.
 *  - `.github/workflows/ci.yml` builds the Dockerfile on every PR (so it can't rot) and still
 *    has the openbao-adapter / helm / terraform jobs.
 *
 * The real image build + signature happens in CI (`docker-build` job + `release.yml`); these
 * tests give fast feedback and lock the release config against silent drift — release.yml
 * only runs on tags, so a dropped cosign/SBOM step would otherwise go unnoticed until a cut.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");
const loadYaml = (rel: string): Record<string, unknown> => yaml.load(read(rel)) as Record<string, unknown>;

describe("apps/arc-server/Dockerfile", () => {
  const dockerfile = read("apps/arc-server/Dockerfile");

  it("is a multi-stage build with a build and a runtime stage", () => {
    expect(dockerfile).toMatch(/FROM\s+node:\$\{NODE_VERSION\}-\S+\s+AS\s+build/);
    expect(dockerfile).toMatch(/FROM\s+node:\$\{NODE_VERSION\}-\S+\s+AS\s+runtime/);
  });

  it("carves out a production bundle with pnpm deploy --legacy (pnpm v10 requirement)", () => {
    expect(dockerfile).toMatch(/pnpm\s+--filter\s+@arc\/server\s+deploy\s+--prod\s+--legacy\s+\/app/);
  });

  it("builds arc-server and its workspace deps before deploying", () => {
    expect(dockerfile).toMatch(/pnpm\s+--filter\s+@arc\/server\.\.\.\s+build/);
  });

  it("runs as a non-root user", () => {
    expect(dockerfile).toMatch(/USER\s+arc/);
    expect(dockerfile).toMatch(/useradd[^\n]*\barc\b/);
  });

  it("exposes the server port and launches the compiled entrypoint", () => {
    expect(dockerfile).toMatch(/EXPOSE\s+3001/);
    expect(dockerfile).toMatch(/CMD\s+\[\s*"node"\s*,\s*"dist\/main\.js"\s*\]/);
  });

  it("declares a healthcheck against /metrics", () => {
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*\/metrics/);
  });

  it("does not bake in any TLS-verification bypass", () => {
    // The sandbox needs NODE_TLS_REJECT_UNAUTHORIZED=0 to build behind its MITM proxy, but
    // that must never reach the committed image.
    expect(dockerfile).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});

describe(".dockerignore", () => {
  const ignore = read(".dockerignore");
  it("excludes node_modules and build output from the context", () => {
    expect(ignore).toMatch(/(^|\n)\*\*\/node_modules/);
    expect(ignore).toMatch(/(^|\n)\*\*\/dist/);
  });
});

describe(".github/workflows/release.yml", () => {
  const release = loadYaml(".github/workflows/release.yml");
  const raw = read(".github/workflows/release.yml");

  it("triggers on version tags", () => {
    // `on:` parses to the truthy key `true` under js-yaml's YAML 1.1 rules, so read raw.
    expect(raw).toMatch(/tags:\s*\[\s*["']v\*["']\s*\]/);
  });

  it("grants the permissions cosign keyless + GHCR push need", () => {
    const perms = release.permissions as Record<string, string>;
    expect(perms.packages).toBe("write");
    expect(perms["id-token"]).toBe("write");
  });

  it("builds from the arc-server Dockerfile and pushes", () => {
    expect(raw).toMatch(/file:\s*apps\/arc-server\/Dockerfile/);
    expect(raw).toMatch(/push:\s*true/);
  });

  it("publishes to ghcr.io/ethchor/arc-server (the image the chart references)", () => {
    expect(raw).toMatch(/REGISTRY:\s*ghcr\.io/);
    expect(raw).toMatch(/IMAGE_NAME:\s*ethchor\/arc-server/);
  });

  it("signs the image and produces an SBOM", () => {
    expect(raw).toMatch(/cosign-installer/);
    expect(raw).toMatch(/cosign\s+sign\b/);
    expect(raw).toMatch(/anchore\/sbom-action/);
    expect(raw).toMatch(/cosign\s+attest\b/);
  });
});

describe(".github/workflows/ci.yml", () => {
  const ci = loadYaml(".github/workflows/ci.yml");
  const jobs = ci.jobs as Record<string, unknown>;
  const raw = read(".github/workflows/ci.yml");

  it("builds the arc-server Dockerfile on every PR so it can't rot", () => {
    expect(jobs).toHaveProperty("docker-build");
    expect(raw).toMatch(/file:\s*apps\/arc-server\/Dockerfile/);
    expect(raw).toMatch(/push:\s*false/);
  });

  it("boots the built image and asserts /metrics serves", () => {
    expect(raw).toMatch(/curl\s+-fsS\s+http:\/\/127\.0\.0\.1:3001\/metrics/);
  });

  it("still runs the adapter / helm / terraform jobs", () => {
    for (const job of ["node", "rust", "openbao-adapter", "helm", "terraform"]) {
      expect(jobs).toHaveProperty(job);
    }
  });
});
