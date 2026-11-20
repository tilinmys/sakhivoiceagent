"""Sakhi in-app voice gateway: the app's only door to the speech providers.

The tara app (Expo Go) never holds provider keys. It calls three small
HTTPS endpoints, routed from api/index.py (docs/VOICE_IN_APP_DESIGN.md):

  GET  /api/sakhi/health          which providers are configured
  GET  /api/sakhi/tts?text&lang   question / prompt audio as 16 kHz WAV.
                                  Cached: in this process (LRU) and for a year
                                  at the CDN (same text = same URL)
  POST /api/sakhi/stt?lang        one answer, WAV body (16 kHz mono PCM16)
                                  -> {"text", "en", "ms", "provider"}

Providers (measured live from this repo, 2026-10-26):
  gnani   (default when GNANI_API_KEY is set)  TTS Kaveri / timbre-v2.5:
          ~450-810 ms; STT /stt/v3 format=transcribe: ~220-440 ms, and it
          writes numbers as DIGITS ("ಬಿ ಪಿ 148 ಬೈ 96"), so readings parse
          without a translation step. No English translation: "en" is ""
          and the app's rules read Kannada / Hindi directly.
  sarvam  (when SARVAM_API_KEY is set and SAKHI_APP_PROVIDER=sarvam)
          transcribe + translate in parallel, so "en" is filled.

STT: Gnani /stt/v3 behind an audio clean-up pipeline (sakhi_audio.py): the
  app may send IMA-ADPCM (4x smaller) on weak networks; every answer is
  high-passed, noise-reduced, levelled and trimmed, and an empty result for
  a clip that holds speech gets one stronger second pass (see "STT" below).
  Kannada / Hindi in native script with numbers as digits; English as is.
  Reply: {text, en, ms, provider: "gnani", lang, passes, speech_ms, audio_ms}.
"""

from __future__ import annotations

import base64
import collections
import concurrent.futures
import heapq
import hmac
import http.client
import itertools
import json
import logging
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

LANG_CODES = {"kn": "kn-IN", "hi": "hi-IN", "en": "en-IN"}
USER_AGENT = "tara-sakhi-gateway/1.0"
STT_TIMEOUT_S = float(os.getenv("SAKHI_APP_STT_TIMEOUT", "7"))
TTS_TIMEOUT_S = float(os.getenv("SAKHI_APP_TTS_TIMEOUT", "8"))
MAX_AUDIO_BYTES = 16000 * 2 * 25 + 44  # 25 s of 16 kHz mono PCM16 + header
MAX_TTS_CHARS = 500
TTS_CACHE_ITEMS = 200  # ~24 questions x 3 languages + prompts, ~70 KB each

GNANI_BASE = os.getenv("GNANI_BASE_URL", "https://api.vachana.ai").rstrip("/")
GNANI_VOICE = os.getenv("SAKHI_APP_GNANI_VOICE", os.getenv("GNANI_VOICE", "Kaveri"))
GNANI_MODEL = os.getenv("SAKHI_APP_GNANI_MODEL", "timbre-v2.5")

SARVAM_BASE = os.getenv("SARVAM_BASE_URL", "https://api.sarvam.ai").rstrip("/")
SARVAM_TTS_MODEL = os.getenv("SAKHI_APP_TTS_MODEL", "bulbul:v3")
SARVAM_SPEAKER = os.getenv("SAKHI_APP_TTS_SPEAKER", "shreya")

_pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
_tts_cache: "collections.OrderedDict[tuple[str, str, str], bytes]" = collections.OrderedDict()
_tts_lock = threading.Lock()


class GatewayError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


log = logging.getLogger("sakhi-gateway")

# Lower = served first.
PRIORITY = {"stt": 0, "now": 1, "next": 2, "warm": 3}
LANE_WAIT_S = {"stt": 6.0, "now": 8.0, "next": 15.0, "warm": 25.0}
RETRY_429_S = (0.3, 0.6, 1.0)


