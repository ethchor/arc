/**
 * Helm chart smoke tests — Node-only, no `helm` binary required. Validates:
 *
 *  - Chart.yaml + values.yaml parse to expected shapes.
 *  - Every file under `templates/` is either a partial (filename starts with `_`),
 *    a NOTES.txt, or a Go-templated YAML document referencing only values that exist
 *    in `values.yaml`.
 *  - The README's "production checklist" stays in sync with the values it names.
 *
 * Full `helm lint` + `helm template` are run by `.github/workflows/ci.yml`. This file
 * catches breakage during normal `pnpm -r test` runs so a contributor without helm
 * installed still gets quick feedback.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const chartDir = join(fileURLToPath(import.meta.url), "..", "..");
const templatesDir = join(chartDir, "templates");

const chart = yaml.load(readFileSync(join(chartDir, "Chart.yaml"), "utf8")) as Record<string, unknown>;
const values = yaml.load(readFileSync(join(chartDir, "values.yaml"), "utf8")) as Record<string, unknown>;

describe("Chart.yaml", () => {
  it("has all required fields", () => {
    expect(chart.apiVersion).toBe("v2");
    expect(chart.name).toBe("arc");
    expect(chart.type).toBe("application");
    expect(typeof chart.version).toBe("string");
    expect(typeof chart.appVersion).toBe("string");
    expect(chart.kubeVersion).toMatch(/^[><=]+\d/);
  });
});

describe("values.yaml", () => {
  it("has the top-level sections every template references", () => {
    expect(values.arcServer).toBeDefined();
    expect(values.openbao).toBeDefined();
    expect(values.ingress).toBeDefined();
    expect(values.serviceMonitor).toBeDefined();
  });

  it("arcServer block has the keys referenced by server-deployment.yaml + secret.yaml", () => {
    const s = values.arcServer as Record<string, unknown>;
    expect(s.enabled).toBe(true);
    expect(s.replicaCount).toBeTypeOf("number");
    expect(s.image).toBeDefined();
    expect(s.env).toBeDefined();
    expect(s.secret).toBeDefined();
    expect(s.service).toBeDefined();
    expect(s.resources).toBeDefined();
    expect(s.podSecurityContext).toBeDefined();
    expect(s.containerSecurityContext).toBeDefined();
    expect(s.livenessProbe).toBeDefined();
    expect(s.readinessProbe).toBeDefined();
  });

  it("openbao block has the keys referenced by openbao-statefulset.yaml", () => {
    const o = values.openbao as Record<string, unknown>;
    expect(o.enabled).toBe(true);
    expect(o.image).toBeDefined();
    // HIGH-B (untrusted-code audit): the secure default is NON-dev mode. dev mode runs
    // OpenBao in-memory (loses every secret on restart) with a well-known root token, so
    // a `helm install` with defaults must NOT ship a dev-mode Engine-A.
    expect(o.devMode).toBe(false);
    expect(typeof o.devRootToken).toBe("string"); // still present, only used when devMode=true
    expect(o.service).toBeDefined();
    expect(o.persistence).toBeDefined();
  });

  it("pins the OpenBao image to a concrete tag, never the mutable `latest`", () => {
    const img = (values.openbao as Record<string, unknown>).image as Record<string, unknown>;
    expect(img.tag).toBeTypeOf("string");
    expect(img.tag).not.toBe("latest");
    expect((img.tag as string).length).toBeGreaterThan(0);
  });
});

describe("templates/", () => {
  // Every template file. Helpers (filename starting with `_`) and the NOTES file are
  // not Kubernetes objects.
  const files = readdirSync(templatesDir).filter((f) => statSync(join(templatesDir, f)).isFile());

  it("contains every required file", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "_helpers.tpl",
        "secret.yaml",
        "server-deployment.yaml",
        "server-service.yaml",
        "openbao-statefulset.yaml",
        "openbao-service.yaml",
        "ingress.yaml",
        "servicemonitor.yaml",
        // ops components (operator + agent + mcp-server)
        "mcp-server-deployment.yaml",
        "mcp-server-service.yaml",
        "operator-deployment.yaml",
        "operator-rbac.yaml",
        "agent-configmap.yaml",
        "NOTES.txt",
      ]),
    );
  });

  it.each(files.filter((f) => f.endsWith(".yaml")))("%s — top-level keys + .Values refs look sane", (file) => {
    const body = readFileSync(join(templatesDir, file), "utf8");
    // Each chart resource must have an apiVersion + kind. We can't run the Go template
    // engine here, but those literals are always present in the raw source.
    expect(body).toMatch(/apiVersion:/);
    expect(body).toMatch(/kind:/);

    // Catch typos in `.Values.<key>` paths. Build a flat set of every existing values
    // path (depth-first) and assert every dotted ref appears in it.
    const refs = [...body.matchAll(/\.Values\.([a-zA-Z][a-zA-Z0-9_.]*)/g)].map((m) => m[1] ?? "");
    const seen = new Set<string>();
    walk(values, "", seen);
    for (const ref of refs) {
      const prefixes = ref.split(".").map((_, i, arr) => arr.slice(0, i + 1).join("."));
      const ok = prefixes.some((p) => seen.has(p));
      expect(ok, `${file} references .Values.${ref} but no such key exists in values.yaml`).toBe(true);
    }
  });
});

describe("openbao production-safety guard (HIGH-B)", () => {
  const statefulset = readFileSync(join(templatesDir, "openbao-statefulset.yaml"), "utf8");

  it("fails the render when devMode=true is combined with NODE_ENV=production", () => {
    // The dangerous combination is "production arc-server talking to a dev-mode (in-memory,
    // root-token) OpenBao". A `fail` guard makes that combination un-renderable instead of
    // silently insecure.
    expect(statefulset).toMatch(/\{\{-?\s*fail\b/);
    expect(statefulset).toContain(".Values.openbao.devMode");
    expect(statefulset).toContain("NODE_ENV");
  });

  it("still supports an explicit dev-mode trial (devMode=true requires NODE_ENV != production)", () => {
    // The guard couples the two: a developer opts into dev OpenBao AND dev arc-server
    // together. The template keeps the `server -dev` branch for that path.
    expect(statefulset).toContain('args: ["server", "-dev"]');
  });
});

describe("ops components values", () => {
  it("ships operator / mcpServer / agent blocks the templates reference", () => {
    const op = values.operator as Record<string, unknown>;
    expect(op.enabled).toBe(false); // off by default
    expect(op.image).toBeDefined();
    expect(op.auth).toBeDefined();
    expect(op.serviceAccount).toBeDefined();
    expect(op.rbac).toBeDefined();

    const mcp = values.mcpServer as Record<string, unknown>;
    expect(mcp.enabled).toBe(false);
    expect(mcp.image).toBeDefined();
    expect((mcp.service as Record<string, unknown>).port).toBe(8800);

    const agent = values.agent as Record<string, unknown>;
    expect((agent.sampleConfig as Record<string, unknown>).enabled).toBe(false);
    expect(agent.auth).toBeDefined();
  });

  it("operator RBAC grants secrets + the CRD + status verbs, nothing broader", () => {
    const rbac = readFileSync(join(templatesDir, "operator-rbac.yaml"), "utf8");
    expect(rbac).toMatch(/kind:\s*ClusterRole\b/);
    expect(rbac).toMatch(/kind:\s*ClusterRoleBinding\b/);
    expect(rbac).toContain('resources: ["secrets"]');
    expect(rbac).toContain('resources: ["arcsecrets", "arcdynamiccredentials"]');
    expect(rbac).toContain('resources: ["arcsecrets/status", "arcdynamiccredentials/status"]');
    // No cluster-admin-style wildcards.
    expect(rbac).not.toMatch(/resources:\s*\["?\*"?\]/);
    expect(rbac).not.toMatch(/verbs:\s*\["?\*"?\]/);
  });
});

describe("CRDs", () => {
  const chartCrdsDir = join(chartDir, "crds");
  const sourceCrdsDir = join(chartDir, "..", "..", "..", "apps", "arc-operator", "crds");

  it("vendors both operator CRDs into the chart's crds/ directory", () => {
    const names = readdirSync(chartCrdsDir).sort();
    expect(names).toEqual(["arc-dynamic-credential.crd.yaml", "arc-secret.crd.yaml"]);
  });

  it.each(["arc-secret.crd.yaml", "arc-dynamic-credential.crd.yaml"])(
    "%s is byte-identical to apps/arc-operator/crds (no drift)",
    (file) => {
      const inChart = readFileSync(join(chartCrdsDir, file), "utf8");
      const inSource = readFileSync(join(sourceCrdsDir, file), "utf8");
      expect(inChart).toBe(inSource);
    },
  );
});

describe("README", () => {
  it("names every secret key the chart actually wires", () => {
    const readme = readFileSync(join(chartDir, "README.md"), "utf8");
    expect(readme).toContain("arcServer.secret.jwtSecret");
    expect(readme).toContain("arcServer.secret.databaseUrl");
    expect(readme).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(readme).toContain("ARC_DEFAULT_POLICY");
  });

  it("documents the ops components", () => {
    const readme = readFileSync(join(chartDir, "README.md"), "utf8");
    expect(readme).toContain("operator.enabled");
    expect(readme).toContain("mcpServer.enabled");
    expect(readme).toContain("agent.sampleConfig");
  });
});

/** Recursively collect dotted-path key names from a values object. */
function walk(obj: unknown, prefix: string, out: Set<string>): void {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    walk(v, path, out);
  }
}
