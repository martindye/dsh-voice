"""Qwen3 1.7B Base Q8 engine — the GPU voice.

Clones from registered reference voices via the qwentts.cpp server
(tts-server.exe, shipped in the plugin's bin directory). The server reuses a
compatible instance already listening on 127.0.0.1:8095 (adopted instead of
starting a second one) and starts one from the bundled executable otherwise.

Model files under VOICE_CHAT_MODEL_ROOT/qwen3:
    qwen-talker-1.7b-base-Q8_0.gguf      the 1.7B talker
    qwen-tokenizer-12hz-Q8_0.gguf        the 12 Hz tokenizer

Voices are the registered references shipped with the plugin:
    "pocket"    the standard small voice (default)
    "warm-brit" the warm British female reference
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import subprocess
import time
import wave
from pathlib import Path

import numpy as np
import requests

# --------------------------------------------------------------- locations
MODEL_ROOT = Path(os.environ.get(
    "VOICE_CHAT_MODEL_ROOT",
    str(Path.home() / ".dsh" / "voice-chat" / "models")))
MODEL_DIR = Path(os.environ.get("VOICE_CHAT_QWEN_MODEL_DIR", str(MODEL_ROOT / "qwen3")))
MODEL = MODEL_DIR / "qwen-talker-1.7b-base-Q8_0.gguf"
CODEC = MODEL_DIR / "qwen-tokenizer-12hz-Q8_0.gguf"
SERVER = Path(os.environ.get(
    "VOICE_CHAT_QWEN_SERVER",
    str(Path(os.environ.get("VOICE_CHAT_BIN_DIR", Path(__file__).resolve().parent.parent.parent / "bin")) / "tts-server.exe")))
REF_DIR = Path(os.environ.get("VOICE_CHAT_REF_DIR",
                              Path(__file__).resolve().parent.parent.parent / "ref_voices"))
STATE_DIR = Path(os.environ.get(
    "VOICE_CHAT_STATE_DIR", str(Path.home() / ".dsh" / "voice-chat" / "state"))).expanduser()
LOG_FILE = STATE_DIR / "qwen3_server.log"
STATE_FILE = STATE_DIR / "qwen3_server.json"

URL = "http://127.0.0.1:8095"
ALIAS = "ttstt-qwen3-base-q8"  # shared alias: adopts a resident compatible server
VOICE = "pocket"
DEFAULT_VOICES = ("pocket", "warm-brit")

# The 8095 server caps a generation at max_new_tokens=768 (~60 s of audio at
# 12 Hz), so long text is sent sentence by sentence and concatenated.
_MAX_SENTENCE_CHARS = 280
_SPLIT = re.compile(r'(?<=[.!?])(?=["\')\]]*(?:\s|$))')


def _sentences(text, limit: int = _MAX_SENTENCE_CHARS) -> list[str]:
    text = " ".join((text or "").split())
    if not text:
        return []
    out: list[str] = []
    for piece in _SPLIT.split(text):
        piece = piece.strip()
        if not piece:
            continue
        while len(piece) > limit:  # no terminal punctuation: hard cap
            cut = piece.rfind(" ", 1, limit)
            if cut <= 0:
                cut = limit
            out.append(piece[:cut].strip())
            piece = piece[cut:].strip()
        if piece:
            out.append(piece)
    return out


def _session():
    session = requests.Session()
    session.trust_env = False  # local speech must never go through a proxy
    return session


def _ready(session) -> bool:
    try:
        response = session.get(URL + "/v1/models", timeout=2)
    except requests.ConnectionError:
        return False
    response.raise_for_status()
    ids = [item.get("id") for item in response.json().get("data", [])]
    if ids != [ALIAS]:
        raise RuntimeError(f"Port 8095 has a different speech model: {ids}")
    return True


# ------------------------------------------------------------- references
def _as_24k_wav(raw: bytes) -> bytes:
    """Re-encode any WAV as mono 16-bit 24 kHz (the extractor's input)."""
    with wave.open(io.BytesIO(raw), "rb") as src:
        channels = src.getnchannels()
        width = src.getsampwidth()
        rate = src.getframerate()
        frames = src.readframes(src.getnframes())
    if width == 2:
        samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        samples = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported WAV bit depth: {width * 8}")
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 24000:
        n_out = max(1, int(len(samples) * 24000 / rate))
        pos = np.clip((np.arange(n_out) + 0.5) * (len(samples) / n_out) - 0.5,
                      0, len(samples) - 1.0001)
        i0 = pos.astype(int)
        frac = pos - i0
        samples = samples[i0] * (1 - frac) + samples[i0 + 1] * frac
    pcm16 = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    out = io.BytesIO()
    with wave.open(out, "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(2)
        dst.setframerate(24000)
        dst.writeframes(pcm16.tobytes())
    return out.getvalue()


def _register(session, name, wav_bytes, ref_text):
    payload = {"name": name, "wav_b64": base64.b64encode(wav_bytes).decode("ascii")}
    if ref_text:
        payload["ref_text"] = ref_text  # enables ICL clone mode
    response = session.post(URL + "/v1/audio/voices", json=payload, timeout=180)
    response.raise_for_status()


def _register_references(session):
    """Register the kit's reference voices; idempotent (reuses live entries)."""
    listing = session.get(URL + "/v1/audio/voices", timeout=10)
    listing.raise_for_status()
    present = {v.get("name") for v in listing.json().get("voices", [])}
    for name in ("warm-brit", "pocket"):
        wav_path = REF_DIR / f"{name}.wav"
        if name in present or not wav_path.is_file():
            continue
        text_path = REF_DIR / f"{name}.txt"
        text = text_path.read_text(encoding="utf-8").strip() if text_path.is_file() else None
        _register(session, name, _as_24k_wav(wav_path.read_bytes()), text)


# ------------------------------------------------------------------ server
def ensure_server() -> None:
    """Adopt a compatible resident server, or start the bundled one hidden."""
    with _session() as session:
        if _ready(session):
            return
        for path in (SERVER, MODEL, CODEC):
            if not path.is_file():
                raise FileNotFoundError(
                    f"Qwen3 voice setup is incomplete: {path} is missing "
                    "(choose the high-quality voice to download it)")
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        logs = STATE_DIR
        env = dict(os.environ, GGML_BACKEND="CUDA0")
        args = [str(SERVER), "--model", str(MODEL), "--codec", str(CODEC),
                "--host", "127.0.0.1", "--port", "8095", "--alias", ALIAS,
                "--lang", "English", "--max-batch", "1"]
        with (logs / "qwen3_server.log").open("ab") as out:
            process = subprocess.Popen(
                args, cwd=str(SERVER.parent), env=env, stdin=subprocess.DEVNULL,
                stdout=out, stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        STATE_FILE.write_text(json.dumps({"pid": process.pid, "model": str(MODEL),
                                          "url": URL, "alias": ALIAS}), encoding="utf8")
        try:
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(
                        "Qwen3 server exited at startup; see "
                        f"{logs / 'qwen3_server.log'} (no NVIDIA GPU?)")
                if _ready(session):
                    # Registration blocks on the compute worker until the
                    # speaker encoder has run, so it doubles as warmup.
                    _register_references(session)
                    return
                time.sleep(0.25)
            raise TimeoutError("Qwen3 server did not become ready within 180 s")
        except BaseException:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            raise


class Qwen3GGUFBase:
    """1.7B Base talker cloning from a registered reference voice."""

    sample_rate = 24000

    def __init__(self, voice: str = VOICE):
        self.voice = voice
        ensure_server()

    def stream_sentence(self, sentence, stop_event=None):
        if stop_event is not None and stop_event.is_set():
            return
        with _session() as session:
            response = session.post(URL + "/v1/audio/speech", json={
                "model": ALIAS, "input": sentence, "language": "English",
                "voice": self.voice, "response_format": "wav",
                "seed": 42, "max_new_tokens": 768,
            }, timeout=(5, 180))
            response.raise_for_status()
            with wave.open(io.BytesIO(response.content), "rb") as wav:
                if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 24000):
                    raise ValueError("Expected mono 16-bit 24 kHz WAV from Qwen server")
                frames = wav.readframes(wav.getnframes())
        if stop_event is not None and stop_event.is_set():
            return
        if not frames:
            raise RuntimeError("Qwen server returned empty audio")
        audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
        yield audio


class Qwen3Engine:
    name = "qwen3ggufbase"
    default_voice = "pocket"

    def __init__(self) -> None:
        self._lock = __import__("threading").Lock()
        self._impl = None
        self._voice: str | None = None
        self._loaded = False
        self._cooldown_until = 0.0
        self._now = time.time

    def _ensure(self, voice: str) -> None:
        if self._loaded and self._voice == voice:
            return
        if self._now() < self._cooldown_until:
            raise RuntimeError("qwen3ggufbase cooling down after a failed start")
        try:
            self._impl = Qwen3GGUFBase(voice=voice)
            self._voice = voice
            self._loaded = True
        except Exception:
            self._cooldown_until = self._now() + 120
            raise

    # ------------------------------------------------------------ lifecycle
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        with self._lock:
            self._ensure(self._voice or self.default_voice)

    # ------------------------------------------------------------------ api
    def voices(self) -> list[str]:
        return list(DEFAULT_VOICES)

    def synthesize(self, text, voice):
        """Render `text` -> (mono float32 samples in [-1, 1], sample_rate)."""
        text = (text or "").strip()
        if not text:
            raise ValueError("empty text")
        with self._lock:  # one voice at a time across concurrent requests
            self._ensure(voice if voice in ("pocket", "warm-brit") else self.default_voice)
            impl = self._impl
            chunks = []
            for sentence in _sentences(text):
                for audio in impl.stream_sentence(sentence, None):
                    chunks.append(audio)
        if not chunks:
            raise RuntimeError("Qwen3 TTS returned no audio")
        return np.concatenate(chunks), int(impl.sample_rate)


from . import register  # noqa: E402

register(Qwen3Engine())
