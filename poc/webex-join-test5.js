const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const ACCESS_TOKEN = "MWUzYzRhNmUtN2I2OC00NzRlLTkzZDctNDdkNDJjMWVmY2E0ZmZkMzJkMWItNmMx_PE93_f1a576ad-e802-497e-999b-fd0c44c79f11";
const MEETING_URL = "https://meet1651.webex.com/meet1651-de/j.php?MTID=m9d5a0c33632574062fff184b7986beca";

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const page = await (await browser.newContext({ permissions: ["microphone", "camera"] })).newPage();
  page.on("console", (msg) => console.log(`[PAGE] ${msg.text()}`));

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Test5</title></head>
<body>
<script crossorigin src="https://unpkg.com/webex@3.7.0/umd/webex.min.js"></script>
<script>
window.runTest = async function(token, meetingUrl) {
  const webex = window.Webex.init({
    credentials: { access_token: token },
    config: { logger: { level: 'info' } }
  });
  
  // Wait for meetings plugin to be ready
  console.log('[TEST] Waiting for meetings:ready...');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('meetings:ready timeout 30s')), 30000);
    webex.meetings.on('meetings:ready', () => {
      clearTimeout(timeout);
      console.log('[TEST] meetings:ready fired!');
      resolve();
    });
  });
  
  console.log('[TEST] Now registering...');
  try {
    await webex.meetings.register();
    console.log('[TEST] Registered!');
  } catch(e) {
    console.log('[TEST] Register error:', e.message);
    return { error: e.message };
  }
  
  console.log('[TEST] Creating meeting for:', meetingUrl);
  const meeting = await webex.meetings.create(meetingUrl);
  console.log('[TEST] Meeting created:', meeting.id);
  
  meeting.on('media:ready', (m) => console.log('[TEST] media:ready:', m.type));
  meeting.on('error', (e) => console.log('[TEST] meeting error:', e.message));
  meeting.on('meeting:stateChange', (s) => console.log('[TEST] state:', JSON.stringify(s)));
  
  console.log('[TEST] Joining...');
  await meeting.join({
    mediaOptions: { receiveAudio: true, receiveVideo: false, sendAudio: false, sendVideo: false }
  });
  console.log('[TEST] JOINED SUCCESSFULLY!');
  
  // Wait 10s to observe
  await new Promise(r => setTimeout(r, 10000));
  
  await meeting.leave();
  console.log('[TEST] Left meeting');
  return { success: true };
};
</script>
</body></html>`;

  const tmpHtml = path.join(__dirname, "_test5.html");
  fs.writeFileSync(tmpHtml, html);
  await page.goto(`file://${tmpHtml}`, { waitUntil: "networkidle", timeout: 30000 });

  try {
    const result = await Promise.race([
      page.evaluate(({ token, url }) => window.runTest(token, url), { token: ACCESS_TOKEN, url: MEETING_URL }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout 120s")), 120000)),
    ]);
    console.log("\n✅ Result:", JSON.stringify(result, null, 2));
  } catch(e) {
    console.error("\n❌", e.message);
  }

  fs.unlinkSync(tmpHtml);
  await browser.close();
})();
