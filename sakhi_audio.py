"""Sakhi answer audio: decode what the phone sends, and make it easy for the recogniser to hear.

Used by the gateway (sakhi_gateway.py) on every answer before it goes to Gnani STT.

  decode(body)       a WAV from the app -> int16 PCM at 16 kHz. Accepts PCM16 (format 1)
                     and IMA-ADPCM (format 0x11, 4 bits a sample: the app sends this
                     on weak networks, 4x smaller), mono.
  enhance(pcm)       the clean-up, in this order, all O(n) or O(n log n) and ~10-30 ms
                     for a 5 s answer:
                       1. DC removal + 80 Hz high-pass (rumble, handling, fans)
                       2. (pass 2 only) noise profile from the quietest 20 % of 32 ms frames, then a
                          gentle decision-directed Wiener gain per bin (floor -12 dB):
                          steady noise (fans, traffic, TV hiss) comes down, the voice stays
                       3. speech-gated level: the loud frames are brought to -20 dBFS RMS
                          (a soft or far-away voice is raised up to +24 dB), peak-limited
                          at -1 dBFS so nothing clips
                       4. trim: silence beyond 600 ms (250 ms on pass 2) before / after the speech is cut
                          (less to upload and to decode)
  wav(pcm)           int16 -> WAV bytes (16 kHz mono PCM16)
  speech_ms(pcm)     how much of the clip is voiced (to tell "she said nothing" from
                     "the recogniser missed her")

Pure numpy, no state, deterministic.
"""

from __future__ import annotations

import io
import struct
import wave

import numpy as np

SR = 16000

# ---- IMA-ADPCM (WAV format 0x11) -------------------------------------------------------
_STEP = np.array([
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060,
    1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
    7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
], dtype=np.int32)
_INDEX = (-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8)


def _adpcm_block(block: bytes, out: list[int]) -> None:
    pred, idx = struct.unpack_from("<hB", block, 0)
    idx = min(88, idx)
    out.append(pred)
    for byte in block[4:]:
        for nib in (byte & 0x0F, byte >> 4):
            step = int(_STEP[idx])
            diff = step >> 3
            if nib & 4:
                diff += step
            if nib & 2:
                diff += step >> 1
            if nib & 1:
                diff += step >> 2
            pred = pred - diff if nib & 8 else pred + diff
            pred = -32768 if pred < -32768 else 32767 if pred > 32767 else pred
            idx = min(88, max(0, idx + _INDEX[nib]))
            out.append(pred)


def decode(body: bytes) -> np.ndarray:
    """A WAV (PCM16 or IMA-ADPCM, mono) -> int16 samples at 16 kHz. Raises ValueError."""
    if len(body) < 44 or body[:4] != b"RIFF" or body[8:12] != b"WAVE":
        raise ValueError("not a WAV file")
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(body):
        cid, size = body[pos:pos + 4], struct.unpack_from("<I", body, pos + 4)[0]
        chunk = body[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt = struct.unpack_from("<HHIIHH", chunk, 0)
        elif cid == b"data":
            data = chunk
        pos += 8 + size + (size & 1)
    if fmt is None or data is None:
        raise ValueError("WAV without fmt / data")
    tag, channels, rate, _, block_align, bits = fmt
    if channels != 1:
        raise ValueError("mono only")
    if tag == 1 and bits == 16:
        pcm = np.frombuffer(data[: len(data) // 2 * 2], dtype="<i2").astype(np.int16)
    elif tag == 0x11:
        out: list[int] = []
        for i in range(0, len(data), block_align):
            blk = data[i:i + block_align]
            if len(blk) >= 4:
                _adpcm_block(blk, out)
        pcm = np.asarray(out, dtype=np.int16)
    else:
        raise ValueError(f"unsupported WAV format {tag}/{bits}")
    if rate != SR:
        n = int(round(len(pcm) * SR / rate))
        pcm = np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm.astype(np.float32)).astype(np.int16)
    return pcm


def wav(pcm: np.ndarray) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(np.asarray(pcm, dtype="<i2").tobytes())
    return buf.getvalue()


# ---- enhancement ------------------------------------------------------------------------
FRAME = 512  # 32 ms
HOP = 256


def _frames_db(x: np.ndarray, n: int = 320) -> np.ndarray:
    k = len(x) // n
    if k == 0:
        return np.array([-100.0])
    f = x[: k * n].reshape(k, n)
    return 10 * np.log10((f * f).mean(1) + 1e-10)


def speech_ms(pcm: np.ndarray) -> int:
    """Voiced time: 20 ms frames more than 10 dB over the clip's noise floor (and above -55 dBFS)."""
    x = pcm.astype(np.float32) / 32768
    db = _frames_db(x)
    floor = np.percentile(db, 15)
    return int(((db > floor + 10) & (db > -55)).sum() * 20)


def _highpass_fast(x: np.ndarray, fc: float = 80.0) -> np.ndarray:
    """Zero-phase high-pass in the frequency domain (O(n log n), no Python loop)."""
    x = x - x.mean()
    n = 1 << int(np.ceil(np.log2(max(2, len(x)))))
    X = np.fft.rfft(x, n)
    f = np.fft.rfftfreq(n, 1 / SR)
    H = 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-3)) ** 4)  # 2nd-order Butterworth magnitude
    return np.fft.irfft(X * H, n)[: len(x)]


