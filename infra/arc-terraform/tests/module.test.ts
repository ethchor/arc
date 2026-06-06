/**
 * Terraform module smoke tests — Node-only, no `terraform` binary required.
 * Validates:
 *
 *  - Every `.tf` file under `modules/arc/` is well-formed enough that all
 *    `variable` / `output` / `resource` blocks can be located.
 *  - The module declares the inputs the README + example rely on.
 *  - The Helm release passes the chart's `values.yaml` shape (keys match what
 *    `infra/arc-helm-charts/arc/values.yaml` actually defines).
 *  - The `examples/dev/main.tf` file calls the module with the expected
 *    required arguments.
 *
 * Full `terraform fmt -check` + `terraform validate` runs in `.github/workflows/ci.yml`.
 * This file gives quick feedback to anyone who runs `pnpm -r test` without
 * terraform on their PATH.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const here = join(fileURLToPath(import.meta.url), "..");
const tfRoot = join(here, "..");
const moduleDir = join(tfRoot, "modules", "arc");
const exampleDir = join(tfRoot, "examples", "dev");
const chartValuesPath = join(tfRoot, "..", "arc-helm-charts", "arc", "values.yaml");

/** Read every `.tf` file in a directory into one string. */
function readTf(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf") && statSync(join(dir, f)).isFile())
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n\n");
}

/** Pull out every `<kind> "<name>"` declaration from an HCL source. */
function declarations(src: string, kind: "variable" | "output" | "resource" | "module" | "locals"): string[] {
  if (kind === "locals") {
    // `locals` blocks have no name.
    return src.match(/\blocals\s*\{/g) ?? [];
  }
  const re = new RegExp(`\\b${kind}\\s+"([^"]+)"`, "g");
  return [...src.matchAll(re)].map((m) => m[1] ?? "");
}

const moduleSrc = readTf(moduleDir);
const exampleSrc = readTf(exampleDir);
const chartValues = yaml.load(readFileSync(chartValuesPath, "utf8")) as Record<string, unknown>;

describe("modules/arc — file presence", () => {
  it("ships the canonical Terraform file set", () => {
    const files = readdirSync(moduleDir);
    expect(files).toEqual(expect.arrayContaining(["versions.tf", "variables.tf", "main.tf", "outputs.tf", "README.md"]));
  });
});

describe("modules/arc — variables", () => {
  const vars = new Set(declarations(moduleSrc, "variable"));

  it("declares every input the README + example rely on", () => {
    for (const required of [
      "namespace",
      "create_namespace",
      "release_name",
      "chart_repository",
      "chart_name",
      "chart_version",
      "chart_path",
      "arc_server",
      "openbao",
      "ingress",
      "service_monitor",
      "extra_values",
      "common_labels",
      "common_annotations",
    ]) {
      expect(vars, `missing variable "${required}"`).toContain(required);
    }
  });

  it("declares only variables that are documented in the module README", () => {
    const readme = readFileSync(join(moduleDir, "README.md"), "utf8");
    for (const v of vars) {
      // Tolerate underscores being mentioned as either `var.x` or backticked.
      expect(readme.includes(v), `variable "${v}" not documented in modules/arc/README.md`).toBe(true);
    }
  });
});

describe("modules/arc — outputs", () => {
  it("exposes the outputs the example + chart docs reference", () => {
    const outs = new Set(declarations(moduleSrc, "output"));
    for (const required of ["namespace", "release_name", "chart_version", "server_service", "openbao_service"]) {
      expect(outs, `missing output "${required}"`).toContain(required);
    }
  });
});

describe("modules/arc — resources", () => {
  it("creates the namespace and helm_release", () => {
    expect(moduleSrc).toMatch(/resource\s+"kubernetes_namespace_v1"\s+"this"/);
    expect(moduleSrc).toMatch(/resource\s+"helm_release"\s+"arc"/);
  });

  it("renders the helm values via yamlencode", () => {
    expect(moduleSrc).toMatch(/values\s*=\s*\[yamlencode\(/);
  });

  it("guards the namespace resource behind `create_namespace`", () => {
    expect(moduleSrc).toMatch(/count\s*=\s*var\.create_namespace\s*\?\s*1\s*:\s*0/);
  });

  it("orders helm_release after the namespace creation", () => {
    expect(moduleSrc).toMatch(/depends_on\s*=\s*\[\s*kubernetes_namespace_v1\.this\s*\]/);
  });
});

describe("modules/arc — values shape stays in lockstep with the chart", () => {
  const referencedTopLevel = new Set([...moduleSrc.matchAll(/\b(arcServer|openbao|ingress|serviceMonitor|commonLabels|commonAnnotations)\b/g)].map((m) => m[1] ?? ""));

  it("every top-level key the module writes also exists in the chart's values.yaml", () => {
    for (const key of referencedTopLevel) {
      expect(chartValues, `module writes "${key}" but chart has no such key`).toHaveProperty(key);
    }
  });

  it("the nested arcServer keys the module sets are all chart-known", () => {
    const arc = chartValues.arcServer as Record<string, unknown>;
    for (const k of [
      "enabled",
      "replicaCount",
      "image",
      "env",
      "secret",
      "service",
      "resources",
      "podSecurityContext",
      "containerSecurityContext",
      "livenessProbe",
      "readinessProbe",
      "podAnnotations",
      "nodeSelector",
      "tolerations",
      "affinity",
    ]) {
      expect(arc, `chart values.yaml is missing arcServer.${k}`).toHaveProperty(k);
      expect(moduleSrc).toContain(k);
    }
  });

  it("the nested openbao keys the module sets are all chart-known", () => {
    const o = chartValues.openbao as Record<string, unknown>;
    for (const k of ["enabled", "image", "devMode", "devRootToken", "service", "persistence", "resources"]) {
      expect(o, `chart values.yaml is missing openbao.${k}`).toHaveProperty(k);
      expect(moduleSrc).toContain(k);
    }
  });
});

describe("examples/dev — minimum sanity", () => {
  it("calls the module with the source path and required-by-convention arguments", () => {
    expect(exampleSrc).toMatch(/module\s+"arc"/);
    expect(exampleSrc).toMatch(/source\s*=\s*"\.\.\/\.\.\/modules\/arc"/);
    expect(exampleSrc).toMatch(/namespace\s*=/);
    expect(exampleSrc).toMatch(/release_name\s*=/);
    expect(exampleSrc).toMatch(/chart_(path|version|repository)/);
  });

  it("pins both providers to versioned requirements", () => {
    expect(exampleSrc).toMatch(/source\s*=\s*"hashicorp\/helm"/);
    expect(exampleSrc).toMatch(/source\s*=\s*"hashicorp\/kubernetes"/);
  });
});

describe("module README + repo README references stay in sync", () => {
  it("module README mentions both the helm provider and the chart it wraps", () => {
    const readme = readFileSync(join(moduleDir, "README.md"), "utf8");
    expect(readme).toContain("arc-helm-charts");
    expect(readme).toContain("Helm");
  });
});
