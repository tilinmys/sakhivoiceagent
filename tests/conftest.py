"""Shared pytest fixtures.

No conftest.py existed before this - confirmed by its absence turning into a
real gap: `agent.build_turn_handling()` constructs `MultilingualModel()`,
which (livekit-plugins-turn-detector, currently installed version) hard-
requires a real `JobContext` to build at all - `base.py`'s own constructor
reads `get_job_context().inference_executor` unconditionally. A full
JobContext needs a live JobProcess, RunningJobInfo, an rtc.Room, and
shutdown/connect callbacks - nothing a config-shape unit test should ever
have to build just to inspect the dict build_turn_handling() returns.

Confirmed this is a real, unconditional SDK requirement (not something any
change in this repo caused): `MultilingualModel()` raises the identical
RuntimeError outside a job context on a clean interpreter with no project
code imported at all.
"""

import asyncio
import os
import sys

import pytest

# psycopg's async mode cannot run on asyncio's ProactorEventLoop, Windows'
# default. The production worker runs on Linux (selector loop) and is
# unaffected, but it meant the live-Postgres tests (SAKHI_TEST_POSTGRES_DSN)
# had never actually been able to run on a Windows dev box - every one
# errored in load(). Scoped to exactly that case so the default suite keeps
# running on the platform's normal loop.
if sys.platform == "win32" and os.getenv("SAKHI_TEST_POSTGRES_DSN"):
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# Turn-timing CONFIG tests (test_conversation_feel.py) check the deployed
# values, not code defaults. Without a .env, run them against the production
# tuning (deploy/aws/sakhi-turn-tuning.env) - a developer's own .env or shell
# still wins because these are setdefault().
for _key, _value in {
    "VAD_MIN_SILENCE": "0.45",
    "MIN_ENDPOINTING_DELAY": "0.35",
    "VAD_ENDPOINT_SLOW_S": "1.0",
    "LATENT_FILLER_DELAY": "2.0",
}.items():
    os.environ.setdefault(_key, _value)


class _FakeJobContext:
    """The only attribute turn_detector/base.py's constructor reads."""
    inference_executor = None


@pytest.fixture
def fake_job_context(monkeypatch):
    """Opt-in, not autouse: a test that legitimately wants to see the real
    "no job context found" RuntimeError (verifying build_turn_handling()
    behaves correctly when actually misused outside a job) must still see
    it - blanket-patching this for the whole suite would silently hide
    that failure mode instead of testing it.

    Patched on turn_detector.base's own name, not livekit.agents.job's:
    `from livekit.agents.job import get_job_context` in base.py is a name
    import, so patching the origin module's function leaves base.py's
    already-bound reference untouched.
    """
    monkeypatch.setattr(
        "livekit.plugins.turn_detector.base.get_job_context",
        lambda: _FakeJobContext(),
    )
