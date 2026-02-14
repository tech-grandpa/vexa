const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8790', 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '1000', 10);
const MAX_SEGMENTS_PER_ROOM = parseInt(process.env.MAX_SEGMENTS_PER_ROOM || '10000', 10);
const MAX_VIEWERS_PER_ROOM = parseInt(process.env.MAX_VIEWERS_PER_ROOM || '20', 10);
const DEFAULT_TTL_MINUTES = parseInt(process.env.DEFAULT_TTL_MINUTES || '30', 10);
const ROOM_SECRET = process.env.ROOM_SECRET || null;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(1024 * 1024), 10);
const MAX_SEGMENT_TEXT_LENGTH = 10000;
const MAX_SPEAKER_LENGTH = 200;

function checkRoomSecret(req) {
  if (!ROOM_SECRET) return true; // dev mode — no auth required
  const headerSecret = req.headers['x-room-secret'];
  if (headerSecret === ROOM_SECRET) return true;
  return false;
}

// ── In-memory store ──────────────────────────────────────────────────
const rooms = new Map(); // token → room

function createRoom({ meetingId, hostEmail, ttlMinutes = DEFAULT_TTL_MINUTES }) {
  const token = crypto.randomBytes(32).toString('hex');
  const room = {
    token,
    meetingId: meetingId || null,
    hostEmail: hostEmail || null,
    ttlMinutes,
    createdAt: new Date().toISOString(),
    endedAt: null,
    segments: [],
    sseClients: new Set(),
    expiryTimer: null,
  };
  rooms.set(token, room);
  return room;
}

function deleteRoom(token) {
  const room = rooms.get(token);
  if (!room) return;
  if (room.expiryTimer) clearTimeout(room.expiryTimer);
  for (const res of room.sseClients) {
    try { res.end(); } catch {}
  }
  rooms.delete(token);
}

function endRoom(room) {
  room.endedAt = new Date().toISOString();
  const ms = room.ttlMinutes * 60 * 1000;
  room.expiryTimer = setTimeout(() => deleteRoom(room.token), ms);
  // notify SSE clients
  broadcastSSE(room, { type: 'status', status: 'ended', endedAt: room.endedAt, expiresInMinutes: room.ttlMinutes });
}

function broadcastSSE(room, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of room.sseClients) {
    try { res.write(msg); } catch {}
  }
}

