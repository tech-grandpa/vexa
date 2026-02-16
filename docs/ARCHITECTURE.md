# Vexa Architecture

## System Overview

Vexa is a platform that automatically transcribes Webex meetings. A bot joins meetings as a participant, captures audio, and produces searchable transcripts accessible via API.

### Services

| Service | Role | Port |
|---------|------|------|
| **API Gateway** | Public entry point. Routes requests, handles auth, serves transcripts. Receives Webex webhooks. | 8000 |
| **Bot Manager** | Orchestrates bot lifecycle. Launches/stops bot containers, validates org membership. | 8080 |
| **Admin API** | User and API key management. | 8001 |
| **Transcription Collector** | Consumes transcription segments from Redis streams, stores in PostgreSQL. | 8000 |
| **MCP** | Model Context Protocol service for AI tool integrations. | 18888 |
| **Transcript Room** | Collaborative transcript viewing. | 8790 |
| **Bot Container** | Ephemeral. One per meeting. Joins via Webex JS SDK, streams audio to Whisper. | — |
| **Redis** | Pub/sub for real-time updates, stream transport for transcription segments. | 6379 |
| **PostgreSQL** | Persistent storage for users, meetings, transcripts. | 5432 |

## How the Bot Joins Meetings

```
Client/Webhook ──POST /bots──► API Gateway ──► Bot Manager
                                                    │
                                              ┌─────┴─────┐
                                              │ Validate   │
                                              │ org via    │
                                              │ Webex API  │
                                              └─────┬─────┘
                                                    │ ✓
                                              Launch Docker
                                              container
                                                    │
                                              Bot Container
                                              ┌─────┴─────┐
                                              │ Webex SDK  │
                                              │ join()     │
                                              │ capture    │
                                              │ audio      │
                                              └─────┬─────┘
                                                    │
                                              Stream to
                                              WhisperLive
                                                    │
                                              Segments ──► Redis Stream
                                                              │
                                                    Transcription Collector
                                                              │
                                                          PostgreSQL
```

1. **Request** — `POST /bots` with `platform: "webex"`, `native_meeting_id` (meeting URL/number), and `access_token`
2. **Org validation** — Bot Manager checks the token's org against the bot's org via Webex API (`/people/me`)
3. **Container launch** — A Docker container runs the bot with the Webex JS SDK
4. **Join & capture** — Bot joins the meeting, captures audio streams
5. **Transcription** — Audio is streamed to WhisperLive (Whisper-based ASR), segments are pushed to Redis
6. **Storage** — Transcription Collector reads from Redis and persists to PostgreSQL
7. **Real-time** — WebSocket endpoint (`/ws`) fans out live segments via Redis pub/sub

## Deployment for an Org

