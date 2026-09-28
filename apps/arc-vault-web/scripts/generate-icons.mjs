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
// The desktop shell's icons are rendered here too, so every arc app icon comes from one script.
const desktopIcons = join(here, "..", "..", "arc-vault-desktop", "src-tauri", "icons");

async function png(svgPath, size) {
  const svg = await readFile(svgPath);
  return sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function render(svgPath, outPath, size) {
  await writeFile(outPath, await png(svgPath, size));
  // eslint-disable-next-line no-console
  console.log(`  → ${outPath.replace(publicDir + "/", "public/")}  (${size}×${size})`);
}

/** Windows .ico: a directory of PNG-compressed images (Windows Vista and later). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, o); // 0 means 256
    entries.writeUInt8(size >= 256 ? 0 : size, o + 1);
    entries.writeUInt16LE(1, o + 4); // colour planes
    entries.writeUInt16LE(32, o + 6); // bits per pixel
    entries.writeUInt32LE(data.length, o + 8);
    entries.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.data)]);
}

/** macOS .icns: typed chunks, each holding a PNG (macOS 10.7 and later read PNG chunks). */
function icns(chunks) {
  const body = Buffer.concat(
    chunks.map(({ type, data }) => {
      const head = Buffer.alloc(8);
      head.write(type, 0, "ascii");
      head.writeUInt32BE(data.length + 8, 4);
      return Buffer.concat([head, data]);
    }),
  );
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const targets = [
  { src: "icon.svg", out: "icon-192.png", size: 192 },
  { src: "icon.svg", out: "icon-512.png", size: 512 },
  // iOS Safari "Add to Home Screen" — 180×180 is the size most modern iOS
  // versions request; Apple no longer cares about the named-link rel. Rendered from the
  // full-bleed variant: iOS masks and tints Home Screen icons itself (docs/18 §4.9).
  { src: "icon-apple.svg", out: "apple-touch-icon.png", size: 180 },
  // Android adaptive-icon safe-zone variant.
  { src: "icon-maskable.svg", out: "icon-maskable-512.png", size: 512 },
  // Browser tab favicon — keep 32×32 PNG alongside the SVG so older clients
  // that don't pick up <link rel="icon" type="image/svg+xml"> still get a
  // recognisable favicon.
  { src: "icon.svg", out: "favicon-32.png", size: 32 },
  // App shortcuts (manifest.json "shortcuts": long-press on Android, the taskbar jump list
  // on Windows). 96×96 is the size Chrome asks for; 192×192 covers high-density screens.
  ...["search", "generate", "lock"].flatMap((name) => [
    { src: `shortcut-${name}.svg`, out: `shortcut-${name}-96.png`, size: 96 },
    { src: `shortcut-${name}.svg`, out: `shortcut-${name}-192.png`, size: 192 },
  ]),
];

console.log("Generating PWA icons from public/icon.svg → public/*.png");
for (const t of targets) {
  await render(join(publicDir, t.src), join(publicDir, t.out), t.size);
}

// Desktop shell (Tauri): the PNGs `bundle.icon` lists plus icon.png, which Tauri embeds as
// the window icon at compile time, and the macOS .icns and Windows .ico built from them.
console.log("Generating desktop icons from src-tauri/icons/icon.svg");
const desktopSvg = join(desktopIcons, "icon.svg");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const bySize = Object.fromEntries(
  await Promise.all(sizes.map(async (size) => [size, await png(desktopSvg, size)])),
);
const desktopFiles = [
  ["32x32.png", bySize[32]],
  ["64x64.png", bySize[64]],
  ["128x128.png", bySize[128]],
  ["128x128@2x.png", bySize[256]],
  ["icon.png", bySize[512]],
  ["icon.ico", ico([16, 24, 32, 48, 64, 256].map((size) => ({ size, data: bySize[size] })))],
  [
    "icon.icns",
    icns([
      { type: "icp4", data: bySize[16] },
      { type: "icp5", data: bySize[32] },
      { type: "icp6", data: bySize[64] },
      { type: "ic07", data: bySize[128] },
      { type: "ic08", data: bySize[256] },
      { type: "ic09", data: bySize[512] },
      { type: "ic10", data: bySize[1024] },
      { type: "ic11", data: bySize[32] },
      { type: "ic12", data: bySize[64] },
      { type: "ic13", data: bySize[256] },
      { type: "ic14", data: bySize[512] },
    ]),
  ],
];
for (const [name, data] of desktopFiles) {
  await writeFile(join(desktopIcons, name), data);
  console.log(`  → src-tauri/icons/${name}`);
}
console.log("Done.");
