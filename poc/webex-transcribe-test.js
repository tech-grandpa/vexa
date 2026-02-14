// Join Webex meeting, capture audio, stream to whisper transcription service
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const ACCESS_TOKEN = "MWUzYzRhNmUtN2I2OC00NzRlLTkzZDctNDdkNDJjMWVmY2E0ZmZkMzJkMWItNmMx_PE93_f1a576ad-e802-497e-999b-fd0c44c79f11";
const MEETING_URL = "https://meet1651.webex.com/meet1651-de/j.php?MTID=m9d5a0c33632574062fff184b7986beca";
const BOT_NAME = "Vexa Transcriber";
const WHISPER_WS_URL = "ws://10.10.10.199:8000/ws/transcribe?language=auto";

(async () => {
  // 1. Connect to whisper transcription WebSocket
  console.log("Connecting to transcription service...");
  const ws = new WebSocket(WHISPER_WS_URL);
  const transcripts = [];
  
  await new Promise((resolve, reject) => {
    ws.on("open", () => { console.log("✅ Connected to transcription service"); resolve(); });
    ws.on("error", (err) => reject(err));
    setTimeout(() => reject(new Error("WS connect timeout")), 10000);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.text) {
        const line = `[${new Date().toISOString().slice(11,19)}] ${msg.text}`;
        console.log(`📝 ${line}`);
        transcripts.push(line);
      } else if (msg.type === "transcript") {
        const line = `[${new Date().toISOString().slice(11,19)}] ${msg.transcript || msg.content}`;
        console.log(`📝 ${line}`);
        transcripts.push(line);
      } else {
        console.log(`[WS] ${JSON.stringify(msg)}`);
      }
    } catch {
      console.log(`[WS raw] ${data.toString().slice(0, 200)}`);
    }
  });

  ws.on("close", () => console.log("[WS] Connection closed"));
  ws.on("error", (err) => console.log(`[WS] Error: ${err.message}`));

  // 2. Start HTTP server for meeting.html
  const htmlPath = path.join(__dirname, "..", "services", "vexa-bot", "core", "src", "platforms", "webex", "meeting.html");
  const htmlContent = fs.readFileSync(htmlPath, "utf-8");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlContent);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  console.log(`HTTP server on port ${port}`);

  // 3. Launch browser and join meeting
  const browser = await chromium.launch({
    headless: false,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const page = await (await browser.newContext({ permissions: ["microphone", "camera"] })).newPage();
  page.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("[WEBEX]") && !text.includes("wx-js-sdk")) console.log(`  ${text}`);
  });

  await page.goto(`http://127.0.0.1:${port}/meeting.html`, { waitUntil: "networkidle" });
  await page.evaluate(({ meetingUrl, accessToken, displayName }) => {
    window.__WEBEX_CONFIG = { meetingUrl, access_token: accessToken, displayName };
  }, { meetingUrl: MEETING_URL, accessToken: ACCESS_TOKEN, displayName: BOT_NAME });

  console.log("Joining meeting...");
  await Promise.race([
    page.evaluate(() => window.initWebex()),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Join timeout 120s")), 120000)),
  ]);
  console.log("✅ Joined meeting!");

  // 4. Wait for audio stream
  console.log("Waiting for audio stream...");
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__WEBEX_STATUS);
    if (s.audioReady) { console.log("✅ Audio stream ready!"); break; }
    if (i === 29) console.log("⚠️ Audio stream not ready after 30s");
  }

  // 5. Capture audio in browser context and send PCM chunks to Node via page events
  console.log("Starting audio capture and transcription...");
  
  // Expose a function for the browser to send audio data to Node
  await page.exposeFunction("sendAudioChunk", (base64Data) => {
    if (ws.readyState === WebSocket.OPEN) {
      const buffer = Buffer.from(base64Data, "base64");
      ws.send(buffer);
    }
  });

  await page.evaluate(() => {
    const stream = window.__WEBEX_AUDIO_STREAM;
    if (!stream) { console.log("[WEBEX] No audio stream!"); return; }

    const audioContext = new AudioContext({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    let sampleCount = 0;

    processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      // Convert Float32 to Int16
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-1, Math.min(1, float32[i])) * 0x7FFF;
      }
      // Send as base64 to Node
      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      window.sendAudioChunk(btoa(binary));

      sampleCount += float32.length;
      if (sampleCount % 160000 < 4096) {
        console.log(`[WEBEX] Audio captured: ${Math.floor(sampleCount / 16000)}s`);
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    console.log("[WEBEX] Audio capture pipeline started");

    window.__stopCapture = () => {
      processor.disconnect();
      source.disconnect();
      audioContext.close();
    };
  });

  // 6. Let it run for 120 seconds (or until Ctrl+C)
  console.log("\n🎙️  Transcribing for 120 seconds... Speak in the meeting!\n");
  
  const cleanup = async () => {
    console.log("\n\nStopping...");
    try { await page.evaluate(() => window.__stopCapture?.()); } catch {}
    try { await page.evaluate(() => window.leaveMeeting()); } catch {}
    ws.close();
    await browser.close();
    server.close();

    if (transcripts.length > 0) {
      console.log("\n\n=== TRANSCRIPT ===");
      transcripts.forEach(t => console.log(t));
      const outFile = path.join(__dirname, "transcript-output.txt");
      fs.writeFileSync(outFile, transcripts.join("\n"));
      console.log(`\nSaved to ${outFile}`);
    } else {
      console.log("\nNo transcription text received.");
    }
    console.log("Done.");
  };

  process.on("SIGINT", async () => { await cleanup(); process.exit(0); });

  await page.waitForTimeout(120000);
  await cleanup();
})().catch(async (err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
