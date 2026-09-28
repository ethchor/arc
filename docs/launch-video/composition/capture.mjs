// Render the composition with headless Chromium.
//
//   node capture.mjs stills <outDir> <t1> <t2> ...      one PNG per time (seconds)
//   node capture.mjs video  <out.mp4> [audio.wav]       every frame, piped straight into ffmpeg
//
// Needs Node 18+, ffmpeg on PATH, and the `playwright` package (`npm i --no-save playwright`
// here, or point PW_MODULE at an existing install).
//
// Env: CHROMIUM (browser binary; default: Playwright's own Chromium), PW_MODULE (path to the
// playwright package when it is not resolvable from here), FROM/TO (frame range, video mode),
// POSTER_T (seconds; the frame rendered into frame 0, video mode).
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_MODULE || "playwright");
const TL = JSON.parse(await readFile(path.join(HERE, "timeline.json"), "utf8"));

const TYPES = { ".html": "text/html", ".json": "application/json", ".woff2": "font/woff2", ".js": "text/javascript" };
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
  const file = path.join(HERE, rel);
  if (!file.startsWith(HERE)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(url);
await page.evaluate(() => window.__init);
await page.evaluate(() => document.fonts.ready);
const stage = await page.$("#stage");
const shot = async (t) => {
  await page.evaluate((tt) => window.__render(tt), t);
  return stage.screenshot({ type: "png", animations: "disabled" });
};

const [mode, out, ...rest] = process.argv.slice(2);
try {
  if (mode === "stills") {
    await mkdir(out, { recursive: true });
    for (const t of rest.map(Number)) {
      const buf = await shot(t);
      const name = path.join(out, `t${t.toFixed(2).padStart(5, "0")}.png`);
      await (await import("node:fs/promises")).writeFile(name, buf);
      console.log(name);
    }
  } else if (mode === "video") {
    const fps = TL.fps, total = Math.round(TL.duration * fps);
    const from = Number(process.env.FROM || 0), to = Number(process.env.TO || total);
    const [audio] = rest;
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-"];
    if (audio) args.push("-i", audio, "-c:a", "aac", "-b:a", "256k", "-shortest");
    args.push("-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
      "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-tune", "animation",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-movflags", "+faststart", out);
    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));
    const t0 = Date.now();
    // POSTER_T: render that time into frame 0 instead, so the poster is the first frame
    // (thumbnail on platforms that show frame 0) while duration and sync stay untouched.
    const posterT = process.env.POSTER_T == null ? null : Number(process.env.POSTER_T);
    for (let f = from; f < to; f++) {
      const buf = await shot(f === 0 && posterT != null ? posterT : f / fps);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
      if (f % 60 === 0) console.log(`frame ${f}/${to} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    ff.stdin.end();
    await done;
    console.log(`wrote ${out} (${to - from} frames)`);
  } else {
    console.error("usage: capture.mjs stills <dir> <t...> | video <out.mp4> [audio.wav]");
    process.exitCode = 2;
  }
} finally {
  await browser.close();
  server.close();
}
