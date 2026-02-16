# Hardware Requirements & Deployment Options

Vexa supports three deployment modes depending on your hardware and budget. Choose the one that fits your situation.

---

## Deployment Modes at a Glance

| Mode | Transcription runs on | GPU needed? | Best for |
|------|----------------------|-------------|----------|
| **All-in-One GPU** | Local NVIDIA GPU | ✅ Yes | Full control, lowest latency, air-gapped environments |
| **Cloud Provider** | Cloud API (OpenAI, Groq, Fireworks, etc.) | ❌ No | Quick start, no GPU investment, pay-per-use |
| **Remote Server** | Your own remote machine (any hardware) | ❌ On this machine | Flexible — Mac with MLX, separate GPU server, whisper.cpp, etc. |

All three modes run the same core services (API gateway, bot-manager, Redis, Postgres). The only difference is **where audio gets transcribed**.

---

## Mode 1: All-in-One GPU

Everything runs on a single machine with an NVIDIA GPU.

```
┌─────────────────────────────────────────┐
│              Single Server              │
│                                         │
│  API Gateway ── Bot Manager ── Bot      │
│  Admin API ── Collector ── Redis ── PG  │
│  WhisperLive (faster-whisper + CUDA)    │
│                 ▼                       │
│            NVIDIA GPU                   │
└─────────────────────────────────────────┘
```

### Hardware Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **CPU** | 4 cores | 8+ cores |
| **RAM** | 16 GB | 32 GB |
| **GPU** | NVIDIA 8 GB VRAM (RTX 3060) | NVIDIA 16+ GB VRAM (RTX 4070+, A4000, RTX 4000 SFF Ada) |
| **Disk** | 40 GB | 80 GB (models + Docker images) |
| **OS** | Linux (Ubuntu 22.04+) | Linux (Ubuntu 24.04) |

### Concurrent Meeting Capacity

| GPU VRAM | Model | ~Concurrent Meetings |
|----------|-------|---------------------|
| 8 GB | `small` / `base` | 3–5 |
| 12 GB | `medium` | 5–8 |
| 16 GB | `large-v3` | 8–12 |
| 20+ GB | `large-v3-turbo` | 12–20+ |

### Configuration

```env
DEVICE_TYPE=gpu                    # ← Use local GPU
WHISPER_MODEL_SIZE=large-v3-turbo  # Adjust based on VRAM
```

Docker Compose profile: `--profile gpu`

### Pros & Cons

✅ Lowest latency, full data control, works offline/air-gapped
❌ Requires NVIDIA GPU, higher upfront cost, Linux only

---

## Mode 2: Cloud Transcription Provider

The platform runs locally (or on a cheap VPS) with no GPU. Audio is sent to a cloud speech-to-text API for transcription.

```
┌───────────────────────────┐       ┌──────────────────────┐
│      Your Server (no GPU) │       │   Cloud Provider     │
│                           │       │                      │
│  API Gateway ── Bot Mgr   │ ───►  │  OpenAI Whisper API  │
│  Admin API ── Collector   │ audio │  Groq Whisper        │
│  WhisperLive (remote)     │ ◄──── │  Fireworks AI        │
│  Redis ── PG              │ text  │  Deepgram, etc.      │
└───────────────────────────┘       └──────────────────────┘
```

### Hardware Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **CPU** | 2 cores | 4+ cores |
| **RAM** | 4 GB | 8 GB |
| **GPU** | None | None |
| **Disk** | 20 GB | 40 GB |
| **OS** | Linux, macOS | Any Docker-capable OS |

### Supported Providers

Any provider with an OpenAI-compatible `/v1/audio/transcriptions` endpoint:

| Provider | Model | Approx. Cost |
|----------|-------|-------------|
| OpenAI | `whisper-1` | $0.006/min |
| Groq | `whisper-large-v3-turbo` | Free tier available |
| Fireworks | `whisper-v3-turbo` | $0.004/min |
| Deepgram | Nova-2 | $0.0043/min |

### Configuration

```env
DEVICE_TYPE=remote
REMOTE_TRANSCRIBER_URL=https://api.openai.com/v1/audio/transcriptions   # or Groq, Fireworks, etc.
REMOTE_TRANSCRIBER_API_KEY=sk-your-api-key
REMOTE_TRANSCRIBER_MODEL=whisper-1                                       # provider-specific model name
```

Docker Compose profile: `--profile remote`

