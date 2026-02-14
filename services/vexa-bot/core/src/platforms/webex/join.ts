import { Page } from "playwright";
import { log, randomDelay, callJoiningCallback } from "../../utils";
import { BotConfig } from "../../types";
import * as path from "path";
import * as http from "http";
import * as fs from "fs";

// Track active server so we can clean up
let activeServer: http.Server | null = null;

/**
 * Start a minimal HTTP server to serve meeting.html.
 * The Webex JS SDK makes XHR requests that require a non-null origin
 * (file:// gives origin "null" which fails CORS preflight).
 */
function startLocalServer(htmlPath: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const htmlContent = fs.readFileSync(htmlPath, "utf-8");

    const server = http.createServer((req, res) => {
      // Only serve meeting.html — reject all other paths
      if (req.url !== '/' && !req.url?.startsWith('/meeting.html')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(htmlContent);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        log(`Local HTTP server started on port ${addr.port}`);
        resolve({ server, port: addr.port });
      } else {
        reject(new Error("Failed to get server address"));
      }
    });

    server.on("error", reject);
  });
}

/** Stop the local server if running */
export function stopLocalServer(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
    log("Local HTTP server stopped");
  }
}

export async function joinWebexMeeting(
  page: Page,
  meetingUrl: string,
  botName: string,
  botConfig: BotConfig
): Promise<void> {
  // Validate that we have an access token
  if (!botConfig.data?.access_token) {
    throw new Error("Webex platform requires access_token in botConfig.data");
  }

  // Serve meeting.html over HTTP to avoid CORS issues with file:// origin
  const htmlPath = path.join(__dirname, "meeting.html");
  const { server, port } = await startLocalServer(htmlPath);
  activeServer = server;
  const htmlUrl = `http://127.0.0.1:${port}/meeting.html`;

  log(`Loading Webex SDK host page via HTTP: ${htmlUrl}`);
  await page.goto(htmlUrl, { waitUntil: "networkidle" });
  await page.bringToFront();

  // Take screenshot after navigation
  await page.screenshot({
    path: "/app/storage/screenshots/bot-checkpoint-0-after-navigation.png",
    fullPage: true,
  });
  log("📸 Screenshot taken: After navigation to SDK host page");

  // --- Call joining callback to notify bot-manager that bot is joining ---
  try {
    await callJoiningCallback(botConfig);
    log("Joining callback sent successfully");
  } catch (callbackError: any) {
    log(
      `Warning: Failed to send joining callback: ${callbackError.message}. Continuing with join process...`
    );
  }

  // Inject configuration
  await page.waitForTimeout(randomDelay(1000));
  log("Injecting Webex configuration...");

  await page.evaluate(
    ({ meetingUrl, accessToken, displayName }) => {
      (window as any).__WEBEX_CONFIG = {
        meetingUrl,
        access_token: accessToken,
        displayName,
      };
    },
    {
      meetingUrl,
      accessToken: botConfig.data.access_token,
      displayName: botName,
    }
  );

  log("Configuration injected successfully");

  // Take screenshot after config injection
  await page.screenshot({
    path: "/app/storage/screenshots/bot-checkpoint-1-config-injected.png",
    fullPage: true,
  });
  log("📸 Screenshot taken: After config injection");

  // Initialize and join meeting via SDK
  await page.waitForTimeout(randomDelay(1000));
  log("Initializing Webex SDK and joining meeting...");

  try {
    // initWebex() handles: SDK init → register → create meeting → join
    // This can take 30-60s depending on network/SDK/Webex response times
    await Promise.race([
      page.evaluate(() => (window as any).initWebex()),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Webex SDK initialization timed out after 90s")), 90000))
    ]);
  } catch (err: any) {
    // Get detailed error logs from the page
    const logs = await page.evaluate(() => (window as any).__WEBEX_LOGS);
    log("Failed to initialize Webex SDK. Page logs:");
    logs.forEach((logEntry: any) => {
      log(`  [${logEntry.timestamp}] ${logEntry.message}`, logEntry.data);
    });
    throw new Error(`Webex SDK initialization failed: ${err.message}`);
  }

  // Verify join status (initWebex sets status.joined on success)
  const status = await page.evaluate(() => (window as any).__WEBEX_STATUS);
  if (status.error) {
    throw new Error(`Webex join failed: ${status.error}`);
  }

  if (!status.joined) {
    throw new Error("Webex join failed: Unknown reason");
  }

  log(`${botName} joined the Webex Meeting successfully.`);

  // Take screenshot after successful join
  await page.screenshot({
    path: "/app/storage/screenshots/bot-checkpoint-2-after-join.png",
    fullPage: true,
  });
  log("📸 Screenshot taken: After successful join");
}
