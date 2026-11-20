"""The streaming STT relay (sakhi_stream.py), with Gnani faked: auth, the turn's
text joined over commits, a late commit never mixing into the next turn, and a
Gnani failure reported as `fail` (the phone then uses HTTP for that answer)."""

from __future__ import annotations

import asyncio
import unittest

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import sakhi_stream


class FakeLink:
    """GnaniLink's interface: segments transcribed per turn; replies are (delay_s, text) or an exception."""

    instances: list["FakeLink"] = []
    replies: list = []

    def __init__(self, code: str) -> None:
        self.code = code
        self.audio_bytes = 0
        self.turn = 0
        self.texts: dict[int, list[str]] = {}
        FakeLink.instances.append(self)

    async def open(self) -> None:
        pass

    async def audio(self, data: bytes) -> None:
        self.audio_bytes += len(data)

    async def new_turn(self, turn: int) -> None:
        self.turn = turn

    async def commit(self, turn: int) -> str:
        r = FakeLink.replies.pop(0)
        if isinstance(r, Exception):
            raise r
        delay, text = r
        await asyncio.sleep(delay)
        if text:
            self.texts.setdefault(turn, []).append(text)
        return " ".join(self.texts.get(turn, []))

    async def close(self) -> None:
        pass


class StreamRelay(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.orig = sakhi_stream.GnaniLink
        sakhi_stream.GnaniLink = FakeLink
        FakeLink.instances = []
        FakeLink.replies = []
        import os

        self.env = {k: os.environ.get(k) for k in ("GNANI_API_KEY", "SAKHI_GATEWAY_TOKEN")}
        os.environ["GNANI_API_KEY"] = "k"
        os.environ["SAKHI_GATEWAY_TOKEN"] = "tok"
        app = web.Application()
        app.router.add_get("/api/sakhi/stt/stream", sakhi_stream.handle)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        import os

        sakhi_stream.GnaniLink = self.orig
        await self.client.close()
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    async def connect(self, lang="kn"):
        return await self.client.ws_connect(f"/api/sakhi/stt/stream?lang={lang}", headers={"Authorization": "Bearer tok"})

    async def test_unauthorised_is_refused(self):
        r = await self.client.get("/api/sakhi/stt/stream?lang=kn")
        self.assertEqual(r.status, 401)

    async def test_commits_return_the_turn_text_so_far(self):
        FakeLink.replies = [(0, "ನನ್ನ ಹೆಸರು"), (0, "ಕವಿತಾ")]
        ws = await self.connect()
        self.assertEqual((await ws.receive_json())["t"], "ready")
        self.assertEqual(FakeLink.instances[0].code, "kn-IN")
        await ws.send_json({"t": "turn", "turn": 1})
        await ws.send_bytes(b"\0" * 640)
        await ws.send_json({"t": "commit", "turn": 1, "id": 1})
        first = await ws.receive_json()
        await ws.send_bytes(b"\0" * 640)
        await ws.send_json({"t": "commit", "turn": 1, "id": 2})
        second = await ws.receive_json()
        self.assertEqual((first["id"], first["text"]), (1, "ನನ್ನ ಹೆಸರು"))
        self.assertEqual((second["id"], second["text"]), (2, "ನನ್ನ ಹೆಸರು ಕವಿತಾ"))
        self.assertEqual(FakeLink.instances[0].audio_bytes, 1280)
        await ws.close()

    async def test_a_late_commit_never_mixes_into_the_next_turn(self):
        FakeLink.replies = [(0.15, "ಇಲ್ಲ"), (0, "ಹೌದು")]
        ws = await self.connect()
        await ws.receive_json()
        await ws.send_json({"t": "turn", "turn": 1})
        await ws.send_json({"t": "commit", "turn": 1, "id": 1})
        await ws.send_json({"t": "turn", "turn": 2})
        await ws.send_json({"t": "commit", "turn": 2, "id": 2})
        got = {m["id"]: m for m in [await ws.receive_json(), await ws.receive_json()]}
        self.assertEqual((got[1]["turn"], got[1]["text"]), (1, "ಇಲ್ಲ"))
        self.assertEqual((got[2]["turn"], got[2]["text"]), (2, "ಹೌದು"))
        await ws.close()

    async def test_a_gnani_failure_is_a_fail_reply_not_a_hang(self):
        FakeLink.replies = [ConnectionError("gnani stream closed")]
        ws = await self.connect()
        await ws.receive_json()
        await ws.send_json({"t": "turn", "turn": 1})
        await ws.send_json({"t": "commit", "turn": 1, "id": 7})
        m = await ws.receive_json()
        self.assertEqual((m["t"], m["id"]), ("fail", 7))
        await ws.send_json({"t": "ping", "at": 5})
        self.assertEqual(await ws.receive_json(), {"t": "pong", "at": 5})
        await ws.close()