// ── Viewer HTML ──────────────────────────────────────────────────────
// Minimal fallback viewer (used only if viewer.html is missing)
function viewerHTML(token) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Scribe</title></head>
<body style="background:#0d1117;color:#c9d1d9;font-family:sans-serif;padding:2rem">
<h1>Live Transcript</h1><p>Viewer template not found. Ensure viewer.html is deployed alongside server.js.</p>
</body></html>`;
}

// ── HTTP + WS Server ─────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Room-Secret');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // POST /api/rooms — create room
  if (method === 'POST' && path === '/api/rooms') {
    if (!checkRoomSecret(req)) return json(res, 401, { error: 'Invalid or missing X-Room-Secret' });
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'Room capacity reached' });
    return readBody(req, body => {
      const { meetingId, hostEmail, ttlMinutes } = body;
      const room = createRoom({ meetingId, hostEmail, ttlMinutes });
      json(res, 201, {
        roomToken: room.token,
        viewerUrl: `${BASE_URL}/${room.token}`,
        ingestUrl: `${BASE_URL.replace(/^http/, 'ws')}/ws/ingest/${room.token}`,
      });
    });
  }

  // Room-specific routes
  let m;
  if ((m = path.match(/^\/api\/room\/([a-f0-9]{64})\/stream$/))) {
    const room = rooms.get(m[1]);
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (room.sseClients.size >= MAX_VIEWERS_PER_ROOM) return json(res, 429, { error: 'Too many viewers for this room' });
    // SSE
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // send history
    if (room.segments.length) {
      res.write(`data: ${JSON.stringify({ type: 'history', segments: room.segments })}\n\n`);
    }
    if (room.endedAt) {
      res.write(`data: ${JSON.stringify({ type: 'status', status: 'ended', endedAt: room.endedAt, expiresInMinutes: room.ttlMinutes })}\n\n`);
    }
    room.sseClients.add(res);
    req.on('close', () => room.sseClients.delete(res));
    return;
  }

  if ((m = path.match(/^\/api\/room\/([a-f0-9]{64})\/transcript$/))) {
    const room = rooms.get(m[1]);
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (url.searchParams.get('format') === 'text') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(room.segments.map(s => `[${s.timestamp}]${s.speaker ? ' ' + s.speaker + ':' : ''} ${s.text}`).join('\n'));
    }
    return json(res, 200, { segments: room.segments, count: room.segments.length });
  }

  if ((m = path.match(/^\/api\/room\/([a-f0-9]{64})$/))) {
    if (method === 'GET') {
      const room = rooms.get(m[1]);
      if (!room) return json(res, 404, { error: 'Room not found' });
      return json(res, 200, {
        status: room.endedAt ? 'ended' : 'active',
        segmentCount: room.segments.length,
        createdAt: room.createdAt,
        endedAt: room.endedAt,
        meetingId: room.meetingId,
      });
    }
  }

  if (method === 'POST' && (m = path.match(/^\/api\/room\/([a-f0-9]{64})\/end$/))) {
    const room = rooms.get(m[1]);
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (room.endedAt) return json(res, 400, { error: 'Room already ended' });
    endRoom(room);
    return json(res, 200, { status: 'ended', endedAt: room.endedAt });
  }

  // Viewer — /{token}
  if ((m = path.match(/^\/([a-f0-9]{64})$/))) {
    const room = rooms.get(m[1]);
    if (!room) { res.writeHead(404); return res.end('Room not found'); }
    // Serve external viewer.html with token injected
    const viewerPath = require('path').join(__dirname, 'viewer.html');
    let html;
    try {
      html = require('fs').readFileSync(viewerPath, 'utf-8').replace('__TOKEN__', m[1]);
    } catch {
      // Fallback to inline viewer if file missing
      html = viewerHTML(m[1]);
    }
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
    });
    return res.end(html);
  }

  // Health
  if (path === '/health') return json(res, 200, { status: 'ok', rooms: rooms.size });

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket for ingest ─────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const m = url.pathname.match(/^\/ws\/ingest\/([a-f0-9]{64})$/);
  if (!m) { socket.destroy(); return; }
  const room = rooms.get(m[1]);
  if (!room || room.endedAt) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    let authenticated = !ROOM_SECRET; // skip auth if no secret configured

    const handleSegment = (raw) => {
      try {
        const seg = JSON.parse(raw);
        const segment = {
          text: String(seg.text || '').slice(0, MAX_SEGMENT_TEXT_LENGTH),
          timestamp: seg.timestamp || new Date().toISOString(),
          speaker: seg.speaker ? String(seg.speaker).slice(0, MAX_SPEAKER_LENGTH) : null,
        };
        room.segments.push(segment);
        while (room.segments.length > MAX_SEGMENTS_PER_ROOM) room.segments.shift();
        broadcastSSE(room, { type: 'segment', ...segment });
      } catch {}
    };

    ws.on('message', raw => {
      if (!authenticated) {
        // First message must be auth
        try {
          const msg = JSON.parse(raw);
          if (msg.type === 'auth' && msg.secret === ROOM_SECRET) {
            authenticated = true;
            return;
          }
        } catch {}
        ws.close(4001, 'Authentication failed');
        return;
      }
      handleSegment(raw);
    });
  });
});

// ── Helpers ───────────────────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let d = '';
  let bytes = 0;
  req.on('data', c => {
    bytes += Buffer.byteLength(c);
    if (bytes > MAX_BODY_BYTES) {
      req.destroy();
      cb({});
      return;
    }
    d += c;
  });
  req.on('end', () => { try { cb(JSON.parse(d || '{}')); } catch { cb({}); } });
}

server.listen(PORT, () => console.log(`transcript-room listening on :${PORT}`));
