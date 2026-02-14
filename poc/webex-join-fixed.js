// Test with HTTP server fix (mirrors the updated join.ts approach)
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ACCESS_TOKEN = "MWUzYzRhNmUtN2I2OC00NzRlLTkzZDctNDdkNDJjMWVmY2E0ZmZkMzJkMWItNmMx_PE93_f1a576ad-e802-497e-999b-fd0c44c79f11";
const MEETING_URL = "https://meet1651.webex.com/meet1651-de/j.php?MTID=m9d5a0c33632574062fff184b7986beca";
const BOT_NAME = "Vexa Bot (Test)";

(async () => {
  // 1. Start local HTTP server for meeting.html
  const htmlPath = path.join(__dirname, "..", "services", "vexa-bot", "core", "src", "platforms", "webex", "meeting.html");
  const htmlContent = fs.readFileSync(htmlPath, "utf-8");

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlContent);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  console.log(`HTTP server on port ${port}`);

  // 2. Launch browser
  const browser = await chromium.launch({
    headless: false,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const page = await (await browser.newContext({ permissions: ["microphone", "camera"] })).newPage();
  page.on("console", (msg) => console.log(`[PAGE] ${msg.text()}`));

  // 3. Navigate to HTTP-served page
  console.log("Loading page via HTTP...");
  await page.goto(`http://127.0.0.1:${port}/meeting.html`, { waitUntil: "networkidle" });

  // 4. Inject config
  await page.evaluate(({ meetingUrl, accessToken, displayName }) => {
    window.__WEBEX_CONFIG = { meetingUrl, access_token: accessToken, displayName };
  }, { meetingUrl: MEETING_URL, accessToken: ACCESS_TOKEN, displayName: BOT_NAME });

  console.log("Config injected. Initializing...");

  // 5. Run initWebex
  try {
    await Promise.race([
      page.evaluate(() => window.initWebex()),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout 120s")), 120000)),
    ]);

    const status = await page.evaluate(() => window.__WEBEX_STATUS);
    console.log("\n✅ Status:", JSON.stringify(status, null, 2));

    if (status.joined) {
      console.log("\n🎉 Successfully joined the meeting!");

      // Wait for audio
      for (let i = 0; i < 15; i++) {
        await page.waitForTimeout(2000);
        const s = await page.evaluate(() => window.__WEBEX_STATUS);
        if (s.audioReady) {
          console.log("🔊 Audio stream ready!");
          break;
        }
        process.stdout.write(".");
      }

      // Print logs
      const logs = await page.evaluate(() => window.__WEBEX_LOGS);
      console.log("\n--- SDK Logs ---");
      logs.forEach((l) => console.log(`  [${l.timestamp}] ${l.message}`));

      // Stay in meeting for 15s
      console.log("\nStaying in meeting for 15s...");
      await page.waitForTimeout(15000);

      // Leave
      console.log("Leaving...");
      await page.evaluate(() => window.leaveMeeting());
      console.log("✅ Left meeting.");
    }
  } catch (err) {
    console.error("❌", err.message);
    const logs = await page.evaluate(() => window.__WEBEX_LOGS).catch(() => []);
    console.log("\n--- SDK Logs ---");
    logs.forEach((l) => console.log(`  [${l.timestamp}] ${l.message}`, l.data ? JSON.stringify(l.data) : ""));
  }

  await browser.close();
  server.close();
  console.log("Done.");
})();
