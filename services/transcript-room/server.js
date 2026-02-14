const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8790', 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── In-memory store ──────────────────────────────────────────────────
const rooms = new Map(); // token → room

function createRoom({ meetingId, hostEmail, ttlMinutes = 60 }) {
  const token = crypto.randomBytes(16).toString('hex');
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // POST /api/rooms — create room
  if (method === 'POST' && path === '/api/rooms') {
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
  if ((m = path.match(/^\/api\/room\/([a-f0-9]{32})\/stream$/))) {
    const room = rooms.get(m[1]);
    if (!room) return json(res, 404, { error: 'Room not found' });
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

  if ((m = path.match(/^\/api\/room\/([a-f0-9]{32})\/transcript$/))) {
    const room = rooms.get(m[1]);
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (url.searchParams.get('format') === 'text') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(room.segments.map(s => `[${s.timestamp}]${s.speaker ? ' ' + s.speaker + ':' : ''} ${s.text}`).join('\n'));
    }
    return json(res, 200, { segments: room.segments, count: room.segments.length });
  }

  if ((m = path.match(/^\/api\/room\/([a-f0-9]{32})$/))) {
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

  if (method === 'POST' && (m = path.match(/^\/api\/room\/([a-f0-9]{32})\/end$/))) {
    const room = rooms.get(m[1]);
    if (!room) return json(res, 404, { error: 'Room not found' });
    if (room.endedAt) return json(res, 400, { error: 'Room already ended' });
    endRoom(room);
    return json(res, 200, { status: 'ended', endedAt: room.endedAt });
  }

  // Viewer — /{token}
  if ((m = path.match(/^\/([a-f0-9]{32})$/))) {
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
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // Health
  if (path === '/health') return json(res, 200, { ok: true, rooms: rooms.size });

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket for ingest ─────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const m = url.pathname.match(/^\/ws\/ingest\/([a-f0-9]{32})$/);
  if (!m) { socket.destroy(); return; }
  const room = rooms.get(m[1]);
  if (!room || room.endedAt) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('message', raw => {
      try {
        const seg = JSON.parse(raw);
        const segment = {
          text: String(seg.text || ''),
          timestamp: seg.timestamp || new Date().toISOString(),
          speaker: seg.speaker || null,
        };
        room.segments.push(segment);
        broadcastSSE(room, { type: 'segment', ...segment });
      } catch {}
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
  req.on('data', c => d += c);
  req.on('end', () => { try { cb(JSON.parse(d || '{}')); } catch { cb({}); } });
}

server.listen(PORT, () => console.log(`transcript-room listening on :${PORT}`));
