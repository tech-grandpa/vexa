# Installation & Configuration Guide

Get Vexa running in under 10 minutes. Detailed configuration options follow.

---

## Prerequisites

- **Docker** 24+ with Compose v2
- **Git**
- A **Webex Bot** created at [developer.webex.com](https://developer.webex.com/my-apps/new/bot) (for Webex platform)

---

## Quick Start (5 Minutes)

### 1. Clone and configure

```bash
git clone https://github.com/tech-grandpa/vexa.git
cd vexa

# Pick your deployment mode and copy the matching env template:
cp env-example.remote .env    # No GPU (cloud or remote transcription)
# cp env-example.gpu .env     # Local NVIDIA GPU
```

### 2. Set required variables

Edit `.env` and set at minimum:

```env
# Admin API token (pick any strong secret)
ADMIN_API_TOKEN=your-secret-admin-token

# Transcription backend (for remote/cloud mode)
REMOTE_TRANSCRIBER_URL=https://api.groq.com/openai/v1/audio/transcriptions
REMOTE_TRANSCRIBER_API_KEY=gsk_your_groq_key
REMOTE_TRANSCRIBER_MODEL=whisper-large-v3-turbo

# Webex Bot (optional — enables org restriction + webhooks)
WEBEX_BOT_TOKEN=your-bot-token-from-developer.webex.com
WEBEX_BOT_EMAIL=earwyn@webex.bot
```

### 3. Start

```bash
# Remote/cloud transcription (no GPU):
docker compose --profile remote up -d

# OR local NVIDIA GPU:
# docker compose --profile gpu up -d
```

### 4. Create your first user

```bash
# Create a user
curl -X POST http://localhost:8056/admin/users \
  -H "X-Admin-API-Key: your-secret-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@company.com", "name": "Your Name"}'

# Generate an API key for the user (use the user ID from the response above)
curl -X POST http://localhost:8056/admin/users/1/tokens \
  -H "X-Admin-API-Key: your-secret-admin-token"
```

Save the returned API token — this is what you (or integrations) use to interact with Vexa.

### 5. Test it

```bash
# Check services are running
curl http://localhost:8056/
# → {"message": "Welcome to the Vexa API Gateway"}

# Start a bot (example for Webex)
curl -X POST http://localhost:8056/bots \
  -H "X-API-Key: your-user-api-token" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "webex",
    "native_meeting_id": "1234567890",
    "access_token": "your-webex-personal-access-token"
  }'
```

That's it — the bot joins the meeting and starts transcribing.

---

## Setting Up Webhooks (Auto-Join)

For employees to use the bot by simply inviting it to meetings (instead of calling the API), set up Webex webhooks:

### 1. Make the API gateway publicly reachable

The webhook endpoint needs to be accessible from the internet. Options:
- Reverse proxy (nginx/Caddy) with TLS on your server
- Cloudflare Tunnel
- ngrok (for testing)

### 2. Register the webhook

```bash
# Set your bot token and public URL
export WEBEX_BOT_TOKEN="your-bot-token"

python scripts/register_webex_webhook.py \
  --target-url https://earwyn.com/webhooks/webex \
  --secret "pick-a-webhook-secret"
```

### 3. Add the secret to your environment

```env
WEBEX_WEBHOOK_SECRET=pick-a-webhook-secret
```

Restart the API gateway. Now when anyone in your org adds the bot to a meeting, it auto-joins.

---

## Configuration Reference

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `ADMIN_API_TOKEN` | Secret for admin API endpoints | `super-secret-token-123` |

### Transcription Backend

| Variable | Description | Default |
|----------|-------------|---------|
| `DEVICE_TYPE` | Transcription mode: `gpu`, `cpu`, `remote` | — |
| `WHISPER_MODEL_SIZE` | Model for local GPU mode | `large-v3-turbo` |
| `REMOTE_TRANSCRIBER_URL` | API endpoint (remote/cloud mode) | — |
| `REMOTE_TRANSCRIBER_API_KEY` | API key for remote transcription | — |
| `REMOTE_TRANSCRIBER_MODEL` | Model name sent to the API | `whisper-large-v3-turbo` |
| `REMOTE_TRANSCRIBER_TEMPERATURE` | Temperature for transcription | `0` |
| `REMOTE_TRANSCRIBER_VAD_MODEL` | VAD model (e.g., `silero`) | — |

### Webex Integration

| Variable | Description | Default |
|----------|-------------|---------|
| `WEBEX_BOT_TOKEN` | Bot token from developer.webex.com. Enables org restriction when set. | *(unset = open access)* |
| `WEBEX_BOT_EMAIL` | Bot's email address | `earwyn@webex.bot` |
| `WEBEX_WEBHOOK_SECRET` | HMAC secret for webhook validation | — |

### Service Ports

| Variable | Description | Default |
|----------|-------------|---------|
| `API_GATEWAY_HOST_PORT` | API Gateway external port | `8056` |
| `ADMIN_API_HOST_PORT` | Admin API external port | `8057` |
| `TRANSCRIPTION_COLLECTOR_HOST_PORT` | Collector external port | `8123` |
| `POSTGRES_HOST_PORT` | PostgreSQL external port | `5438` |

### Database

| Variable | Description | Default |
|----------|-------------|---------|
| `REMOTE_DB` | Use external PostgreSQL instead of Docker | `false` |
| `DB_HOST` | Database host (when `REMOTE_DB=true`) | `postgres` |
| `DB_PORT` | Database port | `5432` |
| `DB_NAME` | Database name | `vexa` |
| `DB_USER` | Database user | `postgres` |
| `DB_PASSWORD` | Database password | `postgres` |

### Bot Behavior

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_IMAGE_NAME` | Docker image for bot containers | `vexa-bot:dev` |
| `WL_MAX_CLIENTS` | Max concurrent WhisperLive clients | `10` |
| `MIN_AUDIO_S` | Minimum audio seconds before transcription | `2.0` |
| `LANGUAGE_DETECTION_SEGMENTS` | Segments for language auto-detection | `10` |

---

## Deep Dive: Advanced Configuration

### Using an External Database

For production, use a managed PostgreSQL instance:

```env
REMOTE_DB=true
DB_HOST=your-rds-instance.region.rds.amazonaws.com
DB_PORT=5432
DB_NAME=vexa
DB_USER=vexa_app
DB_PASSWORD=strong-password
DB_SSL_MODE=require
```

Remove the `postgres` service from your compose override or use a custom compose file.

### TLS / Reverse Proxy

Vexa services don't handle TLS directly. Put a reverse proxy in front:

**Caddy (simplest):**
```Caddyfile
earwyn.com {
    reverse_proxy localhost:8056
}
```

**nginx:**
```nginx
server {
    listen 443 ssl;
    server_name earwyn.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:8056;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    
    # WebSocket support
    location /ws {
        proxy_pass http://localhost:8056;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### GPU Device Selection

When running multiple GPUs, specify which one WhisperLive uses:

```yaml
# In docker-compose.yml, under whisperlive service:
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          device_ids: ["0"]  # Change to your GPU index
          capabilities: [gpu]
```

### Speaker Circuit Breaker (WhisperLive)

Prevents wasted GPU cycles when no one is speaking:

```env
WL_USE_SPEAKER_GROUND_TRUTH=true
WL_SERVER_SPEAKER_NO_TX_STALL_S=30    # Stop after 30s silence
WL_SPEAKER_ACTIVE_WINDOW_S=8          # Activity detection window
WL_SERVER_WARMUP_S=60                  # Grace period at start
```

### Webhook Configuration for Status Notifications

Users can configure webhook URLs to receive meeting status updates:

```bash
curl -X PUT http://localhost:8056/user/webhook \
  -H "X-API-Key: your-user-api-token" \
  -H "Content-Type: application/json" \
  -d '{"webhook_url": "https://your-app.com/vexa-events"}'
```

Events delivered: `requested`, `joining`, `awaiting_admission`, `active`, `stopping`, `completed`, `failed`.

### Transcript Share Links

Generate short-lived public URLs for sharing transcripts (e.g., with ChatGPT "read from URL"):

```bash
curl -X POST http://localhost:8056/transcripts/webex/1234567890/share \
  -H "X-API-Key: your-user-api-token"
# Returns: { "url": "https://earwyn.com/public/transcripts/abc123.txt", "expires_in_seconds": 900 }
```

Configure TTL:
```env
TRANSCRIPT_SHARE_TTL_SECONDS=900       # Default: 15 minutes
TRANSCRIPT_SHARE_TTL_MAX_SECONDS=86400 # Max: 24 hours
```