class _Lane:
    """A priority semaphore: the provider's request slots, best priority first."""

    def __init__(self, slots: int):
        self._cv = threading.Condition()
        self._slots = max(1, slots)
        self._busy = 0
        self._waiting: list[tuple[int, int]] = []
        self._seq = itertools.count()

    def acquire(self, prio: int, timeout: float) -> None:
        ticket = (prio, next(self._seq))
        deadline = time.monotonic() + timeout
        with self._cv:
            heapq.heappush(self._waiting, ticket)
            while not (self._busy < self._slots and self._waiting[0] == ticket):
                left = deadline - time.monotonic()
                if left <= 0:
                    self._waiting.remove(ticket)
                    heapq.heapify(self._waiting)
                    self._cv.notify_all()
                    raise GatewayError(503, "Voice provider busy, try again.")
                self._cv.wait(left)
            heapq.heappop(self._waiting)
            self._busy += 1

    def release(self) -> None:
        with self._cv:
            self._busy -= 1
            self._cv.notify_all()


# Gnani keys: GNANI_API_KEY, then GNANI_API_KEY_2 (failover). Each KEY has ONE
# request slot ("Only 1 active request is allowed at a time", HTTP 429), and
# the slots are independent (measured 2026-11-13: two calls at once on one key
# -> 200 + 429; one on each key -> 200 + 200). So:
#   * one lane (priority semaphore) per key
#   * a request takes the first key whose lane is free; an early key is only
#     waited on briefly (FIRST_WAIT_S) when another key is left
#   * 429 / 5xx / timeout / 401-403 on a key -> the same request on the next
#     key at once, and that key is benched for a while (COOLDOWN_S)
#   * STT is hedged (_hedged): Gnani REST hangs ~5 s on ~1 call in 20 and the
#     hung call holds its key's slot; past HEDGE_S the same request goes to
#     the other key and the first answer wins
_lanes: dict[int, _Lane] = {}
_bench: dict[int, float] = {}
_keys_lock = threading.Lock()
FIRST_WAIT_S = {"stt": 0.15, "now": 0.4, "next": 2.0, "warm": 5.0}
COOLDOWN_S = {"auth": 300.0, "busy": 5.0, "fail": 20.0}
HEDGE_S = float(os.getenv("SAKHI_STT_HEDGE_S", "1.0"))
_HEDGE_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="gnani-hedge")


def gnani_keys() -> list[str]:
    """The configured Gnani keys, in failover order (read live: tests and .env reloads)."""
    return [k for k in (os.getenv("GNANI_API_KEY", "").strip(), os.getenv("GNANI_API_KEY_2", "").strip()) if k]


def _lane(i: int) -> _Lane:
    with _keys_lock:
        if i not in _lanes:
            _lanes[i] = _Lane(int(os.getenv("GNANI_CONCURRENCY", "1")))
        return _lanes[i]


def _key_order(n: int) -> list[int]:
    """Keys in use order: healthy ones first (in .env order), benched ones last."""
    now = time.monotonic()
    return sorted(range(n), key=lambda i: (_bench.get(i, 0.0) > now, i))


def _fails_over(exc: GatewayError) -> str | None:
    if exc.status in (401, 402, 403) or exc.status == 502 and "(40" in exc.message:
        return "auth"
    if exc.status == 429 or (exc.status == 503 and "busy" in exc.message):
        return "busy"
    if exc.status >= 500:
        return "fail"
    return None


def _gnani_call(kind: str, run):
    """Run one Gnani request, `run(key)`, on the first free healthy key; fail over on errors."""
    keys = gnani_keys()
    if not keys:
        raise GatewayError(503, "Speech is not configured on the server (set GNANI_API_KEY).")
    order = _key_order(len(keys))
    last: GatewayError | None = None
    for n, i in enumerate(order):
        final = n == len(order) - 1
        try:
            _lane(i).acquire(PRIORITY[kind], LANE_WAIT_S[kind] if final else FIRST_WAIT_S[kind])
        except GatewayError as exc:  # this key's slot is busy: the next key
            last = exc
            continue
        try:
            # with one key left, a 429 that slipped through is retried on it
            for delay in (*(RETRY_429_S if final else ()), None):
                try:
                    return run(keys[i])
                except GatewayError as exc:
                    if exc.status != 429 or delay is None:
                        raise
                    time.sleep(delay)
        except GatewayError as exc:
            why = _fails_over(exc)
            if why is None or final:
                raise
            _bench[i] = time.monotonic() + COOLDOWN_S[why]
            log.warning("gnani key %d %s (%s): failing over to key %d", i + 1, why, exc.status, order[n + 1] + 1)
            last = exc
        finally:
            _lane(i).release()
    raise last or GatewayError(503, "Voice provider busy, try again.")


