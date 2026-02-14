const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const ACCESS_TOKEN = "MWUzYzRhNmUtN2I2OC00NzRlLTkzZDctNDdkNDJjMWVmY2E0ZmZkMzJkMWItNmMx_PE93_f1a576ad-e802-497e-999b-fd0c44c79f11";
const MEETING_URL = "https://meet1651.webex.com/meet1651-de/j.php?MTID=m89c337648e5c130ecc2f77c978fd1e78";
const BOT_NAME = "Vexa Transcriber";
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
        console.log(`[WS] type=${msg.type} ${JSON.stringify(msg).slice(0,150)}`);
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
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await (await browser.newContext({permissions:["microphone","camera"]})).newPage();
  page.on("console", m => { const t = m.text(); if (t.includes("[WEBEX]")) console.log(`  ${t}`); });

  await page.goto(`http://127.0.0.1:${port}/`, {waitUntil:"networkidle"});
  await page.evaluate(({u,t,n}) => { window.__WEBEX_CONFIG = {meetingUrl:u, access_token:t, displayName:n}; },
    {u:MEETING_URL, t:ACCESS_TOKEN, n:BOT_NAME});

  console.log("Joining meeting...");
  await Promise.race([
    page.evaluate(() => window.initWebex()),
    new Promise((_,r) => setTimeout(() => r(new Error("Join timeout")), 120000))
  ]);
  console.log("✅ Joined!");

  // Wait for audio
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__WEBEX_STATUS);
    if (s.audioReady) { console.log("✅ Audio stream ready!"); break; }
    if (i === 29) console.log("⚠️ No audio stream after 30s");
  }

  // 4. Audio capture with RMS monitoring
  await page.exposeFunction("sendAudioChunk", (base64Data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(base64Data, "base64"));
  });

  await page.exposeFunction("reportAudioLevel", (rms, peak, samples) => {
    const bar = "█".repeat(Math.min(40, Math.round(rms * 400)));
    const level = rms > 0.01 ? "🔊" : rms > 0.001 ? "🔈" : "🔇";
    console.log(`${level} RMS: ${rms.toFixed(4)} Peak: ${peak.toFixed(4)} ${bar}`);
  });

  await page.evaluate(() => {
    const stream = window.__WEBEX_AUDIO_STREAM;
    if (!stream) { console.log("[WEBEX] No audio stream!"); return; }

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    let sampleCount = 0;
    let rmsAccum = 0, rmsCount = 0, peakMax = 0;

    processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      let sumSq = 0, peak = 0;
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s * 0x7FFF;
        sumSq += s * s;
        const abs = Math.abs(s);
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sumSq / float32.length);
      rmsAccum += rms;
      rmsCount++;
      if (peak > peakMax) peakMax = peak;

      // Send audio
      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      window.sendAudioChunk(btoa(binary));

      sampleCount += float32.length;
      // Report every ~5 seconds
      if (sampleCount % 80000 < 4096) {
        window.reportAudioLevel(rmsAccum / rmsCount, peakMax, sampleCount);
        rmsAccum = 0; rmsCount = 0; peakMax = 0;
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    console.log("[WEBEX] Audio capture started with level monitoring");
    window.__stopCapture = () => { processor.disconnect(); source.disconnect(); audioContext.close(); };
  });

  console.log("\n🎙️  Transcribing for 180 seconds... Speak in the meeting!\n");

  const cleanup = async () => {
    console.log("\nStopping...");
    try { await page.evaluate(() => window.__stopCapture?.()); } catch {}
    try { await page.evaluate(() => window.leaveMeeting()); } catch {}
    ws.close(); await browser.close(); server.close();
    if (transcripts.length) {
      console.log("\n=== TRANSCRIPT ===");
      transcripts.forEach(t => console.log(t));
      fs.writeFileSync(path.join(__dirname, "transcript-output.txt"), transcripts.join("\n"));
    } else console.log("\nNo transcription received.");
  };

  process.on("SIGINT", async () => { await cleanup(); process.exit(0); });
  await page.waitForTimeout(180000);
  await cleanup();
})().catch(e => { console.error("❌", e.message); process.exit(1); });
