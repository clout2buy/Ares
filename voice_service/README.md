# Crix Voice Service

Local WebSocket sidecar for low-latency spoken replies in the Crix desktop app.

The engine is **Kokoro-82M** — a small, fast, high-quality local TTS that runs
comfortably faster than real time (RTF ~0.03 on GPU, ~real-time on CPU), which is
what makes streamed spoken replies feel instant. First-audio latency is ~250ms.

## Setup

Use a clean Python 3.12 environment.

```powershell
cd D:\Crix
python -m venv .crix\voice-venv
.\.crix\voice-venv\Scripts\Activate.ps1
pip install -r voice_service\requirements.txt
```

## Run

```powershell
pnpm voice:tts -- --device cuda:1 --voice af_heart
```

On this machine, PyTorch reports `cuda:0` as the RTX 4060 and `cuda:1` as the
RTX 5060 Ti. Kokoro is tiny, so either GPU (or even `--device cpu`) is fine.

The desktop app connects to:

```text
ws://127.0.0.1:8765/tts
```

### Voices

Kokoro voices are passed via `--voice` (e.g. `af_heart`, `af_bella`, `am_michael`,
`am_adam`, `bf_emma`, `bm_george`). `--lang a` is American English; `b` is British.
See the Kokoro-82M model card for the full voice list.

### Plumbing test

```powershell
# No model load — emits a synthetic tone so you can verify the WS wiring.
pnpm voice:tts -- --engine mock
```

## Configuration

All flags have `CRIX_TTS_*` environment-variable equivalents:

- `--engine` / `CRIX_TTS_ENGINE` (`kokoro` | `mock`, default `kokoro`)
- `--voice` / `CRIX_TTS_VOICE` (default `af_heart`)
- `--lang` / `CRIX_TTS_LANG` (default `a`)
- `--speed` / `CRIX_TTS_SPEED` (speaking rate, default `1.15`; 1.0 = normal)
- `--device` / `CRIX_TTS_DEVICE` (default `cuda:0`)
- `--port` / `CRIX_TTS_PORT` (default `8765`)
