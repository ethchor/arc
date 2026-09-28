"""
Original soundtrack for the arc launch video. Everything here is synthesized — no samples,
no third-party music — so the result can be published without a licensing question.

120 BPM, one bar = 2 s. Am · F · C · G twice, then Am · F · C, resolving to C major on the
outro. Every sound effect is pitched to the chord underneath it and sent to the same reverb as
the music, so the effects read as part of the track rather than laid on top of it.

Event times come from timeline.json, which the visual composition reads too — picture and
sound cannot drift apart.

    python3 soundtrack.py <out.wav>
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

HERE = Path(__file__).parent
TL = json.loads((HERE / "timeline.json").read_text())

SR = 48_000
DUR = TL["duration"]
N = int(round(SR * DUR))
BEAT = 60.0 / TL["bpm"]
BAR = 4 * BEAT
RNG = np.random.default_rng(20260928)  # fixed seed: the track is reproducible byte-for-byte


def t2n(t: float) -> int:
    return int(round(t * SR))


def mtof(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def sos(kind: str, f, order: int = 2):
    return butter(order, f, btype=kind, fs=SR, output="sos")


def stereo() -> np.ndarray:
    return np.zeros((2, N))


def place(bus: np.ndarray, sig: np.ndarray, t: float, gain: float = 1.0, pan: float = 0.0) -> None:
    """Add a mono signal at time t with an equal-power pan (-1 left … +1 right)."""
    start = t2n(t)
    if start >= N:
        return
    sig = sig[: N - start]
    a = (pan + 1) * np.pi / 4
    bus[0, start : start + len(sig)] += sig * gain * np.cos(a)
    bus[1, start : start + len(sig)] += sig * gain * np.sin(a)


# --- harmony ------------------------------------------------------------------------------

CHORDS = {  # voiced for smooth leading between neighbours
    "Am": {"pad": [57, 64, 69, 72], "arp": [69, 72, 76, 81], "bass": 33},
    "F": {"pad": [57, 60, 65, 69], "arp": [65, 69, 72, 77], "bass": 29},
    "C": {"pad": [55, 60, 64, 67], "arp": [67, 72, 76, 79], "bass": 36},
    "G": {"pad": [55, 59, 62, 67], "arp": [67, 71, 74, 79], "bass": 31},
}


def env_adsr(n: int, a: float, r: float) -> np.ndarray:
    t = np.arange(n) / SR
    e = np.minimum(1.0, t / max(a, 1e-4))
    tail = np.clip((n / SR - t) / max(r, 1e-4), 0, 1)
    return e * tail


def warm_osc(f: float, n: int, harmonics: int = 10, phase: float = 0.0) -> np.ndarray:
    """Band-limited, deliberately soft saw: additive with 1/k² falloff, never aliases."""
    t = np.arange(n) / SR
    out = np.zeros(n)
    kmax = min(harmonics, int((SR / 2) / f) - 1)
    for k in range(1, kmax + 1):
        out += np.sin(2 * np.pi * k * f * t + phase * k) / (k**1.35)
    return out / 2.2


def pad_chord(notes, t0: float, t1: float) -> np.ndarray:
    n = t2n(t1 - t0 + 0.6)
    sig = np.zeros((2, n))
    for i, m in enumerate(notes):
        for d, pan in ((-9, -0.45), (0, 0.0), (9, 0.45)):  # cents detune, spread
            f = mtof(m) * 2 ** (d / 1200)
            s = warm_osc(f, n, phase=RNG.uniform(0, 2 * np.pi)) * env_adsr(n, 0.45, 0.7)
            a = (pan + 1) * np.pi / 4
            sig[0] += s * np.cos(a)
            sig[1] += s * np.sin(a)
    sig = sosfilt(sos("low", 1900), sig, axis=1)
    return sig / (len(notes) * 3)


def pluck(m: float, dur: float = 0.7, bright: float = 1.0) -> np.ndarray:
    n = t2n(dur)
    t = np.arange(n) / SR
    f = mtof(m)
    s = np.zeros(n)
    for k, amp, tau in ((1, 1.0, 0.30), (2, 0.42 * bright, 0.16), (3, 0.16 * bright, 0.09), (4, 0.06 * bright, 0.05)):
        if k * f < SR / 2:
            s += amp * np.sin(2 * np.pi * k * f * t) * np.exp(-t / tau)
    s *= np.minimum(1, t / 0.003)
    return s


def bell(m: float, dur: float = 2.2) -> np.ndarray:
    """Soft inharmonic bell for the reveal triad and the final chord."""
    n = t2n(dur)
    t = np.arange(n) / SR
    f = mtof(m)
    s = np.zeros(n)
    for ratio, amp, tau in ((1.0, 1.0, 1.2), (2.0, 0.35, 0.7), (3.01, 0.12, 0.35), (4.17, 0.05, 0.2)):
        s += amp * np.sin(2 * np.pi * ratio * f * t) * np.exp(-t / tau)
    return s * np.minimum(1, t / 0.004)


def kick() -> np.ndarray:
    n = t2n(0.5)
    t = np.arange(n) / SR
    f = 46 + 70 * np.exp(-t / 0.035)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.20)
    click = sosfilt(sos("high", 2500), RNG.standard_normal(n)) * np.exp(-t / 0.0025) * 0.25
    return np.tanh(1.4 * (body + click)) * 0.9


def clap() -> np.ndarray:
    n = t2n(0.4)
    t = np.arange(n) / SR
    noise = sosfilt(sos("band", [1100, 5200]), RNG.standard_normal(n))
    e = np.zeros(n)
    for off in (0.0, 0.009, 0.019):  # three micro-bursts read as a clap, not a gunshot
        e += np.exp(-np.clip(t - off, 0, None) / 0.012) * (t >= off)
    e += 0.55 * np.exp(-t / 0.13)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05) * 0.3
    return (noise * e * 0.7 + tone) * 0.6


def hat(open_: bool = False) -> np.ndarray:
    n = t2n(0.25 if open_ else 0.08)
    t = np.arange(n) / SR
    noise = sosfilt(sos("high", 7600), RNG.standard_normal(n))
    return noise * np.exp(-t / (0.07 if open_ else 0.022)) * 0.35


def bass_note(m: float, dur: float) -> np.ndarray:
    n = t2n(dur)
    t = np.arange(n) / SR
    f = mtof(m)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) + 0.12 * np.sin(2 * np.pi * 3 * f * t)
    s = np.tanh(1.6 * s)  # harmonics so the line still reads on a phone speaker
    return s * env_adsr(n, 0.006, 0.05) * (0.65 + 0.35 * np.exp(-t / 0.12))


def swoosh(dur: float = 0.42, up: bool = True) -> np.ndarray:
    """Transition air: a band-passed noise sweep, processed in short blocks."""
    n = t2n(dur)
    noise = RNG.standard_normal(n)
    out = np.zeros(n)
    block = 512
    for i in range(0, n, block):
        p = i / n
        fc = 500 * (14 ** (p if up else 1 - p))
        seg = noise[i : i + block]
        out[i : i + block] = sosfilt(sos("band", [fc * 0.7, min(fc * 1.4, SR / 2 - 100)]), seg)
    shape = np.sin(np.linspace(0, np.pi, n)) ** 1.6
    return out * shape * 0.5


def riser(dur: float) -> np.ndarray:
    n = t2n(dur)
    t = np.arange(n) / SR
    air = swoosh(dur, up=True) * 0.8
    glide = np.sin(2 * np.pi * np.cumsum(mtof(69) * 2 ** (t / dur)) / SR) * 0.18
    return (air + glide) * (t / dur) ** 2


def impact(m: float, dur: float = 1.2) -> np.ndarray:
    n = t2n(dur)
    t = np.arange(n) / SR
    f = mtof(m) * (1 + 0.6 * np.exp(-t / 0.05))
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.45)
    thump = sosfilt(sos("low", 900), RNG.standard_normal(n)) * np.exp(-t / 0.06) * 0.5
    return np.tanh(1.3 * (boom + thump)) * 0.8


def key_click() -> np.ndarray:
    n = t2n(0.03)
    t = np.arange(n) / SR
    return sosfilt(sos("band", [2200, 6000]), RNG.standard_normal(n)) * np.exp(-t / 0.004) * 0.35


def gliss(m0: float, m1: float, dur: float) -> np.ndarray:
    n = t2n(dur)
    t = np.arange(n) / SR
    m = m0 + (m1 - m0) * (t / dur) ** 0.7
    f = mtof(m) * (1 + 0.004 * np.sin(2 * np.pi * 6 * t))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env_adsr(n, 0.03, 0.18) * 0.5


# --- arrangement ---------------------------------------------------------------------------

music = stereo()      # pad, arp, bass — ducked by the kick
drums = stereo()
sfx = stereo()        # everything tied to on-screen events
reverb_send = stereo()

chords = TL["chords"]
kick_times = []

for i, name in enumerate(chords):
    t0 = i * BAR
    c = CHORDS[name]
    pad = pad_chord(c["pad"], t0, t0 + BAR)
    start = t2n(t0)
    end = min(N, start + pad.shape[1])
    pad_gain = 0.55 if i < 2 or i >= 9 else 0.42
    music[:, start:end] += pad[:, : end - start] * pad_gain
    reverb_send[:, start:end] += pad[:, : end - start] * 0.18

    full = 2 <= i <= 8
    # Arp: quarters in the intro and outro, eighths once the groove is in.
    step = BEAT / 2 if full else BEAT
    pattern = [0, 2, 1, 3, 0, 2, 3, 1]
    for k in range(int(round(BAR / step))):
        t = t0 + k * step
        m = c["arp"][pattern[k % len(pattern)]]
        vel = 0.30 if full else 0.24
        vel *= 1.0 if k % 2 == 0 else 0.78
        p = pluck(m, 0.55, bright=0.9)
        pan = -0.25 if k % 2 == 0 else 0.25
        place(music, p, t, vel, pan)
        place(reverb_send, p, t, vel * 0.35, pan)

    if full:
        # Bass: 8th-note pulse on the root.
        for k in range(8):
            t = t0 + k * BEAT / 2
            place(music, bass_note(c["bass"] + (12 if k % 4 == 3 else 0), BEAT / 2 * 0.9), t, 0.32)
        # Drums: kick on 1 and 3 plus a pickup every other bar; clap on 2 and 4; offbeat hats.
        hits = [0, 2 * BEAT] + ([3.5 * BEAT] if i % 2 == 1 else [])
        for h in hits:
            kick_times.append(t0 + h)
            place(drums, kick(), t0 + h, 0.85)
        for h in (BEAT, 3 * BEAT):
            cl = clap()
            place(drums, cl, t0 + h, 0.42)
            place(reverb_send, cl, t0 + h, 0.12)
        for k in range(8):
            if k % 2 == 1:
                place(drums, hat(open_=(k == 7)), t0 + k * BEAT / 2, 0.30 + 0.06 * (k % 4 == 3), 0.35)

# The "one shot" moment: drums and bass stop for half a bar while the revoke cascade plays.
stop0, stop1 = t2n(TL["agents"]["click"]), t2n(TL["agents"]["click"] + BEAT)
fade = np.linspace(1, 0, t2n(0.02))
for bus in (drums,):
    bus[:, stop0 : stop0 + len(fade)] *= fade
    bus[:, stop0 + len(fade) : stop1] = 0
kick_times = [k for k in kick_times if not (TL["agents"]["click"] - 1e-6 <= k < TL["agents"]["click"] + BEAT)]

# Sidechain: the music breathes around each kick.
sc = np.ones(N)
tt = np.arange(t2n(0.35)) / SR
duck = 0.38 * np.exp(-tt / 0.16)
for k in kick_times:
    s = t2n(k)
    e = min(N, s + len(duck))
    sc[s:e] = np.minimum(sc[s:e], 1 - duck[: e - s])
music *= sc

# --- sound effects, pitched to the chord underneath ------------------------------------------

def fx(sig, t, g, pan=0.0, wet=0.35):
    place(sfx, sig, t, g, pan)
    place(reverb_send, sig, t, g * wet, pan)

H, B, R, HU, MA, AG, O = TL["hook"], TL["bridge"], TL["reveal"], TL["human"], TL["machine"], TL["agents"], TL["outro"]

fx(pluck(69, 1.0), H["nodeL"], 0.42, -0.4)             # Am: A4
fx(pluck(76, 1.0), H["nodeR"], 0.40, 0.4)              # Am: E5
fx(riser(1.15), 2.85, 0.32, 0.0, wet=0.5)              # into the drop
fx(bell(84, 1.6), B["apex"], 0.22, 0.0, wet=0.5)       # F: C6
fx(impact(36, 1.4), R["drop"], 0.55, 0.0, wet=0.25)    # C: C2
for t, m in zip(R["triad"], (79, 84, 88)):              # C: G5 C6 E6
    fx(bell(m, 1.5), t, 0.16, 0.0, wet=0.45)

for t in TL["transitions"]:
    fx(swoosh(0.42), t - 0.2, 0.20, 0.0, wet=0.3)

def typing(t0, t1, pan):
    n = max(1, int((t1 - t0) / 0.075))
    for k in range(n):
        jitter = RNG.uniform(-0.012, 0.012)
        fx(key_click(), t0 + k * (t1 - t0) / n + jitter, 0.20 + RNG.uniform(0, 0.06), pan, wet=0.15)

typing(HU["typeStart"], HU["typeEnd"], -0.35)
fx(gliss(67, 74, HU["packetEnd"] - HU["packetStart"] + 0.15), HU["packetStart"], 0.20, 0.0)  # G: G4 → D5
fx(pluck(83, 0.8), HU["badge"], 0.18, 0.45)                                                   # G: B5

typing(MA["typeStart"], MA["typeEnd"], -0.3)
for t, m in zip(MA["lines"], (77, 81, 84, 89, 93)):      # F: F5 A5 C6 F6 A6
    fx(pluck(m, 0.4, bright=0.6), t, 0.12, 0.2, wet=0.3)

for t, m in zip(AG["intents"], (79, 83, 86)):             # G: G5 B5 D6
    fx(pluck(m, 0.6), t, 0.22, 0.25)
    fx(key_click(), t, 0.12, 0.25, wet=0.1)
typing(AG["command"], AG["command"] + 0.5, -0.15)         # owner types closeTask(...)
fx(key_click() * 1.4, AG["click"], 0.5, -0.1, wet=0.1)  # the click itself
fx(impact(33, 1.0), AG["click"], 0.35, 0.0, wet=0.2)      # Am: A1 — lands with the stop
for t, m in zip(AG["cascade"], (88, 84, 81, 76, 69)):     # Am, descending: E6 C6 A5 E5 A4
    fx(pluck(m, 0.45, bright=0.5), t, 0.20, 0.3, wet=0.4)

for t, m in zip(O["pops"], (77, 81, 84)):                 # F: F5 A5 C6
    fx(pluck(m, 0.9), t, 0.30, (-0.4, 0.4, 0.0)[O["pops"].index(t)])
fx(riser(O["arcEnd"] - O["arcStart"] + 0.1) * 0.6, O["arcStart"] - 0.1, 0.25, 0.0, wet=0.5)
fx(impact(36, 1.0) * 0.6, O["wordmark"], 0.35, 0.0, wet=0.3)
for m in (60, 64, 67, 72, 76):                             # final C major chord
    fx(bell(m, 2.6), O["finalChord"], 0.13, 0.0, wet=0.6)
place(music, bass_note(36, 1.9) * np.exp(-np.arange(t2n(1.9)) / SR / 0.9), O["finalChord"], 0.35)

# --- one room, then a simple, gentle master --------------------------------------------------

def room(rt60=1.6, pre=0.02, length=2.4):
    n = t2n(length)
    t = np.arange(n) / SR
    env = np.exp(-6.91 * t / rt60)
    ir = []
    for _ in range(2):  # decorrelated left/right tails give width without phasiness
        tail = sosfilt(sos("low", 5200), RNG.standard_normal(n)) * env
        ir.append(np.concatenate([np.zeros(t2n(pre)), tail]))
    ir = np.array(ir)
    return ir / np.max(np.abs(ir))

ir = room()
wet = np.stack([fftconvolve(reverb_send[c], ir[c])[:N] for c in range(2)]) * 0.055

mix = music * 0.9 + drums * 0.75 + sfx * 0.9 + wet
mix = sosfilt(sos("high", 28), mix, axis=1)     # clear sub-rumble
mix = sosfilt(sos("low", 15500, 1), mix, axis=1)  # soften the very top, nothing spiky
mix = np.tanh(mix * 1.15) / np.tanh(1.15)       # gentle glue, not a limiter slam

t = np.arange(N) / SR
fade_in = np.minimum(1, t / 0.02)
fade_out = np.clip((DUR - t) / 1.1, 0, 1) ** 1.5
mix *= fade_in * fade_out

mix /= np.max(np.abs(mix)) / 0.89  # -1 dBFS peak; loudness is set afterwards with loudnorm
out = sys.argv[1] if len(sys.argv) > 1 else "soundtrack.wav"
wavfile.write(out, SR, mix.T.astype(np.float32))
print(f"wrote {out}: {DUR:.1f}s, {SR} Hz stereo, {len(kick_times)} kicks")
