/**
 * Rasterise the source SVG icons into the PNG variants the PWA manifest +
 * iOS / Android launchers need. Idempotent — re-running just refreshes the
 * outputs against the SVG. Hook is `pnpm --filter @arc/vault-web icons:gen`.
 *
 * Why we ship PNGs at all when SVG icons are well-supported now:
 *  - iOS Safari ≤17 still needs a PNG `apple-touch-icon` for "Add to Home
 *    Screen" — SVG produces a generic icon.
 *  - Android adaptive icons want a PNG with a guaranteed safe-zone (the
 *    `maskable` purpose) so the system mask doesn't clip the brand.
 *  - Lighthouse PWA audit wants ≥192px and ≥512px PNG entries; SVGs alone
 *    fail the "Installable" check.
 *
 * The `sharp` dep stays in `devDependencies` — it's only used at
 * build/icon-regen time, never at runtime, so the production server bundle
 * doesn't pull it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

async function render(svgPath, outPath, size) {
  const svg = await readFile(svgPath);
  const png = await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(outPath, png);
  // eslint-disable-next-line no-console
  console.log(`  → ${outPath.replace(publicDir + "/", "public/")}  (${size}×${size})`);
}

const targets = [
  { src: "icon.svg", out: "icon-192.png", size: 192 },
  { src: "icon.svg", out: "icon-512.png", size: 512 },
  // iOS Safari "Add to Home Screen" — 180×180 is the size most modern iOS
  // versions request; Apple no longer cares about the named-link rel.
  { src: "icon.svg", out: "apple-touch-icon.png", size: 180 },
  // Android adaptive-icon safe-zone variant.
  { src: "icon-maskable.svg", out: "icon-maskable-512.png", size: 512 },
  // Browser tab favicon — keep 32×32 PNG alongside the SVG so older clients
  // that don't pick up <link rel="icon" type="image/svg+xml"> still get a
  // recognisable favicon.
  { src: "icon.svg", out: "favicon-32.png", size: 32 },
];

console.log("Generating PWA icons from public/icon.svg → public/*.png");
for (const t of targets) {
  await render(join(publicDir, t.src), join(publicDir, t.out), t.size);
}
console.log("Done.");
