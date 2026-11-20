"""Gnani STT under field conditions: soft voice, heavy noise, both; raw vs the gateway's clean-up.

    python scripts/stt_eval/gnani_eval.py [n_per_lang]

For a balanced subset of the test set (kn / hi / en, clean takes), each clip is degraded:
  clean   as recorded
  soft    -24 dB (a voice from across the room, phone on the lap)
  noisy   + broadband room noise at 5 dB SNR (fan, traffic, TV hiss)
  both    soft and noisy
and sent to Gnani /stt/v3 twice: as it is, and after sakhi_audio.enhance. Reports per
condition: character error rate against the reference text, empty transcripts, latency.
Gnani allows ONE request at a time, so the calls run in sequence.
"""

from __future__ import annotations

import json
import os
import re
import statistics as st
import sys
import time
import unicodedata

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)
for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

import sakhi_audio as sa  # noqa: E402
import sakhi_gateway as g  # noqa: E402
from scripts.stt_eval.testset import C  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 14
rng = np.random.default_rng(7)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s.lower())
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", "", s)


def cer(ref: str, hyp: str) -> float:
    r, h = norm(ref), norm(hyp)
    if not r:
        return 0.0
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return d[-1] / len(r)


def degrade(pcm: np.ndarray, kind: str) -> np.ndarray:
    x = pcm.astype(np.float32) / 32768
    if kind in ("soft", "both"):
        x = x * 10 ** (-24 / 20)
    if kind in ("noisy", "both"):
        noise = rng.standard_normal(len(x)).astype(np.float32)
        # room-like colour: more energy low, less high
        noise = np.convolve(noise, np.ones(6) / 6, mode="same")
        sig = np.sqrt((pcm.astype(np.float32) / 32768) ** 2).mean() if kind == "noisy" else np.sqrt((x ** 2).mean())
        p_sig = np.mean(x ** 2)
        noise *= np.sqrt(p_sig / (10 ** (5 / 10)) / (np.mean(noise ** 2) + 1e-12))
        x = x + noise
    return np.clip(np.round(x * 32767), -32768, 32767).astype(np.int16)


cases = []
for lang in ("kn", "hi", "en"):
    cases += [c for c in C if c["lang"] == lang and c["style"] in ("clean", "numbers", "codemix")][:N]

rows = []
for c in cases:
    path = os.path.join(ROOT, "scripts", "stt_eval", "audio", f"{c['id']}.wav")
    if not os.path.exists(path):
        continue
    pcm = sa.decode(open(path, "rb").read())
    for kind in ("clean", "soft", "noisy", "both"):
        d = degrade(pcm, kind)
        for pre in (False, True):
            audio = sa.wav(sa.enhance(d) if pre else d)
            t = time.perf_counter()
            try:
                text = g._gnani_call("stt", lambda key: g._gnani_stt(audio, g.LANG_CODES[c["lang"]], key))
            except Exception as exc:  # noqa: BLE001
                text = ""
                print("ERR", c["id"], kind, pre, exc)
            ms = (time.perf_counter() - t) * 1000
            rows.append({"id": c["id"], "lang": c["lang"], "kind": kind, "pre": pre, "cer": cer(c["text"], text), "empty": not text.strip(), "ms": ms, "text": text, "ref": c["text"], "kb": len(audio) / 1024})

json.dump(rows, open(os.path.join(ROOT, "scripts", "stt_eval", "gnani_eval.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(cases)} clips x 4 conditions x 2\n")
print(f"{'condition':8s} {'clean-up':8s} {'CER':>6s} {'empty':>6s} {'ms med':>7s} {'ms p90':>7s} {'KB':>6s}")
for kind in ("clean", "soft", "noisy", "both"):
    for pre in (False, True):
        r = [x for x in rows if x["kind"] == kind and x["pre"] == pre]
        ms = sorted(x["ms"] for x in r)
        print(f"{kind:8s} {'on' if pre else 'off':8s} {st.mean(x['cer'] for x in r):6.3f} {sum(x['empty'] for x in r):6d} {st.median(ms):7.0f} {ms[int(len(ms) * .9)]:7.0f} {st.mean(x['kb'] for x in r):6.1f}")
for lang in ("kn", "hi", "en"):
    r = [x for x in rows if x["lang"] == lang and x["pre"]]
    print(f"  {lang} (clean-up on, all conditions): CER {st.mean(x['cer'] for x in r):.3f}, empty {sum(x['empty'] for x in r)}")
