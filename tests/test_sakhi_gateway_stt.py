"""Gateway STT: Gnani /stt/v3, with the sakhi_audio clean-up and a second listen on an empty result.

No network: sakhi_gateway._request is replaced by a fake that records every call.
"""

from __future__ import annotations

import json
import struct

import numpy as np
import pytest

import sakhi_audio as sa
import sakhi_gateway as gw

STT_URL = f"{gw.GNANI_BASE}/stt/v3"


def wav(seconds: float = 1.0, voiced: bool = True, amp: float = 3000) -> bytes:
    n = int(16000 * seconds)
    t = np.arange(n) / 16000
    x = np.zeros(n)
    if voiced:  # a syllable-like tone: 0.6 s of 180 Hz + harmonics in the middle
        on = (t > 0.2) & (t < 0.8)
        x[on] = amp * (np.sin(2 * np.pi * 180 * t[on]) + 0.5 * np.sin(2 * np.pi * 360 * t[on]))
    return sa.wav(np.clip(x, -32768, 32767).astype(np.int16))


class FakeNet:
    """Answers Gnani STT with the queued replies (dict -> JSON, Exception -> raised)."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls: list[tuple[str, bytes, dict, float]] = []

    def __call__(self, url, body, headers, timeout):
        self.calls.append((url, body, headers, timeout))
        assert url == STT_URL, f"STT went somewhere else: {url}"
        r = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(r, Exception):
            raise r
        return json.dumps(r).encode()


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("GNANI_API_KEY", "test-key")
    monkeypatch.delenv("GNANI_API_KEY_2", raising=False)  # one key here; two keys: test_sakhi_gateway_keys.py


def field(body: bytes, name: str) -> str:
    """A multipart text field's value."""
    marker = f'name="{name}"'.encode()
    at = body.index(marker)
    start = body.index(b"\r\n\r\n", at) + 4
    return body[start:body.index(b"\r\n", start)].decode()


def test_stt_is_gnani_with_the_app_shape(monkeypatch):
    net = FakeNet({"transcript": "ನನಗೆ ಇಪ್ಪತ್ನಾಲ್ಕು ವರ್ಷ"})
    monkeypatch.setattr(gw, "_request", net)
    out = gw.stt(wav(), "kn")
    assert out["text"] == "ನನಗೆ ಇಪ್ಪತ್ನಾಲ್ಕು ವರ್ಷ" and out["provider"] == "gnani" and out["lang"] == "kn"
    assert set(out) >= {"text", "en", "ms", "provider", "lang", "passes", "speech_ms"}
    url, body, headers, timeout = net.calls[0]
    assert headers["X-API-Key-ID"] == "test-key"
    assert field(body, "language_code") == "kn-IN" and field(body, "format") == "transcribe"
    assert timeout < 8.0  # under the app's 8 s
    assert out["passes"] == 1


@pytest.mark.parametrize("lang, code", [("kn", "kn-IN"), ("hi", "hi-IN"), ("en", "en-IN")])
def test_each_language_gets_its_code(monkeypatch, lang, code):
    net = FakeNet({"transcript": "ok"})
    monkeypatch.setattr(gw, "_request", net)
    gw.stt(wav(), lang)
    assert field(net.calls[0][1], "language_code") == code


def test_english_answer_fills_en(monkeypatch):
    monkeypatch.setattr(gw, "_request", FakeNet({"transcript": "I am 24 years old"}))
    assert gw.stt(wav(), "en")["en"] == "I am 24 years old"
    monkeypatch.setattr(gw, "_request", FakeNet({"transcript": "मैं 24 साल की हूँ"}))
    assert gw.stt(wav(), "hi")["en"] == ""


def test_empty_result_with_speech_gets_a_second_stronger_listen(monkeypatch):
    net = FakeNet({"transcript": ""}, {"transcript": "ಇಪ್ಪತ್ತು"})
    monkeypatch.setattr(gw, "_request", net)
    out = gw.stt(wav(), "kn")
    assert out["text"] == "ಇಪ್ಪತ್ತು" and out["passes"] == 2 and len(net.calls) == 2
    assert net.calls[0][1] != net.calls[1][1]  # a different view of the audio, not the same request


def test_silence_is_not_listened_to_twice(monkeypatch):
    net = FakeNet({"transcript": ""})
    monkeypatch.setattr(gw, "_request", net)
    out = gw.stt(wav(voiced=False), "kn")
    assert out["text"] == "" and out["passes"] == 1 and len(net.calls) == 1


