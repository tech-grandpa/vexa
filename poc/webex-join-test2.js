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
      "--disable-web-security",
    ],
  });
  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
  });
  const page = await context.newPage();
  page.on("console", (msg) => console.log(`[PAGE] ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[PAGE ERROR] ${err.message}`));

  // Use inline HTML with latest SDK
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Test</title></head>
<body>
<div id="status">Loading SDK...</div>
<script crossorigin src="https://unpkg.com/webex@^3/umd/webex.min.js"></script>
<script>
window.__WEBEX_STATUS = { initialized: false, registered: false, joined: false, audioReady: false, error: null };
window.__WEBEX_LOGS = [];
window.__WEBEX_AUDIO_STREAM = null;
window.__WEBEX_MEETING = null;

function log(msg, data) {
  window.__WEBEX_LOGS.push({ timestamp: new Date().toISOString(), message: msg, data: data || null });
  console.log('[WEBEX] ' + msg, data || '');
  document.getElementById('status').innerText = msg;
}

window.initWebex = async function(config) {
  try {
    log('Creating Webex instance...');
    const webex = window.Webex.init({
      config: {
        meetings: {
          reconnection: { enabled: false },
          enableRtx: true
        },
        logger: { level: 'error' }
      },
      credentials: {
        access_token: config.access_token
      }
    });
    window.__WEBEX_STATUS.initialized = true;
    log('SDK initialized, registering...');
    
    await webex.meetings.register();
    window.__WEBEX_STATUS.registered = true;
    log('Registered! Creating meeting...');
    
    const meeting = await webex.meetings.create(config.meetingUrl);
    window.__WEBEX_MEETING = meeting;
    log('Meeting created: ' + meeting.id);
    
    meeting.on('media:ready', (media) => {
      log('Media ready: ' + media.type);
      if (media.type === 'remoteAudio') {
        window.__WEBEX_AUDIO_STREAM = media.stream;
        window.__WEBEX_STATUS.audioReady = true;
      }
    });
    meeting.on('error', (err) => { log('Meeting error: ' + err.message); });
    meeting.on('meeting:removed', (r) => { log('Removed from meeting', r); });
    meeting.on('meeting:ended', () => { log('Meeting ended'); });
    
    log('Joining meeting...');
    await meeting.join({
      mediaOptions: { receiveAudio: true, receiveVideo: false, sendAudio: false, sendVideo: false }
    });
    window.__WEBEX_STATUS.joined = true;
    log('Joined successfully!');
    return { success: true };
  } catch (err) {
    log('Error: ' + err.message, { stack: err.stack });
    window.__WEBEX_STATUS.error = err.message;
    throw err;
  }
};

window.leaveMeeting = async function() {
  if (window.__WEBEX_MEETING) {
    await window.__WEBEX_MEETING.leave();
    log('Left meeting');
  }
};

log('Page loaded, SDK version: ' + (window.Webex ? 'loaded' : 'MISSING'));
</script>
</body></html>`;

  // Serve inline HTML via data URL won't work for SDK, use a temp file
  const fs = require("fs");
  const tmpHtml = path.join(__dirname, "_test_meeting.html");
  fs.writeFileSync(tmpHtml, html);
  
  console.log("Loading page...");
  await page.goto(`file://${tmpHtml}`, { waitUntil: "networkidle", timeout: 30000 });

  console.log("Initializing SDK...");
  try {
    await Promise.race([
      page.evaluate((config) => window.initWebex(config), {
        access_token: ACCESS_TOKEN,
        meetingUrl: MEETING_URL,
        displayName: BOT_NAME,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout 90s")), 90000)),
    ]);

    const status = await page.evaluate(() => window.__WEBEX_STATUS);
    console.log("✅ Status:", JSON.stringify(status, null, 2));

    // Wait for audio
    console.log("Waiting for audio stream...");
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(2000);
      const s = await page.evaluate(() => window.__WEBEX_STATUS);
      if (s.audioReady) { console.log("✅ Audio ready!"); break; }
      process.stdout.write(".");
    }

    const logs = await page.evaluate(() => window.__WEBEX_LOGS);
    console.log("\n--- Logs ---");
    logs.forEach(l => console.log(`  ${l.message}`, l.data ? JSON.stringify(l.data) : ""));

    console.log("\nLeaving...");
    await page.evaluate(() => window.leaveMeeting());
    console.log("✅ Done");
  } catch (err) {
    console.error("❌", err.message);
    const logs = await page.evaluate(() => window.__WEBEX_LOGS);
    logs.forEach(l => console.log(`  ${l.message}`, l.data ? JSON.stringify(l.data) : ""));
  }

  fs.unlinkSync(tmpHtml);
  await browser.close();
})();
