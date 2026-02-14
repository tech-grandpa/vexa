# Transcript Room

Ephemeral live transcript viewer for Vexa meetings. No database, no disk — everything lives in memory and auto-deletes after expiry.

## Quick Start

```bash
npm install
npm start        # listens on :8790
```

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/rooms` | Create room → `{ roomToken, viewerUrl, ingestUrl }` |
| GET | `/api/room/{token}` | Room status |
| GET | `/api/room/{token}/stream` | SSE stream for viewers |
| GET | `/api/room/{token}/transcript` | Full transcript (JSON or `?format=text`) |
| POST | `/api/room/{token}/end` | Signal meeting ended, starts TTL countdown |
| WS | `/ws/ingest/{token}` | Bot sends segments: `{ text, timestamp, speaker }` |
| GET | `/{token}` | Viewer UI |

## How it works

1. Bot creates a room via `POST /api/rooms`
2. Bot connects to WebSocket ingest and sends transcript segments
3. Viewers open the viewer URL — see live transcript via SSE
4. When meeting ends, bot calls `/end` — room expires after `ttlMinutes` (default 60)
5. All data is deleted from memory on expiry

## Security

- **Token-only auth:** Transcript access is currently authorized by room token only (bearer-token-like). Anyone with the viewer URL can read the transcript. This is by design for frictionless ephemeral sharing. Future improvement: require ROOM_SECRET or a viewer-specific token for page access.
- **No TLS:** Communication between the bot and transcript-room is plain HTTP/WS within the Docker network. The ROOM_SECRET travels in cleartext headers. This is acceptable for same-host Docker deployments. If services are split across hosts, use a reverse proxy with TLS or Docker overlay encryption.

## Environment

- `PORT` — server port (default: 8790)
- `BASE_URL` — public base URL for generated links
- `CORS_ORIGIN` — Access-Control-Allow-Origin value (default: `*`)
- `MAX_BODY_BYTES` — maximum request body size in bytes (default: 1048576)
- `ROOM_SECRET` — shared secret for room authentication