def test_soft_voice_is_raised_before_upload(monkeypatch):
    net = FakeNet({"transcript": "ok"})
    monkeypatch.setattr(gw, "_request", net)
    gw.stt(wav(amp=120), "hi")  # about -50 dBFS: a voice from across the room
    body = net.calls[0][1]
    pcm = sa.decode(body[body.index(b"RIFF"):])
    assert np.abs(pcm).max() > 120 * 8  # raised by well over 18 dB


def test_adpcm_upload_is_accepted(monkeypatch):
    """The app uploads 4-bit IMA-ADPCM (format 0x11); the gateway decodes it."""
    pcm = sa.decode(wav())
    spb = 505
    blocks = bytearray()
    for s in range(0, len(pcm), spb):  # silent ADPCM blocks of the right shape (pred 0, index 0)
        blocks += struct.pack("<hBB", 0, 0, 0) + bytes(252)
    fmt = struct.pack("<HHIIHHHH", 0x11, 1, 16000, 8110, 256, 4, 2, spb)
    body = b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(blocks)) + b"WAVEfmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(blocks)) + bytes(blocks)
    assert len(sa.decode(body)) >= len(pcm)
    net = FakeNet({"transcript": ""})
    monkeypatch.setattr(gw, "_request", net)
    assert gw.stt(body, "kn")["text"] == ""


@pytest.mark.parametrize(
    "failure, status",
    [
        (gw.GatewayError(504, "Voice provider unreachable."), 504),
        (ConnectionResetError("reset"), 504),
    ],
)
def test_provider_failure_is_a_retryable_error(monkeypatch, failure, status):
    monkeypatch.setattr(gw, "_request", FakeNet(failure))
    with pytest.raises(gw.GatewayError) as err:
        gw.stt(wav(), "kn")
    assert err.value.status == status and status >= 500  # the app retries 5xx, then keeps the answer offline


def test_without_a_key_stt_is_not_configured(monkeypatch):
    monkeypatch.delenv("GNANI_API_KEY")
    net = FakeNet({"transcript": "x"})
    monkeypatch.setattr(gw, "_request", net)
    with pytest.raises(gw.GatewayError) as err:
        gw.stt(wav(), "hi")
    assert err.value.status == 503 and net.calls == []
    assert gw.health()["stt"] is False


def test_health_reports_gnani_for_stt():
    h = gw.health()
    assert h["stt"] is True and h["stt_provider"] == "gnani"


def test_no_self_hosted_model_path_left():
    assert not hasattr(gw, "INDIC_STT_URL") and not hasattr(gw, "_indic_stt")


def test_input_checks_run_before_any_call(monkeypatch):
    net = FakeNet({"transcript": "x"})
    monkeypatch.setattr(gw, "_request", net)
    for body, lang in ((b"not a wav", "kn"), (wav(), "ta")):
        with pytest.raises(gw.GatewayError) as err:
            gw.stt(body, lang)
        assert err.value.status == 400
    assert net.calls == []


def test_hotword_bias_is_off_by_default(monkeypatch):
    monkeypatch.delenv("SAKHI_STT_BIAS_SCORE", raising=False)
    net = FakeNet({"transcript": "ok"})
    monkeypatch.setattr(gw, "_request", net)
    gw.stt(wav(), "kn")
    assert b"bias_list" not in net.calls[0][1]


@pytest.mark.parametrize("lang, code, word", [("kn", "kn-IN", "ತಲೆನೋವು"), ("hi", "hi-IN", "सिरदर्द"), ("en", "en-IN", "haemoglobin")])
def test_hotword_bias_when_switched_on(monkeypatch, lang, code, word):
    monkeypatch.setenv("SAKHI_STT_BIAS_SCORE", "1.0")
    net = FakeNet({"transcript": "ok"})
    monkeypatch.setattr(gw, "_request", net)
    gw.stt(wav(), lang)
    body = net.calls[0][1]
    assert field(body, "bias_score") == "1.0"
    words = json.loads(field(body, "bias_list"))
    assert word in words and len(words) <= 100
    assert all(" " not in w and not any(ch.isdigit() for ch in w) for w in words)  # Gnani: single words, letters only


def test_an_invalid_bias_score_is_off(monkeypatch):
    monkeypatch.setenv("SAKHI_STT_BIAS_SCORE", "3")
    net = FakeNet({"transcript": "ok"})
    monkeypatch.setattr(gw, "_request", net)
    gw.stt(wav(), "hi")
    assert b"bias_list" not in net.calls[0][1]
