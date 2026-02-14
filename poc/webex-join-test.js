// Quick standalone test: join a Webex meeting using the SDK via Playwright
const { chromium } = require("playwright");
const path = require("path");

const ACCESS_TOKEN = "MWUzYzRhNmUtN2I2OC00NzRlLTkzZDctNDdkNDJjMWVmY2E0ZmZkMzJkMWItNmMx_PE93_f1a576ad-e802-497e-999b-fd0c44c79f11";
const MEETING_URL = "https://meet1651.webex.com/meet1651-de/j.php?MTID=m9d5a0c33632574062fff184b7986beca";
const BOT_NAME = "Vexa Bot (Test)";

(async () => {
  console.log("Launching browser...");
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
  });
  const page = await context.newPage();

  // Listen to console
  page.on("console", (msg) => console.log(`[PAGE] ${msg.text()}`));

  // Load the meeting.html
  const htmlPath = path.join(__dirname, "..", "services", "vexa-bot", "core", "src", "platforms", "webex", "meeting.html");
  console.log(`Loading: ${htmlPath}`);
  await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });

  // Inject config
  await page.evaluate(({ meetingUrl, accessToken, displayName }) => {
    window.__WEBEX_CONFIG = { meetingUrl, access_token: accessToken, displayName };
  }, { meetingUrl: MEETING_URL, accessToken: ACCESS_TOKEN, displayName: BOT_NAME });

  console.log("Config injected. Initializing Webex SDK...");

  try {
    await Promise.race([
      page.evaluate(() => window.initWebex()),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout after 90s")), 90000)),
    ]);

    const status = await page.evaluate(() => window.__WEBEX_STATUS);
    console.log("Status:", JSON.stringify(status, null, 2));

    if (status.joined) {
      console.log("✅ Successfully joined the meeting!");
      
      // Wait a bit to see audio stream status
      await page.waitForTimeout(5000);
      const statusAfter = await page.evaluate(() => window.__WEBEX_STATUS);
      console.log("Status after 5s:", JSON.stringify(statusAfter, null, 2));
      
      // Get logs
      const logs = await page.evaluate(() => window.__WEBEX_LOGS);
      console.log("\n--- SDK Logs ---");
      logs.forEach(l => console.log(`  [${l.timestamp}] ${l.message}`, l.data || ""));

      // Leave
      console.log("\nLeaving meeting...");
      await page.evaluate(() => window.leaveMeeting());
      console.log("✅ Left meeting.");
    } else {
      console.log("❌ Join failed:", status.error);
    }
  } catch (err) {
    console.error("❌ Error:", err.message);
    const logs = await page.evaluate(() => window.__WEBEX_LOGS);
    console.log("\n--- SDK Logs ---");
    logs.forEach(l => console.log(`  [${l.timestamp}] ${l.message}`, l.data || ""));
  }

  await browser.close();
  console.log("Done.");
})();