def _hedged(kind: str, run):
    """_gnani_call, and past HEDGE_S without an answer, the same request again (it lands on the other key); first answer wins."""
    if len(gnani_keys()) < 2:
        return _gnani_call(kind, run)
    first = _HEDGE_POOL.submit(_gnani_call, kind, run)
    try:
        return first.result(timeout=HEDGE_S)
    except concurrent.futures.TimeoutError:
        pass
    log.info("gnani: no answer in %.1f s, hedging on the other key", HEDGE_S)
    second = _HEDGE_POOL.submit(_gnani_call, kind, run)
    pending = {first, second}
    err: BaseException | None = None
    while pending:
        done, pending = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
        for f in done:
            if f.exception() is None:
                return f.result()
            err = f.exception()
    raise err  # both failed


def provider() -> str | None:
    """Which provider serves the app: explicit choice, else whichever key exists (Gnani first)."""
    choice = os.getenv("SAKHI_APP_PROVIDER", "").strip().lower()
    has = {"gnani": bool(os.getenv("GNANI_API_KEY", "").strip()), "sarvam": bool(os.getenv("SARVAM_API_KEY", "").strip())}
    if choice in has:
        return choice if has[choice] else None
    return "gnani" if has["gnani"] else "sarvam" if has["sarvam"] else None


def _require() -> str:
    p = provider()
    if not p:
        raise GatewayError(503, "Speech is not configured on the server (set GNANI_API_KEY or SARVAM_API_KEY).")
    return p


