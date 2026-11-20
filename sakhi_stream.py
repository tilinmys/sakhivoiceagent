"""Streaming STT relay: phone  <->  gateway  <->  Gnani /stt/v3/stream.

One WebSocket per check-in from the phone (/api/sakhi/stt/stream?lang=kn),
and behind it one WebSocket to Gnani, opened at once and kept for the whole
check-in. Why (measured on this account, 2026-11-13):

  Gnani REST /stt/v3   236 ms median, but 1 call in 20 HANGS ~5.1 s then 504,
                       and the hung call keeps its key's one REST slot.
  Gnani WebSocket      commit -> final transcript 150-220 ms, 40 / 40 answers,
                       no hang; it does not use the REST slot.

Protocol, phone side (binary frames are audio, text frames are JSON):
  phone -> binary   PCM16 LE mono 16 kHz, any frame size (the app sends 20 ms)
  phone -> {"t": "turn", "turn": k} a new answer starts
  phone -> {"t": "commit", "turn": k, "id": n}
                                    the text of turn k so far (all its segments)
  phone -> {"t": "ping", "at": ms}  -> {"t": "pong", "at": ms}
  gateway -> {"t": "ready"} | {"t": "text", "turn", "id", "text", "ms"} |
             {"t": "fail", "turn", "id", "why"} (the phone then uses HTTP)

How Gnani's stream really behaves (probed 2026-11-13), and what the relay does:
  * it sends a transcript ONLY for a segment its own VAD opened (a
    "speech_start" event); a commit on silence, on a 300 ms fragment or with
    nothing new gets NO reply at all. Field bug: the relay matched replies to
    commits by order, an early commit on a fragment never got its reply, and
    every later transcript went to the wrong (timed-out) commit: 4 commits
    failed in a row, 7 s to the transcript over the HTTP fallback.
    So the relay follows Gnani's events: a commit with no open segment is
    answered AT ONCE with the turn's text so far; with a segment open, ONE
    commit goes to Gnani and every phone commit waits for that segment's
    transcript (1.5 s at most, then "fail").
  * a segment's text belongs to the turn it STARTED in (a late transcript
    never lands on the next question)
  * Gnani's VAD caught 10/10 answers even 30 dB under normal level; its
    threshold is set to 0.5 (default 0.7) for margin
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

import sakhi_gateway as gw

log = logging.getLogger("sakhi.stream")

GNANI_WS = os.getenv("GNANI_STT_WS_URL", "wss://api.vachana.ai/stt/v3/stream")
FRAME = 1024  # bytes per Gnani frame (512 samples at 16 kHz = 32 ms)
SEGMENT_TIMEOUT_S = 1.5  # commit -> transcript is 150-250 ms; past this, the phone uses HTTP
START_GRACE_S = 0.12  # a commit right after speech may beat Gnani's "speech_start" to us
PING_S = 5.0


class GnaniLink:
    """One Gnani streaming session, following its segments; reopened if Gnani closes it."""

    def __init__(self, code: str) -> None:
        self.code = code
        self.ws = None
        self.http: ClientSession | None = None
        self.key_index = 0
        self.buf = bytearray()
        self.reader: asyncio.Task | None = None
        self.turn = 0
        self.texts: dict[int, list[str]] = {}
        # the open segment (Gnani heard speech, no transcript yet): its turn, and whether it was committed
        self.seg_turn: int | None = None
        self.seg_committed = False
        self.seg_open = asyncio.Event()
        self.seg_closed = asyncio.Event()
        self.seg_closed.set()

    # ---- connection -----------------------------------------------------------

    async def open(self) -> None:
        """Connect on the first key that answers (GNANI_API_KEY, then GNANI_API_KEY_2)."""
        if self.ws is not None and not self.ws.closed:
            return
        keys = gw.gnani_keys()
        start = self.key_index
        last: Exception | None = None
        for k in range(len(keys)):
            i = (start + k) % len(keys)
            try:
                await self._open(keys[i])
                if i != start:
                    log.warning("gnani stream: key %d failed, using key %d", start + 1, i + 1)
                self.key_index = i
                return
            except Exception as exc:  # noqa: BLE001
                last = exc
        raise ConnectionError(f"no Gnani key could open a stream: {last}")

    async def _open(self, key: str) -> None:
        self.http = self.http or ClientSession(timeout=ClientTimeout(total=None, sock_connect=5))
        headers = {
            "x-api-key-id": key,
            "language_code": self.code,
            "format": "transcribe",
            "x-sample-rate": "16000",
            "x-min-silence-ms": "2000",
            "x-vad-threshold": "0.5",
            "x-idle-timeout-sec": "900",
            **gw._stt_bias_fields(self.code),
        }
        t = time.perf_counter()
        self.ws = await self.http.ws_connect(GNANI_WS, headers=headers, heartbeat=20, compress=0, max_msg_size=1 << 20)
        hello = await self.ws.receive(timeout=5)
        if hello.type != WSMsgType.TEXT or json.loads(hello.data).get("type") != "connected":
            raise ConnectionError(f"Gnani stream did not connect: {hello.data!r}"[:200])
        log.info("gnani stream open %s (%d ms)", self.code, (time.perf_counter() - t) * 1000)
        self.buf.clear()
        self._close_segment()
        self.reader = asyncio.create_task(self._read(self.ws))

    async def _read(self, ws) -> None:
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                m = json.loads(msg.data)
                kind = m.get("type")
                if kind == "speech_start":
                    if self.seg_turn is None:
                        self.seg_turn = self.turn
                        self.seg_committed = False
                        self.seg_closed.clear()
                        self.seg_open.set()
                elif kind == "transcript":
                    text = (m.get("text") or "").strip()
                    turn = self.seg_turn if self.seg_turn is not None else self.turn
                    if text:
                        self.texts.setdefault(turn, []).append(text)
                    self._close_segment()
                elif kind == "error":
                    log.warning("gnani stream error: %s", m.get("message"))
                    self._close_segment()  # this segment is lost: waiting commits get the text so far
        except Exception as exc:  # noqa: BLE001
            log.warning("gnani stream reader: %s", exc)
        finally:
            self._close_segment()
            log.info("gnani stream closed (%s)", self.code)

    def _close_segment(self) -> None:
        self.seg_turn = None
        self.seg_committed = False
        self.seg_open.clear()
        self.seg_closed.set()

    # ---- audio and turns ------------------------------------------------------

    async def audio(self, data: bytes) -> None:
        if self.ws is None or self.ws.closed:
            await self.open()
        self.buf += data
        while len(self.buf) >= FRAME:
            await self.ws.send_bytes(bytes(self.buf[:FRAME]))
            del self.buf[:FRAME]

    async def new_turn(self, turn: int) -> None:
        """A new answer: the previous one's open segment (if any) is closed now, its text stays with it."""
        if self.seg_turn is not None and not self.seg_committed and self.ws is not None and not self.ws.closed:
            await self._send_commit()
        self.turn = turn
        for old in [k for k in self.texts if k < turn - 2]:
            del self.texts[old]  # flat memory over a long check-in

    async def _send_commit(self) -> None:
        if self.buf:
            await self.ws.send_bytes(bytes(self.buf).ljust(FRAME, b"\0"))
            self.buf.clear()
        self.seg_committed = True
        await self.ws.send_str(json.dumps({"type": "commit"}))

    async def commit(self, turn: int) -> str:
        """Turn `turn`'s text so far, after the open segment (if any) is transcribed. Raises on timeout."""
        if self.ws is None or self.ws.closed:
            await self.open()
        if self.seg_turn is None:
            # her audio may be a few ms ahead of Gnani's "speech_start": a short grace
            try:
                await asyncio.wait_for(self.seg_open.wait(), START_GRACE_S)
            except asyncio.TimeoutError:
                pass
        if self.seg_turn is not None:
            if not self.seg_committed:
                await self._send_commit()
            await asyncio.wait_for(self.seg_closed.wait(), SEGMENT_TIMEOUT_S)
        return " ".join(self.texts.get(turn, []))

    async def close(self) -> None:
        try:
            if self.ws is not None and not self.ws.closed:
                await self.ws.close()
        finally:
            if self.http is not None:
                await self.http.close()


