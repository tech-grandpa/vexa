const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ACCESS_TOKEN = "MWUzYzRhNmUtN2I2OC00NzRlLTkzZDctNDdkNDJjMWVmY2E0ZmZkMzJkMWItNmMx_PE93_f1a576ad-e802-497e-999b-fd0c44c79f11";
const MEETING_URL = "https://meet1651.webex.com/meet1651-de/j.php?MTID=m9d5a0c33632574062fff184b7986beca";

(async () => {
  const htmlPath = path.join(__dirname, "..", "services", "vexa-bot", "core", "src", "platforms", "webex", "meeting.html");
  const server = http.createServer((req, res) => { res.writeHead(200, {"Content-Type":"text/html"}); res.end(fs.readFileSync(htmlPath)); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const browser = await chromium.launch({ headless: false, args: ["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream","--autoplay-policy=no-user-gesture-required"] });
  const page = await (await browser.newContext({permissions:["microphone","camera"]})).newPage();
  page.on("console", m => console.log(`[PAGE] ${m.text()}`));

  await page.goto(`http://127.0.0.1:${port}/`, {waitUntil:"networkidle"});
  await page.evaluate(({u,t}) => { window.__WEBEX_CONFIG = {meetingUrl:u, access_token:t, displayName:"Vexa Transcriber"}; },
    {u: MEETING_URL, t: ACCESS_TOKEN});

  console.log("Joining...");
  await Promise.race([
    page.evaluate(() => window.initWebex()),
    new Promise((_,r) => setTimeout(() => r(new Error("timeout")), 120000))
  ]);
  console.log("Joined! Now trying addMedia...");

  // The join() in meeting.html sets mediaOptions but maybe the SDK needs explicit addMedia
  try {
    const result = await page.evaluate(async () => {
      const m = window.__WEBEX_MEETING;
      // Check current state
      const info = {
        state: m?.state,
        mediaId: m?.mediaId,
        mediaConnections: !!m?.mediaConnections,
        locusMediaRequest: !!m?.locusMediaRequest,
      };
      console.log("[WEBEX] Meeting info:", JSON.stringify(info));

      // Try addMedia if no media yet
      if (!window.__WEBEX_STATUS.audioReady) {
        console.log("[WEBEX] Calling addMedia...");
        await m.addMedia({
          mediaOptions: {
            receiveAudio: true,
            receiveVideo: false,
            sendAudio: false,
            sendVideo: false,
          }
        });
        console.log("[WEBEX] addMedia completed!");
      }
      return { audioReady: window.__WEBEX_STATUS.audioReady };
    });
    console.log("addMedia result:", result);
  } catch(e) {
    console.log("addMedia error:", e.message.slice(0, 300));
  }

  // Wait for audio
  console.log("Waiting for audio...");
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => window.__WEBEX_STATUS);
    if (s.audioReady) { console.log("✅ Audio ready at", i, "seconds!"); break; }
    if (i % 10 === 0) console.log(`  ${i}s...`, JSON.stringify(s));
  }

  const finalStatus = await page.evaluate(() => window.__WEBEX_STATUS);
  console.log("Final status:", JSON.stringify(finalStatus, null, 2));

  const logs = await page.evaluate(() => window.__WEBEX_LOGS);
  console.log("\n--- Key logs ---");
  logs.filter(l => l.message.includes("Media") || l.message.includes("media") || l.message.includes("audio") || l.message.includes("Audio") || l.message.includes("error") || l.message.includes("Error"))
    .forEach(l => console.log(`  [${l.timestamp}] ${l.message}`, l.data ? JSON.stringify(l.data) : ""));

  await page.evaluate(() => window.leaveMeeting());
  await browser.close();
  server.close();
})();