class RateLimiter:
    """Per-client token bucket: `burst` requests at once, refilled at `per_min`.

    A second line of defence behind the bearer token (authorized()): the
    limits keep one client, even a holder of the token, from spending the
    speech provider's credit (a whole check-in fits well inside them). In-process: on
    serverless each instance keeps its own buckets (best effort).
    """

    def __init__(self, per_min: float, burst: int, max_clients: int = 4096) -> None:
        self.rate = per_min / 60.0
        self.burst = float(burst)
        self.max_clients = max_clients
        self._buckets: collections.OrderedDict[str, tuple[float, float]] = collections.OrderedDict()
        self._lock = threading.Lock()

    def allow(self, client: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            tokens, at = self._buckets.pop(client, (self.burst, now))
            tokens = min(self.burst, tokens + (now - at) * self.rate)
            ok = tokens >= 1.0
            self._buckets[client] = (tokens - 1.0 if ok else tokens, now)
            while len(self._buckets) > self.max_clients:  # bounded memory
                self._buckets.popitem(last=False)
            return ok


# A check-in: ~28 lines (warm-up) + ~30 answers + 1 live session.
LIMITS = {
    "tts": RateLimiter(per_min=90, burst=60),
    "stt": RateLimiter(per_min=40, burst=20),
    "live": RateLimiter(per_min=6, burst=4),
    "ws": RateLimiter(per_min=10, burst=5),
}


def client_id(headers, remote: str | None) -> str:
    """Who is calling: Cloudflare's client IP, else the first forwarded hop, else the socket."""
    cf = (headers.get("CF-Connecting-IP") or "").strip()
    if cf:
        return cf
    fwd = (headers.get("X-Forwarded-For") or "").split(",")[0].strip()
    return fwd or (remote or "?")


def rate_ok(kind: str, headers, remote: str | None) -> bool:
    limiter = LIMITS.get(kind)
    return True if limiter is None else limiter.allow(client_id(headers, remote))


_warned_no_token = False


def authorized(headers) -> bool:
    """Bearer token check. Fails CLOSED: with SAKHI_GATEWAY_TOKEN unset, every
    speech route is refused (an open gateway spends the provider's credit for
    anyone holding the URL). scripts/sakhi_gateway_dev.py sets a dev token."""
    global _warned_no_token
    expected = os.getenv("SAKHI_GATEWAY_TOKEN", "").strip()
    if not expected:
        if not _warned_no_token:
            _warned_no_token = True
            log.error("Security alert: SAKHI_GATEWAY_TOKEN is not configured; denying access.")
        return False
    return hmac.compare_digest(headers.get("Authorization", "").encode(), f"Bearer {expected}".encode())


def lang_code(lang: str) -> str:
    code = LANG_CODES.get((lang or "").strip().lower())
    if not code:
        raise GatewayError(400, "lang must be kn, hi or en.")
    return code


def health() -> dict:
    p = provider()
    stt_on = bool(gnani_keys())
    # The app asks health when a check-in starts and when she starts speaking
    # (gateway.warm): open the provider connection now, so her answer's STT
    # does not pay the TLS handshake (~100-300 ms) on top.
    if stt_on:
        _prewarm(GNANI_BASE)
    return {"stt": stt_on, "tts": bool(p), "provider": p, "translate": False, "stt_provider": "gnani"}


# Kept-alive HTTPS connections to the providers, per host. A fresh connection
# costs a TCP + TLS handshake on EVERY call (measured to Gnani: 276 ms median
# per STT call fresh, 181 ms on a kept-alive connection, ~95 ms saved per
# answer). Pop / push under a lock (O(1)); a connection that went stale while
# idle fails at once and the call is retried ONCE on a fresh one.
_POOL: dict[str, list[http.client.HTTPSConnection]] = collections.defaultdict(list)
_POOL_LOCK = threading.Lock()
_POOL_MAX = 4
_STALE = (http.client.RemoteDisconnected, http.client.BadStatusLine, ConnectionResetError, ConnectionAbortedError, BrokenPipeError)


def _conn(host: str, timeout: float) -> tuple[http.client.HTTPSConnection, bool]:
    with _POOL_LOCK:
        if _POOL[host]:
            c = _POOL[host].pop()
            c.timeout = timeout
            if c.sock is not None:
                c.sock.settimeout(timeout)
            return c, True
    return http.client.HTTPSConnection(host, timeout=timeout, context=ssl.create_default_context()), False


_WARMING: set[str] = set()


def _prewarm(base: str) -> None:
    """Open one kept-alive connection to `base` in the background, if none is idle (never blocks)."""
    host = urllib.parse.urlsplit(base).netloc
    with _POOL_LOCK:
        if _POOL[host] or host in _WARMING:
            return
        _WARMING.add(host)

    def run() -> None:
        try:
            c = http.client.HTTPSConnection(host, timeout=5, context=ssl.create_default_context())
            c.connect()
            _release(host, c)
        except OSError:
            pass
        finally:
            with _POOL_LOCK:
                _WARMING.discard(host)

    threading.Thread(target=run, daemon=True).start()


def _release(host: str, c: http.client.HTTPSConnection) -> None:
    with _POOL_LOCK:
        if len(_POOL[host]) < _POOL_MAX:
            _POOL[host].append(c)
            return
    c.close()


def _request(url: str, body: bytes, headers: dict[str, str], timeout: float) -> bytes:
    parts = urllib.parse.urlsplit(url)
    path = parts.path + (f"?{parts.query}" if parts.query else "")
    hdrs = {"User-Agent": USER_AGENT, "Connection": "keep-alive", **headers}
    deadline = time.monotonic() + timeout
    for attempt in (0, 1):
        c, reused = _conn(parts.netloc, max(0.5, deadline - time.monotonic()))
        try:
            c.request("POST", path, body, hdrs)
            resp = c.getresponse()
            data = resp.read()
        except _STALE as exc:
            c.close()
            if reused and attempt == 0:  # idle connection closed by the server: one fresh try
                continue
            log.warning("provider unreachable: %s", exc)
            raise GatewayError(504, "Voice provider unreachable.") from exc
        except (OSError, http.client.HTTPException) as exc:  # timeout, DNS, refused, TLS
            c.close()
            log.warning("provider unreachable: %s", exc)
            raise GatewayError(504, "Voice provider unreachable.") from exc
        if resp.will_close:
            c.close()
        else:
            _release(parts.netloc, c)
        if resp.status >= 400:
            # The provider's own error text (account, quota, request ids) stays
            # in the server log; the app only learns the kind of failure.
            log.warning("provider HTTP %s: %s", resp.status, data[:300].decode("utf-8", "replace"))
            code = resp.status
            status = code if code == 429 or code >= 500 else 502 if code in (401, 402, 403) else 400
            message = "Voice provider busy, try again." if code == 429 else f"Voice provider error ({code})."
            raise GatewayError(status, message)
        return data
    raise GatewayError(504, "Voice provider unreachable.")


def _multipart(fields: dict[str, str], file_field: str, file_bytes: bytes) -> tuple[bytes, str]:
    boundary = f"----sakhi{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="answer.wav"\r\n'
        f"Content-Type: audio/wav\r\n\r\n".encode()
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


# --- STT ----------------------------------------------------------------------
#
# Speech-to-text is Gnani /stt/v3 (format=transcribe: numbers as digits, its
# fastest mode, ~220-440 ms). Every answer goes through ONE pipeline:
#
#   decode     the app's WAV: PCM16, or IMA-ADPCM (4x smaller, sent on weak networks)
#   enhance    sakhi_audio.enhance: 80 Hz high-pass, Wiener noise reduction from the
#              clip's own quiet frames, speech-gated level (a soft voice up to +24 dB,
#              peak-limited), trim of dead air. Gnani hears a clean, normal-level voice.
#   pass 1     Gnani, in the answer's language (kn-IN / hi-IN / en-IN), on the STT lane
#              (priority over TTS: the account allows one request at a time)
#   pass 2     ONLY if pass 1 came back empty although the clip holds >= 400 ms of
#              speech: once more with the stronger clean-up (120 Hz, -16 dB floor,
#              +30 dB). This is the "she spoke but nothing was caught" case that
#              used to make her repeat herself; it costs one extra call, only then.
#
# Reply: {text, en, ms, provider: "gnani", lang, passes, speech_ms, audio_ms}.

STT_MIN_SPEECH_MS = 400


# Maternal-health vocabulary for Gnani's word boosting (Prisma v2.5 bias_list:
# single words, letters only, up to 100). Bidar Kannada, Deccani Hindi and the
# code-switched English an ASHA hears. OFF by default (SAKHI_STT_BIAS_SCORE
# = 0): A/B on the 42-answer test set at score 1.0 gave the SAME error rate
# in kn / hi / en (0.164 / 0.134 / 0.044) and turned one "test" into
# "chest". Set SAKHI_STT_BIAS_SCORE to 0.5 / 1.0 / 1.5 / 2.0 to try it in the
# field. The app's NLU lexicon (nlu/lexicon.ts) already matches these terms
# with one-edit fuzzy matching after recognition.
STT_BIAS = {
    "kn-IN": ["ಹೌದು", "ಇಲ್ಲ", "ನೋವು", "ತಲೆನೋವು", "ಹೊಟ್ಟೆನೋವು", "ರಕ್ತದೊತ್ತಡ", "ಬಿಪಿ", "ರಕ್ತಸ್ರಾವ", "ಜ್ವರ", "ಊತ", "ವಾಂತಿ", "ಮಾತ್ರೆ", "ಕಬ್ಬಿಣ", "ಕ್ಯಾಲ್ಸಿಯಂ", "ಸ್ಕ್ಯಾನ್", "ಹಿಮೋಗ್ಲೋಬಿನ್", "ಮಗು", "ಚಲನೆ", "ಆಸ್ಪತ್ರೆ", "ಸಕ್ಕರೆ", "ಥೈರಾಯ್ಡ್"],
    "hi-IN": ["हाँ", "नहीं", "दर्द", "सिरदर्द", "पेटदर्द", "सूजन", "बुखार", "खून", "ब्लीडिंग", "उल्टी", "गोली", "आयरन", "कैल्शियम", "स्कैन", "बीपी", "हीमोग्लोबिन", "बच्चा", "हलचल", "अस्पताल", "शुगर", "थायराइड"],
    "en-IN": ["BP", "haemoglobin", "hemoglobin", "iron", "tablets", "calcium", "scan", "swelling", "headache", "bleeding", "fever", "vomiting", "howdu", "illa", "haan", "nahi", "thyroid", "sugar", "hospital"],
}


def _stt_bias_fields(code: str) -> dict[str, str]:
    score = os.getenv("SAKHI_STT_BIAS_SCORE", "0").strip()
    if score not in ("0.5", "1.0", "1.5", "2.0") or code not in STT_BIAS:  # Gnani's allowed values; anything else = off
        return {}
    return {"bias_list": json.dumps(STT_BIAS[code], ensure_ascii=False), "bias_score": score}


def _gnani_stt(wav: bytes, code: str, key: str | None = None) -> str:
    # format=transcribe: numbers come back as digits (148 ಬೈ 96), and it is
    # the faster mode (~220-250 ms vs ~280-320 ms verbatim, measured).
    body, ctype = _multipart({"language_code": code, "format": "transcribe", **_stt_bias_fields(code)}, "audio_file", wav)
    data = json.loads(_request(f"{GNANI_BASE}/stt/v3", body, {"X-API-Key-ID": key or os.environ["GNANI_API_KEY"], "Content-Type": ctype}, STT_TIMEOUT_S))
    return (data.get("transcript") or "").strip()


def stt(wav: bytes, lang: str) -> dict:
    """One answer -> transcript (Gnani), through the clean-up pipeline above."""
    import sakhi_audio  # numpy: imported on first use, so health / TTS never pay for it

    if not wav or len(wav) < 44 or wav[:4] != b"RIFF":
        raise GatewayError(400, "Body must be a WAV file.")
    if len(wav) > MAX_AUDIO_BYTES:
        raise GatewayError(413, "Answer too long (max 25 s).")
    code = lang_code(lang)
    if not gnani_keys():
        raise GatewayError(503, "Speech-to-text is not configured on the server (set GNANI_API_KEY).")
    started = time.perf_counter()
    try:
        pcm = sakhi_audio.decode(wav)
    except ValueError as exc:
        raise GatewayError(400, f"Unreadable audio: {exc}.") from exc
    speech = sakhi_audio.speech_ms(pcm)
    clean = sakhi_audio.wav(sakhi_audio.enhance(pcm))
    try:
        text = _hedged("stt", lambda key: _gnani_stt(clean, code, key))
        passes = 1
        if not text and speech >= STT_MIN_SPEECH_MS:
            strong = sakhi_audio.wav(sakhi_audio.enhance(pcm, strength=2.0))
            text = _hedged("stt", lambda key: _gnani_stt(strong, code, key))
            passes = 2
    except OSError as exc:  # connection reset mid-reply
        log.warning("gnani stt failed: %s", exc)
        raise GatewayError(504, "Speech service unreachable.") from exc
    return {
        "text": text,
        "en": text if code == "en-IN" else "",
        "ms": round((time.perf_counter() - started) * 1000),
        "provider": "gnani",
        "lang": lang.strip().lower(),
        "passes": passes,
        "speech_ms": speech,
        "audio_ms": round(len(pcm) / 16),
    }


# --- TTS ----------------------------------------------------------------------


def _gnani_tts(text: str, code: str, key: str | None = None) -> bytes:
    payload = {
        "text": text,
        "voice": GNANI_VOICE,
        "model": GNANI_MODEL,
        "language": code,
        "audio_config": {"sample_rate": 16000, "encoding": "linear_pcm", "num_channels": 1, "sample_width": 2, "container": "wav"},
    }
    return _request(
        f"{GNANI_BASE}/api/v1/tts/inference",
        json.dumps(payload).encode("utf-8"),
        {"X-API-Key-ID": key or os.environ["GNANI_API_KEY"], "Content-Type": "application/json"},
        TTS_TIMEOUT_S,
    )


def _sarvam_tts(text: str, code: str) -> bytes:
    payload = {"inputs": [text], "target_language_code": code, "speaker": SARVAM_SPEAKER, "model": SARVAM_TTS_MODEL, "pace": 0.95}
    data = json.loads(_request(f"{SARVAM_BASE}/text-to-speech", json.dumps(payload).encode("utf-8"), {"api-subscription-key": os.environ["SARVAM_API_KEY"], "Content-Type": "application/json"}, TTS_TIMEOUT_S))
    audios = data.get("audios") or []
    if not audios:
        raise GatewayError(502, "Provider returned no audio.")
    return base64.b64decode(audios[0])


def fix_wav_header(wav: bytes) -> bytes:
    """Gnani streams WAV with placeholder sizes (0xFFFFFFFF): players then
    report a 37-hour duration and some refuse the file. Write the real RIFF
    and data-chunk sizes. Anything that is not a plain RIFF/WAVE is returned
    unchanged."""
    if len(wav) < 44 or wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        return wav
    pos = 12
    while pos + 8 <= len(wav):
        cid, size = wav[pos : pos + 4], int.from_bytes(wav[pos + 4 : pos + 8], "little")
        if cid == b"data":
            data_len = len(wav) - (pos + 8)
            if data_len % 2:
                wav, data_len = wav[:-1], data_len - 1
            out = bytearray(wav)
            out[4:8] = (len(out) - 8).to_bytes(4, "little")
            out[pos + 4 : pos + 8] = data_len.to_bytes(4, "little")
            return bytes(out)
        if size == 0xFFFFFFFF or pos + 8 + size > len(wav):
            return wav
        pos += 8 + size + (size & 1)
    return wav


def tts(text: str, lang: str, priority: str = "now") -> bytes:
    """One question / prompt as WAV bytes (process-level LRU in front of the provider)."""
    kind = priority if priority in ("now", "next", "warm") else "now"
    text = (text or "").strip()
    if not text:
        raise GatewayError(400, "text is required.")
    if len(text) > MAX_TTS_CHARS:
        raise GatewayError(413, f"text too long (max {MAX_TTS_CHARS} characters).")
    code = lang_code(lang)
    p = _require()
    key = (p, code, text)
    with _tts_lock:
        hit = _tts_cache.get(key)
        if hit is not None:
            _tts_cache.move_to_end(key)
            return hit
    audio = _gnani_call(kind, lambda key: _gnani_tts(text, code, key)) if p == "gnani" else _sarvam_tts(text, code)
    audio = fix_wav_header(audio)
    if audio[:4] != b"RIFF":
        raise GatewayError(502, "Provider returned no WAV audio.")
    with _tts_lock:
        _tts_cache[key] = audio
        while len(_tts_cache) > TTS_CACHE_ITEMS:
            _tts_cache.popitem(last=False)
    return audio


# --- LIVE: real-time conversation with the Sakhi agent (WebRTC) ----------------
#
# The app's "Live Sakhi" mode joins a LiveKit room with the SAME agent the web
# app talks to (agent.py), over WebRTC: Opus audio both ways through LiveKit
# Cloud's nearest SFU, agent state + live captions on the same connection.
# This gateway only does the signalling: a room, a token, the dispatch.
#
#   GET  /api/sakhi/live/config            LiveKit URL + is the agent up
#   POST /api/sakhi/live/session           {lang, mother} -> {url, token, room}
#   GET  /api/sakhi/live/page              the WebRTC page the app embeds
#   GET  /api/sakhi/live/livekit-client.js the client library (gzip, immutable)
#
# SAKHI_LIVE_AGENT_NAME picks the worker the app's calls go to. Development
# uses its own name ("sakhi-app-dev", scripts/sakhi_agent_dev.py) so a worker
# on a laptop can never take calls meant for the production worker that runs
# under LIVEKIT_AGENT_NAME on the same LiveKit project.

import gzip as _gzip
import pathlib as _pathlib
import re as _re

LIVE_DIR = _pathlib.Path(__file__).resolve().parent / "sakhi_live"
LIVE_CLIENT = "livekit-client-2.20.0.umd.js"
LIVE_VOICE = os.getenv("SAKHI_LIVE_VOICE", "Kaveri")
_live_assets: dict[str, tuple[bytes, bytes]] = {}


def live_agent_name() -> str:
    return os.getenv("SAKHI_LIVE_AGENT_NAME") or os.getenv("LIVEKIT_AGENT_NAME", "sakhi-maternal-care")


def _live_agent_ready() -> bool | None:
    """True/False when a worker status URL is known (dev: the local agent), else None."""
    base = os.getenv("SAKHI_LIVE_WORKER_URL", "").strip().rstrip("/")
    if not base:
        return None
    try:
        # The livekit-agents worker answers "OK" on / once it is connected to LiveKit.
        with urllib.request.urlopen(f"{base}/", timeout=1.5) as resp:
            return resp.status == 200 and resp.read(16).strip().upper().startswith(b"OK")
    except Exception:
        return False


def live_config() -> dict:
    url = os.getenv("LIVEKIT_URL", "").strip()
    creds = bool(url and os.getenv("LIVEKIT_API_KEY") and os.getenv("LIVEKIT_API_SECRET"))
    return {"available": creds, "url": url if creds else None, "agent": live_agent_name(), "agentReady": _live_agent_ready() if creds else False}


def live_plan(req: dict) -> dict:
    """Room, identity and dispatch metadata for one live conversation."""
    url = os.getenv("LIVEKIT_URL", "").strip()
    if not (url and os.getenv("LIVEKIT_API_KEY") and os.getenv("LIVEKIT_API_SECRET")):
        raise GatewayError(503, "Live Sakhi is not configured on the server (LiveKit).")
    lang = str(req.get("lang") or "kn").lower()
    if lang not in ("kn", "hi"):
        lang = "kn"
    mother = req.get("mother") if isinstance(req.get("mother"), dict) else {}
    mid = _re.sub(r"[^a-zA-Z0-9_-]", "", str(mother.get("id") or "visit"))[:24] or "visit"
    stamp = f"{int(time.time() * 1000):x}"
    metadata = json.dumps({
        # The agent reads these from the dispatch (agent.py entrypoint):
        "tts_provider": "gnani",      # Sakhi's voice = the phone-call agent's voice
        "voice_id": LIVE_VOICE,
        "language": lang,
        # Context for the conversation and the records.
        "source": "tara-app",
        "mother": {k: mother.get(k) for k in ("id", "name", "months", "zone") if mother.get(k) is not None},
    }, ensure_ascii=False)
    return {
        "url": url,
        "room": f"sakhi-app-{mid}-{stamp}-{uuid.uuid4().hex[:4]}",
        "identity": f"asha-{mid}-{stamp}",
        "agent": live_agent_name(),
        "metadata": metadata,
    }


def live_asset(name: str, accepts_gzip: bool):
    """(body, content type, encoding, cache-control) for the live page files, or None."""
    files = {
        "page": ("page.html", "text/html; charset=utf-8", "no-cache"),
        "livekit-client.js": (LIVE_CLIENT, "application/javascript; charset=utf-8", "public, max-age=31536000, immutable"),
    }
    entry = files.get(name)
    if not entry:
        return None
    filename, ctype, cache = entry
    if filename not in _live_assets or filename == "page.html":
        raw = (LIVE_DIR / filename).read_bytes()
        _live_assets[filename] = (raw, _gzip.compress(raw, 6))
    raw, packed = _live_assets[filename]
    return (packed, ctype, "gzip", cache) if accepts_gzip else (raw, ctype, None, cache)
