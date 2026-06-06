from __future__ import annotations

import argparse
import asyncio
import base64
import io
import math
import os
import wave
from dataclasses import dataclass
from typing import Any, Iterator

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


app = FastAPI(title="Crix Voice Service", version="0.1.0")

# Allow the standalone audition page (file:// / localhost) and the Tauri webview
# (tauri://localhost) to call /voices and open the /tts socket.
# Loopback-only service: allow the Tauri webview, localhost, and the file://
# audition page (which reports a "null" origin) — but not arbitrary web pages.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null"],
    allow_origin_regex=r"(tauri|https?)://(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Break a chunk into per-sentence segments for incremental streaming.
SENTENCE_SPLIT = r"(?<=[.!?…。！？])\s+|\n+"

# Canonical Kokoro-82M English voice catalog. `lang` is the KPipeline lang_code
# derived from the id prefix (a = American, b = British); `tier` is the published
# training grade (A best). These are the voices best suited to an English entity.
VOICE_CATALOG: list[dict[str, Any]] = [
    # American English (lang_code 'a')
    {"id": "af_heart", "label": "Heart", "gender": "female", "lang": "a", "accent": "US", "tier": "A", "character": "Warm, grounded — the flagship default."},
    {"id": "af_bella", "label": "Bella", "gender": "female", "lang": "a", "accent": "US", "tier": "A", "character": "Bright, expressive, lively."},
    {"id": "af_nicole", "label": "Nicole", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Soft, intimate, close-mic."},
    {"id": "af_aoede", "label": "Aoede", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Clear, musical, measured."},
    {"id": "af_kore", "label": "Kore", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Composed, even, narration-ready."},
    {"id": "af_sarah", "label": "Sarah", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Natural, conversational."},
    {"id": "af_nova", "label": "Nova", "gender": "female", "lang": "a", "accent": "US", "tier": "B", "character": "Cool, modern, assistant-like."},
    {"id": "af_sky", "label": "Sky", "gender": "female", "lang": "a", "accent": "US", "tier": "C", "character": "Light, airy."},
    {"id": "am_michael", "label": "Michael", "gender": "male", "lang": "a", "accent": "US", "tier": "B", "character": "Steady, confident — a solid Jarvis base."},
    {"id": "am_fenrir", "label": "Fenrir", "gender": "male", "lang": "a", "accent": "US", "tier": "B", "character": "Deep, commanding — Ultron-leaning."},
    {"id": "am_puck", "label": "Puck", "gender": "male", "lang": "a", "accent": "US", "tier": "B", "character": "Playful, agile, sharp."},
    {"id": "am_echo", "label": "Echo", "gender": "male", "lang": "a", "accent": "US", "tier": "C", "character": "Resonant, calm."},
    {"id": "am_onyx", "label": "Onyx", "gender": "male", "lang": "a", "accent": "US", "tier": "C", "character": "Dark, weighty."},
    # British English (lang_code 'b')
    {"id": "bf_emma", "label": "Emma", "gender": "female", "lang": "b", "accent": "UK", "tier": "B", "character": "Refined, warm British."},
    {"id": "bf_isabella", "label": "Isabella", "gender": "female", "lang": "b", "accent": "UK", "tier": "B", "character": "Elegant, articulate."},
    {"id": "bm_george", "label": "George", "gender": "male", "lang": "b", "accent": "UK", "tier": "B", "character": "Distinguished, butler-grade — peak Jarvis."},
    {"id": "bm_fable", "label": "Fable", "gender": "male", "lang": "b", "accent": "UK", "tier": "B", "character": "Storyteller, rich timbre."},
    {"id": "bm_lewis", "label": "Lewis", "gender": "male", "lang": "b", "accent": "UK", "tier": "C", "character": "Measured, formal."},
]

_VOICE_LANG = {v["id"]: v["lang"] for v in VOICE_CATALOG}


@dataclass(frozen=True)
class VoiceSettings:
    host: str
    port: int
    engine: str
    voice: str
    lang: str
    speed: float
    device: str
    language: str
    mock: bool


class MockSynth:
    name = "mock"

    def stream(self, text: str, _: dict[str, Any]) -> Iterator[tuple[bytes, int]]:
        sample_rate = 24_000
        duration = min(1.2, max(0.22, len(text) / 90))
        samples = int(sample_rate * duration)
        t = np.linspace(0, duration, samples, endpoint=False)
        freq = 220 + (sum(ord(ch) for ch in text[:24]) % 180)
        envelope = np.minimum(1, np.linspace(0, 12, samples)) * np.minimum(1, np.linspace(12, 0, samples))
        wav = 0.18 * np.sin(2 * math.pi * freq * t) * envelope
        yield wav_to_bytes(wav, sample_rate), sample_rate


class KokoroSynth:
    """Kokoro-82M: real-time local TTS (RTF ~0.03 on GPU). Default engine."""

    def __init__(self, settings: VoiceSettings) -> None:
        from kokoro import KPipeline

        self._KPipeline = KPipeline
        self.settings = settings
        self.voice = settings.voice
        self.sample_rate = 24_000
        self.name = f"kokoro:{settings.voice}"

        device = settings.device
        if device.startswith("cuda"):
            try:
                import torch

                if not torch.cuda.is_available():
                    device = "cpu"
            except Exception:
                device = "cpu"
        self.device = device
        # One KPipeline per lang_code, built lazily — so any catalog voice (US or
        # British) is pronounced with the right G2P backend, not a fixed lang.
        self._pipelines: dict[str, Any] = {}
        # Warm the default voice's pipeline + G2P so the first real reply is fast.
        try:
            for _ in self._pipeline_for(self.voice)("Ready.", voice=self.voice):
                pass
        except Exception:
            pass

    def _lang_for(self, voice: str) -> str:
        return _VOICE_LANG.get(voice, voice[:1] if voice[:1] in "abefhijpz" else self.settings.lang)

    def _pipeline_for(self, voice: str) -> Any:
        lang = self._lang_for(voice)
        pipeline = self._pipelines.get(lang)
        if pipeline is None:
            pipeline = self._KPipeline(lang_code=lang, repo_id="hexgrad/Kokoro-82M", device=self.device)
            self._pipelines[lang] = pipeline
        return pipeline

    def stream(self, text: str, overrides: dict[str, Any]) -> Iterator[tuple[bytes, int]]:
        """Yield one WAV per Kokoro segment as soon as it is rendered, so the
        client can start speaking the first phrase while the rest synthesizes."""
        voice = str(overrides.get("voice") or self.voice)
        try:
            speed = float(overrides.get("speed") or self.settings.speed)
        except (TypeError, ValueError):
            speed = self.settings.speed

        produced = False
        pipeline = self._pipeline_for(voice)
        # Split on sentence boundaries (not just newlines) so each sentence is a
        # separate segment that streams the moment it is rendered.
        for _, _, audio in pipeline(text, voice=voice, speed=speed, split_pattern=SENTENCE_SPLIT):
            arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio, dtype=np.float32)
            arr = np.asarray(arr, dtype=np.float32)
            if arr.size == 0:
                continue
            produced = True
            yield wav_to_bytes(arr, self.sample_rate), self.sample_rate

        if not produced:
            yield wav_to_bytes(np.zeros(1, dtype=np.float32), self.sample_rate), self.sample_rate


def wav_to_bytes(wav: Any, sample_rate: int) -> bytes:
    if hasattr(wav, "detach"):
        wav = wav.detach().cpu().numpy()
    data = np.asarray(wav, dtype=np.float32)
    if data.ndim == 2 and data.shape[0] <= 8 and data.shape[0] < data.shape[1]:
        data = data.T
    if data.ndim == 1:
        channels = 1
    elif data.ndim == 2:
        channels = data.shape[1]
    else:
        raise ValueError(f"unsupported wav shape: {data.shape}")
    pcm = (np.clip(data, -1.0, 1.0) * 32767).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())
    return output.getvalue()


def parse_args() -> VoiceSettings:
    parser = argparse.ArgumentParser(description="Crix Kokoro-82M TTS WebSocket sidecar")
    parser.add_argument("--host", default=os.environ.get("CRIX_TTS_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("CRIX_TTS_PORT", "8765")))
    parser.add_argument("--engine", choices=["kokoro", "mock"], default=os.environ.get("CRIX_TTS_ENGINE", "kokoro"))
    parser.add_argument("--voice", default=os.environ.get("CRIX_TTS_VOICE", "af_heart"))
    parser.add_argument("--lang", default=os.environ.get("CRIX_TTS_LANG", "a"))
    parser.add_argument("--speed", type=float, default=float(os.environ.get("CRIX_TTS_SPEED", "1.15")))
    parser.add_argument("--device", default=os.environ.get("CRIX_TTS_DEVICE", "cuda:0"))
    parser.add_argument("--language", default=os.environ.get("CRIX_TTS_LANGUAGE", "English"))
    parser.add_argument("--mock", action="store_true")
    args = parser.parse_args()
    return VoiceSettings(
        host=args.host,
        port=args.port,
        engine=args.engine,
        voice=args.voice,
        lang=args.lang,
        speed=args.speed,
        device=args.device,
        language=args.language,
        mock=bool(args.mock),
    )


def build_synth(settings: VoiceSettings) -> MockSynth | KokoroSynth:
    if settings.mock or settings.engine == "mock":
        return MockSynth()
    return KokoroSynth(settings)


@app.get("/voices")
async def voices() -> dict[str, Any]:
    settings: VoiceSettings | None = getattr(app.state, "settings", None)
    return {
        "voices": VOICE_CATALOG,
        "default": settings.voice if settings else "af_heart",
        "speed": settings.speed if settings else 1.15,
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    settings: VoiceSettings | None = getattr(app.state, "settings", None)
    synth = getattr(app.state, "synth", None)
    return {
        "ok": synth is not None,
        "engine": settings.engine if settings else None,
        "model": getattr(synth, "name", None),
        "mock": bool(settings.mock) if settings else None,
    }


@app.websocket("/tts")
async def tts_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    synth = getattr(app.state, "synth", None)
    settings: VoiceSettings = app.state.settings
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=64)
    cancel_state = {"version": 0}
    worker = asyncio.create_task(tts_worker(websocket, queue, cancel_state))

    await websocket.send_json({
        "type": "ready",
        "engine": settings.engine,
        "model": getattr(synth, "name", None),
        "speaker": settings.voice,
        "language": settings.language,
        "mock": settings.mock,
    })

    try:
        while True:
            payload = await websocket.receive_json()
            message_type = payload.get("type")
            if message_type == "cancel":
                cancel_state["version"] += 1
                drain_queue(queue)
                await websocket.send_json({"type": "cancelled"})
                continue

            if message_type != "speak":
                await websocket.send_json({"type": "error", "message": f"unknown message type: {message_type}"})
                continue

            text = str(payload.get("text") or "").strip()
            if not text:
                continue

            try:
                queue.put_nowait(payload)
                await websocket.send_json({"type": "queued", "id": payload.get("id"), "depth": queue.qsize()})
            except asyncio.QueueFull:
                await websocket.send_json({"type": "error", "id": payload.get("id"), "message": "tts queue is full"})
    except WebSocketDisconnect:
        pass
    finally:
        await queue.put(None)
        worker.cancel()


async def tts_worker(
    websocket: WebSocket,
    queue: asyncio.Queue[dict[str, Any] | None],
    cancel_state: dict[str, int],
) -> None:
    synth = app.state.synth
    while True:
        payload = await queue.get()
        if payload is None:
            return

        version = cancel_state["version"]
        request_id = payload.get("id")
        text = str(payload.get("text") or "").strip()
        await websocket.send_json({"type": "started", "id": request_id})

        try:
            async for audio, sample_rate in stream_synth(synth, text, payload):
                if version != cancel_state["version"]:
                    break
                await websocket.send_json({
                    "type": "audio",
                    "id": request_id,
                    "mime": "audio/wav",
                    "sampleRate": sample_rate,
                    "audio": base64.b64encode(audio).decode("ascii"),
                })
            if version == cancel_state["version"]:
                await websocket.send_json({"type": "done", "id": request_id})
        except Exception as error:
            await websocket.send_json({"type": "error", "id": request_id, "message": str(error)})


async def stream_synth(synth: Any, text: str, overrides: dict[str, Any]):
    """Drive a synchronous segment generator off the event loop, yielding each
    rendered segment as it completes so audio can be sent incrementally."""
    generator = synth.stream(text, overrides)
    sentinel = object()

    def take_next() -> Any:
        try:
            return next(generator)
        except StopIteration:
            return sentinel

    while True:
        item = await asyncio.to_thread(take_next)
        if item is sentinel:
            return
        yield item


def drain_queue(queue: asyncio.Queue[dict[str, Any] | None]) -> None:
    while True:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            return


def main() -> None:
    settings = parse_args()
    app.state.settings = settings
    app.state.synth = build_synth(settings)
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
