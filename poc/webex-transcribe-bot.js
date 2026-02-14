const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const BOT_TOKEN = "MTdhMmIyZWItYTE1ZS00NjA2LTgyMGUtNzcyOTI3N2M2M2M1ZmZiY2M3NzQtYzU5_PE93_f1a576ad-e802-497e-999b-fd0c44c79f11";
const MEETING_URL = "https://meet1651.webex.com/meet1651-de/j.php?MTID=m31c54fd339e635d22daf6e2adff11b52";
const BOT_NAME = "Scribe";
const WHISPER_WS_URL = "ws://10.10.10.199:8000/ws/transcribe?language=auto";

(async () => {
  // 1. Connect to transcription WebSocket
  console.log("Connecting to transcription service...");
  const ws = new WebSocket(WHISPER_WS_URL);
  const transcripts = [];

  await new Promise((resolve, reject) => {
    ws.on("open", () => { console.log("✅ Connected to transcription service"); resolve(); });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS timeout")), 10000);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.text && msg.text.trim()) {
        const line = `[${new Date().toISOString().slice(11,19)}] ${msg.text}`;
        console.log(`📝 TRANSCRIPT: ${line}`);
        transcripts.push(line);
      } else if (msg.transcript) {
        console.log(`📝 TRANSCRIPT: ${msg.transcript}`);
        transcripts.push(msg.transcript);
      } else if (msg.type) {
        console.log(`[WS] type=${msg.type} ${JSON.stringify(msg).slice(0,200)}`);
      }
    } catch { console.log(`[WS raw] ${data.toString().slice(0,200)}`); }
  });
  ws.on("close", () => console.log("[WS] Closed"));
  ws.on("error", (e) => console.log(`[WS] Error: ${e.message}`));

  // 2. HTTP server
  const htmlPath = path.join(__dirname, "..", "services", "vexa-bot", "core", "src", "platforms", "webex", "meeting.html");
  const server = http.createServer((req, res) => { res.writeHead(200, {"Content-Type":"text/html"}); res.end(fs.readFileSync(htmlPath)); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // 3. Browser
  const browser = await chromium.launch({
    headless: false,
    args: ["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await (await browser.newContext({permissions:["microphone","camera"]})).newPage();
  page.on("console", m => { const t = m.text(); if (t.includes("[WEBEX]")) console.log(`  ${t}`); });

  await page.goto(`http://127.0.0.1:${port}/`, {waitUntil:"networkidle"});
  await page.evaluate(({u,t,n}) => { window.__WEBEX_CONFIG = {meetingUrl:u, access_token:t, displayName:n}; },
    {u:MEETING_URL, t:BOT_TOKEN, n:BOT_NAME});

  console.log("Joining meeting as Scribe bot...");
  
  // Modified initWebex: join but don't addMedia yet (bot may be in lobby)
  try {
    await Promise.race([
      page.evaluate(async () => {
        const cfg = window.__WEBEX_CONFIG;
        const webex = window.Webex.init({ credentials: { access_token: cfg.access_token } });
        window.__WEBEX_INSTANCE = webex;
        window.__WEBEX_STATUS.initialized = true;
        
        // Wait for meetings:ready
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('meetings:ready timeout')), 30000);
          webex.meetings.on('meetings:ready', () => { clearTimeout(t); resolve(); });
        });
        
        await webex.meetings.register();
        window.__WEBEX_STATUS.registered = true;
        console.log('[WEBEX] Registered');
        
        const meeting = await webex.meetings.create(cfg.meetingUrl);
        window.__WEBEX_MEETING = meeting;
        console.log('[WEBEX] Meeting created: ' + meeting.id);
        
        // Set up media:ready handler
        meeting.on('media:ready', (media) => {
          console.log('[WEBEX] Media ready: ' + media.type);
          if (media.type === 'remoteAudio') {
            window.__WEBEX_AUDIO_STREAM = media.stream;
            window.__WEBEX_STATUS.audioReady = true;
          }
        });
        meeting.on('media:stopped', (media) => {
          console.log('[WEBEX] Media stopped: ' + media.type);
          if (media.type === 'remoteAudio') { window.__WEBEX_AUDIO_STREAM = null; window.__WEBEX_STATUS.audioReady = false; }
        });
        meeting.on('meeting:stateChange', (s) => console.log('[WEBEX] State: ' + JSON.stringify(s)));
        
        // Join (signaling only)
        await meeting.join();
        window.__WEBEX_STATUS.joined = true;
        console.log('[WEBEX] Joined (signaling)');
        return { joined: true };
      }),
      new Promise((_,r) => setTimeout(() => r(new Error("Join timeout 120s")), 120000))
    ]);
    console.log("✅ Joined signaling!");
  } catch (e) {
    console.error("❌ Join failed:", e.message.slice(0, 300));
    await browser.close(); server.close(); ws.close();
    return;
  }

  // Try addMedia immediately after join. If bot is in lobby, retry with backoff.
  console.log("⏳ Attempting addMedia (will retry if in lobby)...");
  await page.waitForTimeout(2000);
  
  let mediaAdded = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await page.evaluate(async () => {
        await window.__WEBEX_MEETING.addMedia({
          mediaOptions: { receiveAudio: true, receiveVideo: false, sendAudio: false, sendVideo: false }
        });
        console.log('[WEBEX] addMedia succeeded!');
      });
      console.log("✅ Media added!");
      mediaAdded = true;
      break;
    } catch (e) {
      const msg = e.message.slice(0, 200);
      if (msg.includes('lobby') || msg.includes('not Active')) {
        console.log(`⏳ Attempt ${attempt+1}/12: ${msg} — retrying in 10s (admit 'Scribe' from lobby)...`);
        await page.waitForTimeout(10000);
      } else {
        console.error("❌ addMedia failed (non-retryable):", msg);
        break;
      }
    }
  }
  if (!mediaAdded) {
    console.error("❌ Could not add media after retries. Exiting.");
    await browser.close(); server.close(); ws.close();
    return;
  }

  // Wait for audio stream
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__WEBEX_STATUS);
    if (s.audioReady) { console.log("✅ Audio stream ready!"); break; }
    if (i === 29) console.log("⚠️ No audio stream after 30s");
  }

  // 4. Audio capture with level monitoring
  await page.exposeFunction("sendAudioChunk", (base64Data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(base64Data, "base64"));
  });

  await page.exposeFunction("reportAudioLevel", (rms, peak, samples) => {
    const bar = "█".repeat(Math.min(50, Math.round(rms * 500)));
    const level = rms > 0.01 ? "🔊" : rms > 0.001 ? "🔈" : "🔇";
    console.log(`${level} RMS: ${rms.toFixed(4)} Peak: ${peak.toFixed(4)} [${Math.floor(samples/16000)}s] ${bar}`);
  });

  await page.evaluate(() => {
    const stream = window.__WEBEX_AUDIO_STREAM;
    if (!stream) { console.log("[WEBEX] No audio stream!"); return; }

    // CRITICAL: Attach stream to an <audio> element so Chrome actually
    // decodes the WebRTC RTP packets. Without this, MediaStreamSource
    // sees all zeros because the browser never activates the decode pipeline.
    const audioEl = document.createElement('audio');
    audioEl.srcObject = stream;
    audioEl.autoplay = true;
    // volume=0 prevents audible output; avoid .muted which can skip RTP decode
    audioEl.volume = 0;
    document.body.appendChild(audioEl);
    audioEl.play().then(() => console.log('[WEBEX] Audio element playing (muted)'))
                   .catch(e => console.log('[WEBEX] Audio play error: ' + e.message));

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    let sampleCount = 0, rmsAccum = 0, rmsCount = 0, peakMax = 0;

    processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      let sumSq = 0, peak = 0;
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s * 0x7FFF;
        sumSq += s * s;
        if (Math.abs(s) > peak) peak = Math.abs(s);
      }
      rmsAccum += Math.sqrt(sumSq / float32.length);
      rmsCount++;
      if (peak > peakMax) peakMax = peak;

      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      window.sendAudioChunk(btoa(binary));

      sampleCount += float32.length;
      if (sampleCount % 80000 < 4096) {
        window.reportAudioLevel(rmsAccum / rmsCount, peakMax, sampleCount);
        rmsAccum = 0; rmsCount = 0; peakMax = 0;
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    console.log("[WEBEX] Audio capture started");
    window.__stopCapture = () => { processor.disconnect(); source.disconnect(); audioContext.close(); };
  });

  console.log("\n🎙️  Transcribing for 180s... Speak in the meeting!\n");

  const cleanup = async () => {
    console.log("\nStopping...");
    try { await page.evaluate(() => window.__stopCapture?.()); } catch {}
    try { await page.evaluate(() => window.leaveMeeting()); } catch {}
    ws.close(); await browser.close(); server.close();
    if (transcripts.length) {
      console.log("\n=== FULL TRANSCRIPT ===");
      transcripts.forEach(t => console.log(t));
      fs.writeFileSync(path.join(__dirname, "transcript-output.txt"), transcripts.join("\n"));
      console.log(`\nSaved to poc/transcript-output.txt`);
    } else console.log("\nNo transcription received.");
  };

  process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
  await page.waitForTimeout(180000);
  await cleanup();
})().catch(e => { console.error("❌", e.message); process.exit(1); });