def _denoise(x: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """Decision-directed Wiener filter with a noise profile from the quietest frames."""
    if len(x) < FRAME * 4:
        return x
    win = np.hanning(FRAME).astype(np.float32)
    pad = np.concatenate([np.zeros(FRAME), x, np.zeros(FRAME)])
    idx = np.arange(0, len(pad) - FRAME, HOP)
    frames = np.stack([pad[i:i + FRAME] * win for i in idx])
    S = np.fft.rfft(frames, axis=1)
    P = np.abs(S) ** 2
    energy = P.sum(1)
    quiet = energy <= np.percentile(energy, 20)
    N = P[quiet].mean(0) + 1e-12
    gmin = 10 ** (-12 / 20) if strength <= 1 else 10 ** (-16 / 20)
    alpha = 0.96
    G = np.empty_like(P)
    prev = np.ones(P.shape[1])
    for t in range(len(P)):
        post = P[t] / N
        prio = alpha * (prev ** 2) * (P[t - 1] / N if t else post) + (1 - alpha) * np.maximum(post - 1, 0)
        g = prio / (1 + prio)
        g = np.maximum(g, gmin)
        G[t] = g
        prev = g
    Y = np.fft.irfft(S * G, FRAME, axis=1) * win
    out = np.zeros(len(pad))
    norm = np.zeros(len(pad))
    for k, i in enumerate(idx):
        out[i:i + FRAME] += Y[k]
        norm[i:i + FRAME] += win ** 2
    out = out / np.maximum(norm, 1e-6)
    return out[FRAME:FRAME + len(x)]


def _level(x: np.ndarray, target_db: float = -20.0, max_gain_db: float = 24.0) -> np.ndarray:
    db = _frames_db(x)
    loud = db[db >= np.percentile(db, 70)]
    speech_db = float(10 * np.log10(np.mean(10 ** (loud / 10)) + 1e-12))
    gain = 10 ** (min(max_gain_db, max(-12.0, target_db - speech_db)) / 20)
    y = x * gain
    peak = float(np.abs(y).max() + 1e-9)
    lim = 10 ** (-1 / 20)
    if peak > lim:  # soft knee: compress only the peaks above -6 dBFS
        knee = 10 ** (-6 / 20)
        a = np.abs(y)
        over = a > knee
        a[over] = knee + (lim - knee) * np.tanh((a[over] - knee) / (lim - knee))
        y = np.sign(y) * a
    return y


def _trim(x: np.ndarray, keep_ms: int = 250) -> np.ndarray:
    db = _frames_db(x)
    floor = np.percentile(db, 15)
    voiced = np.nonzero((db > floor + 10) & (db > -55))[0]
    if len(voiced) == 0:
        return x
    a = max(0, voiced[0] * 320 - keep_ms * 16)
    b = min(len(x), (voiced[-1] + 1) * 320 + keep_ms * 16)
    return x[a:b]


def enhance(pcm: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """The clean-up for one answer (see the module doc). strength 2 = the second, stronger pass."""
    x = pcm.astype(np.float32) / 32768
    if len(x) < SR // 5:
        return pcm
    if strength <= 1:
        # pass 1: Gnani copes with room noise on its own and the Wiener filter cost it accuracy
        # (noisy CER 0.114 raw -> 0.164 denoised); only the high-pass, the level and a loose trim
        # (long silences only, 600 ms kept so the recogniser keeps its lead-in) help.
        x = _highpass_fast(x, 80)
        x = _level(x, -20.0, 24.0)
        x = _trim(x, keep_ms=600)
    else:
        # pass 2 (pass 1 came back empty although she spoke): a different view of the same audio
        x = _highpass_fast(x, 120)
        x = _denoise(x, strength)
        x = _level(x, -16.0, 30.0)
        x = _trim(x)
    return np.clip(np.round(x * 32767), -32768, 32767).astype(np.int16)