async def handle(request: web.Request) -> web.StreamResponse:
    if not gw.authorized(request.headers) and not gw.authorized({"Authorization": f"Bearer {request.query.get('token', '')}"}):
        return web.json_response({"error": "unauthorized"}, status=401)
    code = gw.LANG_CODES.get((request.query.get("lang") or "").strip().lower())
    if not code or not gw.gnani_keys():
        return web.json_response({"error": "language or STT not configured"}, status=400 if not code else 503)
    ws = web.WebSocketResponse(heartbeat=PING_S, compress=False, max_msg_size=1 << 20)
    await ws.prepare(request)
    link = GnaniLink(code)
    peer = request.headers.get("CF-Connecting-IP") or request.remote
    try:
        await link.open()
        await ws.send_json({"t": "ready"})
    except Exception as exc:  # noqa: BLE001
        log.warning("gnani stream unavailable: %s", exc)
        await ws.send_json({"t": "down", "why": "stt stream unavailable"})
        await ws.close()
        await link.close()
        return ws
    log.info("phone stream connected (%s, %s)", peer, code)

    async def do_commit(turn: int, cid: int) -> None:
        t = time.perf_counter()
        try:
            text = await link.commit(turn)
            ms = round((time.perf_counter() - t) * 1000)
            await ws.send_json({"t": "text", "turn": turn, "id": cid, "text": text, "ms": ms})
            log.info("commit %d.%d -> %d ms %s", turn, cid, ms, "(text)" if text else "(no speech)")
        except Exception as exc:  # noqa: BLE001
            log.warning("commit %d.%d failed after %d ms: %s", turn, cid, (time.perf_counter() - t) * 1000, type(exc).__name__)
            if not ws.closed:
                await ws.send_json({"t": "fail", "turn": turn, "id": cid, "why": type(exc).__name__})

    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                try:
                    await link.audio(msg.data)
                except Exception as exc:  # noqa: BLE001
                    log.warning("audio to gnani failed: %s", exc)
            elif msg.type == WSMsgType.TEXT:
                m = json.loads(msg.data)
                t = m.get("t")
                if t == "turn":
                    await link.new_turn(int(m.get("turn", 0)))
                elif t == "commit":
                    asyncio.create_task(do_commit(int(m.get("turn", link.turn)), int(m.get("id", 0))))
                elif t == "ping":
                    await ws.send_json({"t": "pong", "at": m.get("at")})
    finally:
        await link.close()
        log.info("phone stream closed (%s)", peer)
    return ws