### Prerequisites
- Docker & Docker Compose
- A Webex Bot created at [developer.webex.com](https://developer.webex.com)
- The bot's access token (`WEBEX_BOT_TOKEN`)

### Steps

1. **Clone and configure:**
   ```bash
   git clone <repo-url> && cd vexa
   cp env-example.cpu .env
   ```

2. **Set required env vars in `.env`:**
   ```env
   WEBEX_BOT_TOKEN=<your-bot-access-token>
   WEBEX_WEBHOOK_SECRET=<random-secret-for-webhook-validation>
   ADMIN_API_TOKEN=<admin-secret>
   DB_PASSWORD=<db-password>
   ```

3. **Build and start:**
   ```bash
   docker compose build
   docker compose up -d
   ```

4. **Register webhooks** (so employees can invite the bot directly):
   ```bash
   export WEBEX_BOT_TOKEN=<token>
   export WEBEX_WEBHOOK_SECRET=<secret>
   python scripts/register_webex_webhook.py https://your-public-domain/webhooks/webex
   ```

5. **Create API keys** for programmatic access:
   ```bash
   curl -X POST http://localhost:8056/admin/users \
     -H "X-Admin-API-Key: $ADMIN_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"username": "team-lead"}'
   ```

### Network Requirements
- The API Gateway must be publicly reachable for Webex webhooks (`POST /webhooks/webex`)
- Bot containers need outbound access to Webex APIs and meeting infrastructure

## Employee Experience

1. **Invite the bot** — Add `scribe-bot@webex.bot` as a meeting participant (in the Webex calendar invite or during the meeting)
2. **Bot joins automatically** — Webex sends a webhook, Vexa launches the bot, it appears in the meeting
3. **Meeting is transcribed** — The bot silently captures and transcribes audio
4. **Access transcripts** — Via the API (`GET /transcripts/webex/{meeting_id}`) or through integrated tools

Alternatively, employees can message the bot directly with a meeting link and it will join.

## Org Restriction

Vexa enforces organization-level access control through the `WEBEX_BOT_TOKEN`:

- When a bot launch is requested, Bot Manager calls the Webex API (`GET /people/me`) with the provided `access_token`
- It compares the token holder's `orgId` against the bot's own `orgId`
- If they don't match, the request is rejected with `403 Forbidden`

This ensures only members of the same Webex organization can use the bot. The bot token itself defines which org is authorized — no additional configuration needed.

**Implementation:** `services/bot-manager/app/webex_org.py` and `services/bot-manager/app/config.py`

## Webhook Flow

```
Webex Cloud                          Vexa
    │                                  │
    │  memberships:created             │
    │  (bot added to meeting)          │
    ├─────────────────────────────────►│ POST /webhooks/webex
    │                                  │
    │                                  ├── Verify HMAC signature
    │                                  ├── Fetch membership details
    │                                  ├── Fetch room/meeting info
    │                                  ├── Call POST /bots internally
    │                                  │   (with WEBEX_BOT_TOKEN)
    │                                  │
    │  Bot joins meeting               │
    │◄─────────────────────────────────┤
```

### Webhook Events Handled

| Resource | Event | Action |
|----------|-------|--------|
| `memberships` | `created` | Bot added to space/meeting → auto-join or send welcome |
| `messages` | `created` | 1:1 message with meeting link → auto-join |

### Setup

1. Set `WEBEX_WEBHOOK_SECRET` in your environment
2. Run `scripts/register_webex_webhook.py` with your public URL
3. The script registers two webhooks: `memberships:created` and `messages:created`

Webhook authenticity is validated via HMAC-SHA1 signature in the `x-spark-signature` header.

## Going Commercial

### Self-Hosted (Current Model)
- Organization deploys Vexa internally
- Single `WEBEX_BOT_TOKEN` scopes access to one org
- Full data sovereignty — transcripts never leave the org's infrastructure

### Multi-Tenant SaaS
To support multiple organizations:
- **Bot per org** — Each customer registers their own Webex bot; Vexa stores per-tenant bot tokens
- **OAuth integration** — Users authorize via Webex OAuth; Vexa acts on their behalf
- **Tenant isolation** — Separate databases or schema-per-tenant for transcript storage
- **Billing** — Track meeting minutes per tenant for usage-based pricing

### Key Considerations
- **Compliance** — Meeting recordings/transcripts may be subject to GDPR, HIPAA, or org-specific policies
- **Scaling** — Bot containers are ephemeral and horizontally scalable; WhisperLive can be scaled separately
- **Bot limits** — Webex may impose rate limits on bot API calls and meeting joins

## API Reference

### Bot Management

**`POST /bots`** — Launch a bot to join a meeting
```json
{
  "platform": "webex",
  "native_meeting_id": "https://meet.webex.com/meet/example",
  "bot_name": "Vexa Scribe",
  "access_token": "<webex-access-token>"
}
```
Returns: `201` with meeting details

**`DELETE /bots/webex/{native_meeting_id}`** — Stop a bot

**`GET /bots/status`** — List running bots for the authenticated user

**`PUT /bots/webex/{native_meeting_id}/config`** — Update bot config (language, task)

### Transcripts

**`GET /meetings`** — List all meetings for the user

**`GET /transcripts/webex/{native_meeting_id}`** — Get transcript segments

**`POST /transcripts/webex/{native_meeting_id}/share`** — Create a short-lived public share URL

**`PATCH /meetings/webex/{native_meeting_id}`** — Update meeting metadata

**`DELETE /meetings/webex/{native_meeting_id}`** — Delete transcript data

### Webhooks

**`POST /webhooks/webex`** — Webex webhook receiver (public, no API key)

### WebSocket

**`WS /ws`** — Real-time transcript streaming (requires `X-API-Key` header or `api_key` query param)

### Authentication

All endpoints (except `/webhooks/webex` and `/public/*`) require `X-API-Key` header.
Admin endpoints require `X-Admin-API-Key` header.