### Pros & Cons

✅ No GPU needed, quick start, runs on any hardware including Mac
✅ Scales with provider capacity, predictable per-minute cost
❌ Audio leaves your network, ongoing API costs, depends on provider uptime
❌ Higher latency than local GPU (network round-trip)

---

## Mode 3: Remote Self-Hosted Transcription

Split architecture: the platform runs on one machine, transcription runs on another machine you control. The transcription server just needs to expose an OpenAI-compatible `/v1/audio/transcriptions` endpoint.

```
┌───────────────────────────┐       ┌──────────────────────────┐
│    Platform Server         │       │  Transcription Server    │
│                           │       │                          │
│  API Gateway ── Bot Mgr   │ ───►  │  whisper.cpp (Mac/Linux) │
│  Admin API ── Collector   │ audio │  MLX Whisper (Apple Si.) │
│  WhisperLive (remote)     │ ◄──── │  faster-whisper (NVIDIA)  │
│  Redis ── PG              │ text  │  Any Whisper HTTP server  │
└───────────────────────────┘       └──────────────────────────┘
```

### Hardware: Platform Server

Same as Mode 2 — no GPU needed.

### Hardware: Transcription Server

This can be **anything** that runs Whisper:

| Setup | Hardware | Software |
|-------|----------|----------|
| **Mac (Apple Silicon)** | M1/M2/M3/M4, 16 GB+ RAM | `mlx-whisper` or `whisper.cpp` with Metal |
| **Linux + NVIDIA GPU** | Any NVIDIA 8+ GB VRAM | `faster-whisper`, Vexa's own transcription-service |
| **Linux CPU-only** | 8+ cores, 16 GB RAM | `whisper.cpp` (slower but works) |
| **AMD GPU** | ROCm-supported GPU | `whisper.cpp` with ROCm (experimental) |

### Configuration

```env
DEVICE_TYPE=remote
REMOTE_TRANSCRIBER_URL=http://10.10.10.199:8765/v1/audio/transcriptions  # your transcription server
REMOTE_TRANSCRIBER_API_KEY=your-internal-api-key
REMOTE_TRANSCRIBER_MODEL=large-v3-turbo
```

Docker Compose profile: `--profile remote`

### Transcription Server Examples

**whisper.cpp with server mode (Mac/Linux):**
```bash
# Serves an OpenAI-compatible API on port 8080
./server -m models/ggml-large-v3-turbo.bin --host 0.0.0.0 --port 8080
```

**MLX Whisper (Apple Silicon):**
```bash
# Via mlx-whisper-server or a thin FastAPI wrapper
pip install mlx-whisper
# Wrap with a simple HTTP server exposing /v1/audio/transcriptions
```

**Vexa's own transcription-service (NVIDIA):**
```bash
# Already exists in the repo — deploy on GPU server separately
# Uses faster-whisper with CUDA
```

### Pros & Cons

✅ Full data control (everything on your network), flexible hardware choices
✅ Use Mac, AMD, or any hardware you have — not locked to NVIDIA
✅ Scale transcription independently from the platform
❌ Two machines to manage, network dependency between them
❌ You maintain the transcription server yourself

---

## Comparison Matrix

| | All-in-One GPU | Cloud Provider | Remote Server |
|---|---|---|---|
| **Setup complexity** | Medium | Low | Medium |
| **GPU required** | NVIDIA only | None | Flexible |
| **Runs on Mac** | ❌ | ✅ | ✅ (platform side) |
| **Data stays local** | ✅ | ❌ | ✅ |
| **Ongoing cost** | Hardware only | Per-minute API | Hardware only |
| **Latency** | Lowest | Higher | Medium |
| **Offline/air-gap** | ✅ | ❌ | ✅ (if both on LAN) |
| **Scaling** | Limited by GPU | Provider capacity | Add more servers |

---

## Quick Decision Guide

- **"I have an NVIDIA GPU and want the simplest setup"** → Mode 1 (All-in-One)
- **"I want to try it out quickly with no GPU"** → Mode 2 (Cloud Provider with Groq free tier)
- **"I have a Mac with M-series chip"** → Mode 3 (Remote, with `whisper.cpp` or `mlx-whisper` on the Mac)
- **"I need full data privacy and compliance"** → Mode 1 or Mode 3
- **"I want to offer this commercially"** → Mode 2 or Mode 3 (depending on customer requirements)
