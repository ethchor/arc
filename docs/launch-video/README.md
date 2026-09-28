# arc — launch video

A 22-second launch film for arc: the plan, the claims check, and the source to re-render it.

| File | What it is |
| --- | --- |
| [`poster.jpg`](poster.jpg) | The poster frame (the settled logo reveal), 1920×1080. |
| [`share-copy.txt`](share-copy.txt) | Ready-to-post copy for the film. |
| [`composition/`](composition/) | The film itself: `index.html` (every frame is a pure function of time), `timeline.json` (shared by picture and sound), `soundtrack.py` (original music), `capture.mjs` (renderer), `honeycomb.json` (the logo's cells) and the bundled fonts. |

The rendered MP4 (7 MB) is deliberately not committed. Post it directly or attach it to a
release, and re-render it with the commands under [Reproduce](#reproduce). The film was built
with the slim workflow of the [brag](https://github.com/latent-spaces/brag) launch-video skill.

**Format:** landscape 1920×1080, 30 fps, 22.0 s · **Tone:** `polished`. It's a serious
security product, so the film is confident and restrained, with holds long enough to read.
**Tempo:** 120 BPM, so one bar is exactly 2 s and every cut lands on a bar line.

## The rubric

| Question | Answer (from arc's own README, design system and code) |
| --- | --- |
| What is it? | One self-hostable secrets platform: infrastructure credentials and an end-to-end-encrypted vault, unified under one identity, one policy, one audit trail. |
| Who is it for? | Platform engineers (dynamic DB creds, cloud STS, KV, PKI), people and teams (passwords, passkeys, TOTP, notes), and anyone letting autonomous agents touch secrets. |
| What sets it apart? | It is a secrets manager and a password manager behind one control plane. The server is zero-knowledge, vault-key grants are post-quantum hybrid by default, and agents are first-class principals whose actions are signed and revocable. |
| Most impressive claim? | "Only ciphertext crosses the trust boundary." / "An owner can revoke in one shot." |
| Visual hook | **The logo.** arc's primary mark is the honeycomb halftone (`public/arc-honeycomb.svg`, "the design system's primary logo"). The brand panel's own line is *"One account. Two worlds of secrets."* The design system's two poles are ember (warm/human) and arc cyan (machine/secure). |
| Real UI / flow | (1) the web app's **Add login** dialog encrypting on the device, with only an `XC20P` envelope reaching the server; (2) `GET /v1/database/creds/app` returning a lease in the real Vault wire shape; (3) an agent's signed-intent chain, then `owner.closeTask(...)` revoking everything the task holds. |
| Tone | `polished`. |
| Share line | "Secrets managers and password managers are two products. arc is one." |

## Angle

**Two worlds, one honeycomb.** Open on arc's honeycomb logo split down the middle. The left
half is arc cyan (*machine secrets*) and the right half is ember (*human secrets*), the
design system's two poles. They slide together, the seam zips shut on the downbeat, and the
ember cells cool into arc cyan until the logo is whole. After that the logo sits in the
console's nav-rail tile for the three highlights, and the outro rebuilds it the same way as a
bookend.

## Storyboard

| # | Time | Beat | On screen | Sound |
| --- | --- | --- | --- | --- |
| 1 | 0.0–2.0 | **Hook** | **"Two worlds of secrets."** The left (cyan) half of the honeycomb builds cell by cell on the first beat and the right (ember) half on the second. Under each half is its label and its README chips: *Machine secrets* (Database creds · Cloud STS · KV · PKI) and *Human secrets* (Passwords · Passkeys · TOTP · Notes). | Pad (Am) + two plucked notes on the builds |
| 2 | 2.0–4.0 | **Bridge** | Labels and chips clear. **"One platform."** The halves slide together and lock at 3.0 (the x = 50 column interlocks like a zipper, and the seam flashes). A wave from the seam cools the ember cells into arc cyan. | Riser into the drop; bell on the lock |
| 3 | 4.0–6.0 | **Reveal** | The logo ripples on the drop and settles beside the **arc** wordmark (Space Grotesk semibold, as in the console nav rail). On three eighth-notes: **One identity. / One policy. / One audit trail.** | **Drop**: kick, sub, full groove |
| 4 | 6.0–10.0 | **Human secrets** | The lockup flies into the header tile (*arc \| Human secrets*). Split screen over a dashed *trust boundary*. On the left, *Your device*: the real **Add login** dialog ("Encrypted on this device before it is saved."). The password types in and **Save** is pressed. The field scrambles into ciphertext and turns to masked dots with a lock, and the *encrypted on this device* trust pill appears. The ciphertext flies over the boundary, which pulses where it crosses. On the right, *arc server*: the stored envelope `{ "v": 1, "alg": "XC20P", "kv": 1, "n", "ct" }`. Caption: **"Only ciphertext crosses the trust boundary."** Badge: *post-quantum · key grants · X25519 + ML-KEM-768*. | Soft typing; a rising glide as the packet crosses |
| 5 | 10.0–14.0 | **Machine secrets** | `GET /v1/database/creds/app` types in → `200 OK` → `lease_id`, `lease_duration: 3600`, `renewable: true`, `data`. A lease ring fills and counts down in real time, with **Renew** / **Revoke** (the leases view's actions). Caption: **"Dynamic credentials — leased, renewable, revocable."** | A tick on each response line, in key |
| 6 | 14.0–18.0 | **Agents** | *deploy-bot* with the ember `agent` role badge and *task 7e41c2d0 · open*. Three `kv.read` intents chain in on the beat, each `signed · ed25519`, and each head becomes the next intent's `prev`. On the right is *Held by this task*: delegation, two leases, agent token. Caption: **"Every agent action is signed."** `owner › await owner.closeTask(agent.id, task.taskId);` runs on the downbeat. The task flips to *closed*, then every row flips to *revoked*, top to bottom. Caption: **"Revoked in one shot."** | Chain ticks; on the run, drums drop out, a low thud and a descending cascade |
| 7 | 18.0–22.0 | **Outro** | Clean dip. The two halves build again (cyan, then ember), lock, and cool to one logo. The **arc** wordmark lands. On the final chord: *Self-hostable · Open source · Zero-knowledge*, then `github.com/ethchor/arc`. Held with no fade to black, so the last frame is postable. | Resolves to C; bell chord; tail |

Reading holds are checked at about 0.3 s per word, counted from when a line has fully
settled. Transitions stagger (old content out, then new content in) and never crossfade two
busy layouts.

## Visual identity (lifted from `apps/arc-vault-web`)

- **Logo:** the honeycomb halftone, all 307 cells taken from `public/arc-honeycomb.svg` with
  their own sizes and opacities, animated one hexagon at a time. The header lockup copies
  the console nav rail (`console-shell.tsx`): a tinted tile (primary/15, ring primary/25),
  the honeycomb, and a semibold **arc**.
- **Color:** dark "control room" tokens: surfaces `#0C0F16` / `#141821` / `#1B202A`,
  border `#29303D`, text `#E9ECF1` / `#9AA4B4`, arc cyan `#2DC6B1`, ember `#EC9B2E` (human
  pole, agent role, post-quantum badge), success `#36C97B`, danger `#F26464`. The
  background is the dark `bg-arc-mesh` (ember top-right, cyan top-left) plus the faint
  `arc-grid-bg`.
- **Type:** Space Grotesk (display), IBM Plex Sans (UI), Geist Mono (secrets, paths). These
  are the web app's three families, bundled in `composition/fonts/` under the SIL OFL 1.1.
- **Components:** `TrustIndicator` presets ("encrypted on this device", "post-quantum"), the
  `agent` role badge, capability chips, status chips, and lease actions, all restyled from
  `globals.css`.
- **Motion:** the design system's easings (`ease-out-expo`, `ease-out-back`,
  `ease-in-out-quart`), radii and shadows. Frames are a pure function of time.

## Claims check

Every line of on-screen copy is verbatim or a direct trim of the README
("machine secrets … human secrets", "one identity, one policy, one audit trail", "only
ciphertext crosses the trust boundary", "revoke in one shot", "X25519 + ML-KEM-768"), the
design system ("Two worlds of secrets.", "Encrypted on this device before it is saved.",
trust-pill text), or real names from the code (`XC20P`, `kv`, `lease_id`, `lease_duration`,
`renewable`, `kv.read`, `prevChainHead`/chain head, Ed25519 intent signatures,
`owner.closeTask(agent.id, task.taskId)`, `GET /v1/database/creds/app`). The close-task
cascade (delegations, leases and agent tokens revoked) is what the Engine C docs and
`POST /vault/agents/:id/tasks/:taskId/close` describe. Values inside the panels (a
password, ciphertext strings, hashes, a lease id, a task id, role names) are illustrative UI
text, not claims. No numbers, customers, benchmarks or testimonials are invented. "Open
source" is backed by the Apache 2.0 `LICENSE`. The URL is the repo's canonical name
(`ethchor/arc-vault` redirects there).

## Music

Original music, synthesized for this video (`composition/soundtrack.py`): 120 BPM, A minor
resolving to C major (Am · F · C · G, twice, then Am · F · C). The skill's bundled tracks
were not used because their README says their license terms are unverified, and this video
is meant to be published. The effects are generated in the same key and the same room as the
music and mixed underneath it. The master is normalized to −14 LUFS integrated.

## Reproduce

From `docs/launch-video/`, with Python 3 (numpy + scipy), Node 18+, ffmpeg, and Playwright
(`npm i --no-save playwright` in `composition/`, then `npx playwright install chromium`):

```sh
python3 composition/soundtrack.py /tmp/soundtrack.wav
ffmpeg -i /tmp/soundtrack.wav -af loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null -
#   → feed the measured_* values into a second loudnorm pass (linear=true) → /tmp/soundtrack-norm.wav
node composition/capture.mjs stills /tmp/stills 1.9 5.6 9.4          # spot-check frames
POSTER_T=5.6 node composition/capture.mjs video /tmp/arc-launch.mp4 /tmp/soundtrack-norm.wav
```

`capture.mjs` serves `composition/` locally, drives headless Chromium (Playwright) and pipes
the PNG frames straight into ffmpeg (x264, CRF 16, BT.709). The soundtrack is normalized with
two-pass `loudnorm` (I = −14 LUFS, TP = −1 dBTP) before muxing. `POSTER_T` renders the poster
moment (the settled reveal: logo, wordmark and triad) into frame 0 only. Platforms that
thumbnail frame 0 therefore show it, and duration and sync are unchanged. `poster.jpg` is the
same moment as a still.
