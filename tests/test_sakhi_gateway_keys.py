"""Two Gnani keys: failover and hedging (sakhi_gateway._gnani_call / _hedged).

Each Gnani key has ONE request slot and the slots are independent (measured).
No network: _request is faked and answers per key."""

from __future__ import annotations

import json
import threading
import time

import pytest

import sakhi_audio as sa
import sakhi_gateway as gw


def wav(seconds: float = 1.0) -> bytes:
    import numpy as np

    t = np.arange(int(16000 * seconds)) / 16000
    x = np.where((t > 0.2) & (t < 0.8), 3000 * np.sin(2 * np.pi * 180 * t), 0)
    return sa.wav(x.astype(np.int16))


@pytest.fixture(autouse=True)
def keys(monkeypatch):
    monkeypatch.setenv("GNANI_API_KEY", "key-one")
    monkeypatch.setenv("GNANI_API_KEY_2", "key-two")
    monkeypatch.setattr(gw, "_bench", {})
    monkeypatch.setattr(gw, "_lanes", {})
    monkeypatch.setattr(gw, "HEDGE_S", 0.2)


class PerKey:
    """Answers each key as configured: a dict reply, an exception, or (delay_s, reply)."""

    def __init__(self, **by_key):
        self.by_key = by_key
        self.calls: list[str] = []
        self.lock = threading.Lock()

    def __call__(self, url, body, headers, timeout):
        key = headers.get("X-API-Key-ID")
        with self.lock:
            self.calls.append(key)
        r = self.by_key[key.replace("-", "_")]
        if isinstance(r, tuple):
            time.sleep(r[0])
            r = r[1]
        if isinstance(r, Exception):
            raise r
        return json.dumps(r).encode()


def test_rate_limited_first_key_fails_over_to_the_second_at_once(monkeypatch):
    net = PerKey(key_one=gw.GatewayError(429, "Voice provider busy, try again."), key_two={"transcript": "ಹೌದು"})
    monkeypatch.setattr(gw, "_request", net)
    t = time.perf_counter()
    assert gw.stt(wav(), "kn")["text"] == "ಹೌದು"
    assert net.calls == ["key-one", "key-two"]
    assert time.perf_counter() - t < 0.5  # no 429 back-off sleeps before failing over


def test_a_revoked_key_is_benched_and_skipped_next_time(monkeypatch):
    net = PerKey(key_one=gw.GatewayError(502, "Voice provider error (401)."), key_two={"transcript": "ಇಲ್ಲ"})
    monkeypatch.setattr(gw, "_request", net)
    gw.stt(wav(), "kn")
    gw.stt(wav(), "kn")
    assert net.calls == ["key-one", "key-two", "key-two"]  # benched: not tried again


def test_a_hung_first_key_is_hedged_on_the_second(monkeypatch):
    net = PerKey(key_one=(1.5, {"transcript": "late"}), key_two={"transcript": "ಸರಿ"})
    monkeypatch.setattr(gw, "_request", net)
    t = time.perf_counter()
    out = gw.stt(wav(), "kn")
    took = time.perf_counter() - t
    assert out["text"] == "ಸರಿ" and took < 0.8  # hedge at 0.2 s, not the 1.5 s hang


def test_a_busy_first_key_slot_goes_straight_to_the_second(monkeypatch):
    net = PerKey(key_one={"transcript": "one"}, key_two={"transcript": "two"})
    monkeypatch.setattr(gw, "_request", net)
    gw._lane(0).acquire(0, 1.0)  # another request holds key one
    try:
        t = time.perf_counter()
        assert gw._gnani_call("stt", lambda key: gw._gnani_stt(b"RIFF", "kn-IN", key)) == "two"
        assert time.perf_counter() - t < 0.5
    finally:
        gw._lane(0).release()


def test_both_keys_failing_is_a_retryable_error(monkeypatch):
    net = PerKey(key_one=gw.GatewayError(504, "Voice provider unreachable."), key_two=gw.GatewayError(504, "Voice provider unreachable."))
    monkeypatch.setattr(gw, "_request", net)
    with pytest.raises(gw.GatewayError) as err:
        gw.stt(wav(), "kn")
    assert err.value.status == 504


def test_tts_fails_over_too(monkeypatch):
    calls = []

    def fake(url, body, headers, timeout):
        calls.append(headers["X-API-Key-ID"])
        if headers["X-API-Key-ID"] == "key-one":
            raise gw.GatewayError(429, "Voice provider busy, try again.")
        return b"RIFF" + b"\0" * 40

    monkeypatch.setattr(gw, "_request", fake)
    monkeypatch.setattr(gw, "_tts_cache", gw.collections.OrderedDict())
    assert gw.tts("ಸರಿ ಪರೀಕ್ಷೆ", "kn", "now")[:4] == b"RIFF"
    assert calls == ["key-one", "key-two"]


def test_one_key_only_keeps_the_old_behaviour(monkeypatch):
    monkeypatch.delenv("GNANI_API_KEY_2")
    net = PerKey(key_one={"transcript": "ok"})
    monkeypatch.setattr(gw, "_request", net)
    assert gw.stt(wav(), "kn")["text"] == "ok" and net.calls == ["key-one"]
