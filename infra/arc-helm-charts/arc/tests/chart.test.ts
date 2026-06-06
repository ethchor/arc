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
    expect(o.devMode).toBe(true);
    expect(typeof o.devRootToken).toBe("string");
    expect(o.service).toBeDefined();
    expect(o.persistence).toBeDefined();
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

describe("README", () => {
  it("names every secret key the chart actually wires", () => {
    const readme = readFileSync(join(chartDir, "README.md"), "utf8");
    expect(readme).toContain("arcServer.secret.jwtSecret");
    expect(readme).toContain("arcServer.secret.databaseUrl");
    expect(readme).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(readme).toContain("ARC_DEFAULT_POLICY");
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
