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
  page.on("pageerror", (err) => console.log(`[PAGE ERROR] ${err.message}`));

  // Use non-minified SDK for better error messages
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Debug2</title></head>
<body>
<script crossorigin src="https://unpkg.com/webex@3.7.0/umd/webex.min.js"></script>
<script>
window.runTest = async function(token, meetingUrl) {
  const webex = window.Webex.init({
    credentials: { access_token: token },
    config: {
      logger: { level: 'debug' }
    }
  });
  
  // Ensure webex is fully ready - try waiting for internal services
  console.log('[TEST] Waiting for webex to be ready...');
  
  // The SDK might need the webex instance to finish bootstrapping
  // Let's try to explicitly set up the parent reference
  console.log('[TEST] webex.meetings.parent:', typeof webex.meetings.parent);
  console.log('[TEST] webex.meetings.webex:', typeof webex.meetings.webex);
  
  // Check if there's a ready promise
  if (typeof webex.once === 'function') {
    console.log('[TEST] Waiting for ready event...');
    try {
      await Promise.race([
        new Promise(resolve => {
          if (webex.canAuthorize) {
            console.log('[TEST] canAuthorize is already true');
            resolve();
          } else {
            webex.once('ready', () => {
              console.log('[TEST] webex ready event fired');
              resolve();
            });
          }
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ready timeout')), 15000))
      ]);
    } catch(e) {
      console.log('[TEST] Ready wait result:', e.message);
    }
  }
  
  console.log('[TEST] canAuthorize:', webex.canAuthorize);
  console.log('[TEST] meetings.parent after ready:', typeof webex.meetings.parent);
  
  try {
    await webex.meetings.register();
    console.log('[TEST] Registered!');
    
    const meeting = await webex.meetings.create(meetingUrl);
    console.log('[TEST] Meeting created:', meeting.id);
    
    meeting.on('media:ready', (m) => console.log('[TEST] media:ready:', m.type));
    meeting.on('error', (e) => console.log('[TEST] meeting error:', e.message));
    
    await meeting.join({
      mediaOptions: { receiveAudio: true, receiveVideo: false, sendAudio: false, sendVideo: false }
    });
    console.log('[TEST] JOINED!');
    
    // Wait 10s
    await new Promise(r => setTimeout(r, 10000));
    
    const status = { joined: true };
    await meeting.leave();
    console.log('[TEST] Left');
    return status;
  } catch(e) {
    console.log('[TEST] Error:', e.message);
    return { error: e.message };
  }
};
</script>
</body></html>`;

  const tmpHtml = path.join(__dirname, "_debug2.html");
  fs.writeFileSync(tmpHtml, html);
  await page.goto(`file://${tmpHtml}`, { waitUntil: "networkidle", timeout: 30000 });

  const result = await Promise.race([
    page.evaluate(({ token, url }) => window.runTest(token, url), { token: ACCESS_TOKEN, url: MEETING_URL }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Overall timeout 120s")), 120000)),
  ]);
  console.log("\nResult:", JSON.stringify(result, null, 2));

  fs.unlinkSync(tmpHtml);
  await browser.close();
})();
