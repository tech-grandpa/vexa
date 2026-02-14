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
<html><head><meta charset="UTF-8"><title>Debug</title></head>
<body>
<script crossorigin src="https://unpkg.com/webex@3.7.0/umd/webex.min.js"></script>
<script>
window.debugTest = async function(token) {
  console.log('[DBG] Creating Webex instance...');
  const webex = window.Webex.init({
    credentials: { access_token: token }
  });
  
  console.log('[DBG] webex created, type:', typeof webex);
  console.log('[DBG] webex.internal:', typeof webex.internal);
  console.log('[DBG] webex.internal keys:', webex.internal ? Object.keys(webex.internal) : 'N/A');
  console.log('[DBG] webex.meetings:', typeof webex.meetings);
  console.log('[DBG] webex.meetings keys:', webex.meetings ? Object.keys(webex.meetings).slice(0,10) : 'N/A');
  
  // Check if internal.device exists
  if (webex.internal) {
    console.log('[DBG] webex.internal.device:', typeof webex.internal.device);
    console.log('[DBG] webex.internal.mercury:', typeof webex.internal.mercury);
    console.log('[DBG] webex.internal.services:', typeof webex.internal.services);
  }
  
  // Try register with more detail
  console.log('[DBG] Attempting meetings.register()...');
  try {
    await webex.meetings.register();
    console.log('[DBG] register() succeeded!');
    return { success: true };
  } catch(e) {
    console.log('[DBG] register() error:', e.message);
    console.log('[DBG] register() stack:', e.stack);
    
    // Try to see what 'internal' property is being accessed
    // The error is "Cannot read properties of undefined (reading 'internal')"
    // That means something.internal where something is undefined
    return { error: e.message, stack: e.stack };
  }
};
</script>
</body></html>`;

  const tmpHtml = path.join(__dirname, "_debug.html");
  fs.writeFileSync(tmpHtml, html);
  await page.goto(`file://${tmpHtml}`, { waitUntil: "networkidle", timeout: 30000 });

  const result = await page.evaluate((token) => window.debugTest(token), ACCESS_TOKEN);
  console.log("\nResult:", JSON.stringify(result, null, 2));

  fs.unlinkSync(tmpHtml);
  await browser.close();
})();
