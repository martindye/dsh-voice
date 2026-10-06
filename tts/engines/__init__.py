"""Pluggable TTS engines for the kit TTS server (tts/server.py).

An engine is any object implementing:

    name: str                          stable engine id (e.g. "pocket")
    load() -> None                     load model resources (idempotent)
    is_loaded() -> bool
    voices() -> list[str]              available voice ids
    synthesize(text, voice) -> (samples, sample_rate)
                                       mono float32 in [-1, 1]

Drop a new module in this directory, register it, and it becomes available
through the server automatically — the server, the host and the client stay
engine-agnostic.

Registration order sets the fallback order (the host normally names the
engine explicitly from the user's consented choice).
"""
from __future__ import annotations

_REGISTRY: list = []


def register(engine) -> None:
    """Register one engine instance (duplicate names are ignored)."""
    if any(e.name == engine.name for e in _REGISTRY):
        return
    _REGISTRY.append(engine)


def engines() -> list:
    return list(_REGISTRY)


def get(name):
    return next((e for e in _REGISTRY if e.name == name), None)


# qwen3 first (the consented GPU voice when its model is present), pocket as
# the always-available CPU fallback.
from . import qwen3  # noqa: E402,F401
from . import pocket  # noqa: E402,F401
