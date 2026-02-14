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
function viewerHTML(token) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Transcript</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;height:100vh}
header{padding:12px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:12px;flex-shrink:0}
header h1{font-size:16px;font-weight:600;color:#e6edf3}
#status{font-size:13px;padding:3px 10px;border-radius:12px;background:#1f6feb33;color:#58a6ff}
#status.live{background:#da363333;color:#f85149}
#status.live::before{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;background:#f85149;margin-right:6px;animation:pulse 1.5s infinite}
#status.ended{background:#f0883e22;color:#f0883e}
#status.connecting{background:#21262d;color:#8b949e}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
#transcript{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:4px}
.line{animation:fadeIn .3s ease;font-size:14px;line-height:1.6;padding:2px 0}
.line .ts{color:#484f58;font-size:12px;font-family:'SF Mono',Consolas,monospace;margin-right:10px}
.line .speaker{color:#d2a8ff;font-weight:600;margin-right:8px}
.line .text{color:#c9d1d9}
#scrollBtn{display:none;position:fixed;bottom:24px;right:24px;background:#1f6feb;color:#fff;border:none;border-radius:20px;padding:8px 16px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px #0008;z-index:10}
#scrollBtn:hover{background:#388bfd}
</style></head><body>
<header><h1>📝 Live Transcript</h1><span id="status" class="connecting">Connecting…</span></header>
<div id="transcript"></div>
<button id="scrollBtn" onclick="scrollToBottom()">↓ Scroll to bottom</button>
<script>
const token='${token}',tx=document.getElementById('transcript'),st=document.getElementById('status'),sb=document.getElementById('scrollBtn');
let userScrolled=false,ended=false,endedAt=null,ttl=0;

function scrollToBottom(){tx.scrollTop=tx.scrollHeight;userScrolled=false;sb.style.display='none'}
tx.addEventListener('scroll',()=>{const d=tx.scrollHeight-tx.clientHeight-tx.scrollTop;userScrolled=d>80;sb.style.display=userScrolled?'block':'none'});

function addLine(seg){
  const d=document.createElement('div');d.className='line';
  const t=new Date(seg.timestamp);
  const ts=t.toTimeString().slice(0,8);
  let h='<span class="ts">'+ts+'</span>';
  if(seg.speaker)h+='<span class="speaker">'+esc(seg.speaker)+'</span>';
  h+='<span class="text">'+esc(seg.text)+'</span>';
  d.innerHTML=h;tx.appendChild(d);
  if(!userScrolled)scrollToBottom();
}

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}

function updateStatus(){
  if(ended){
    st.className='ended';
    if(endedAt&&ttl){
      const exp=new Date(new Date(endedAt).getTime()+ttl*60000);
      const min=Math.max(0,Math.round((exp-Date.now())/60000));
      st.textContent='Meeting ended — transcript expires in '+min+' min';
    }else st.textContent='Meeting ended';
  }
}

function connect(){
  st.className='connecting';st.textContent='Connecting…';
  const es=new EventSource('/api/room/'+token+'/stream');
  es.onopen=()=>{if(!ended){st.className='live';st.textContent='Live'}};
  es.onmessage=e=>{
    const d=JSON.parse(e.data);
    if(d.type==='segment')addLine(d);
    else if(d.type==='status'&&d.status==='ended'){ended=true;endedAt=d.endedAt;ttl=d.expiresInMinutes;updateStatus()}
    else if(d.type==='history')d.segments.forEach(addLine);
  };
  es.onerror=()=>{es.close();st.className='connecting';st.textContent='Reconnecting…';setTimeout(connect,2000)};
}
connect();
if(ended)setInterval(updateStatus,30000);
</script></body></html>`;
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
