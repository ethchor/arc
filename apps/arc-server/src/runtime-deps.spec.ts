/**
 * Guards the production image against `MODULE_NOT_FOUND` at boot.
 *
 * Most `@arc/plugin-*` packages are **devDependencies** on purpose: arc-server never imports
 * them, it mounts them dynamically through the plugin host, so `pnpm deploy --prod` correctly
 * drops them from the image. The moment a source file `import`s one, that assumption breaks —
 * the build and the whole test suite still pass, because locally every workspace package is
 * linked, and the failure only appears when the production-only tree is carved out and the
 * container dies on startup.
 *
 * That is exactly how `@arc/plugin-oidc` shipped broken once (account login imports its JWKS
 * verifier). This test compares what `src/` actually imports against what package.json
 * promises will be installed in production.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const appDir = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** Every non-test .ts file under src/ — test files may legitimately use devDependencies. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts") && !entry.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/** `@arc/x` and `@arc/x/sub` both resolve to the `@arc/x` package. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return parts.slice(0, 2).join("/");
}

describe("runtime @arc/* imports are production dependencies", () => {
  const imported = new Map<string, string>(); // package -> first file that imports it

  for (const file of sourceFiles(join(appDir, "src"))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:from|require\()\s*["'](@arc\/[^"']+)["']/g)) {
      const pkgName = packageOf(m[1] as string);
      if (!imported.has(pkgName)) imported.set(pkgName, file.slice(appDir.length + 1));
    }
  }

  it("finds @arc/* imports to check", () => {
    expect(imported.size).toBeGreaterThan(0);
  });

  it("declares every imported @arc/* package in dependencies, not devDependencies", () => {
    const misplaced = [...imported.entries()]
      .filter(([name]) => pkg.dependencies[name] === undefined)
      .map(([name, file]) => ({
        package: name,
        importedBy: file,
        declaredIn: pkg.devDependencies[name] !== undefined ? "devDependencies" : "(undeclared)",
      }));

    // Named explicitly so a failure reads as the deployment bug it is, not a lint nit.
    expect(misplaced).toEqual([]);
  });
});
