import { Page } from "playwright";
import { log, randomDelay, callJoiningCallback } from "../../utils";
import { BotConfig } from "../../types";
import * as path from "path";

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

  // Load meeting.html from local file system
  const htmlPath = path.join(__dirname, "meeting.html");
  const htmlUrl = `file://${htmlPath}`;

  log(`Loading Webex SDK host page: ${htmlPath}`);
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
      window.__WEBEX_CONFIG = {
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
    await page.evaluate(() => window.initWebex());
  } catch (err: any) {
    // Get detailed error logs from the page
    const logs = await page.evaluate(() => window.__WEBEX_LOGS);
    log("Failed to initialize Webex SDK. Page logs:");
    logs.forEach((logEntry: any) => {
      log(`  [${logEntry.timestamp}] ${logEntry.message}`, logEntry.data);
    });
    throw new Error(`Webex SDK initialization failed: ${err.message}`);
  }

  // Wait for join to complete
  log("Waiting for meeting join to complete...");
  await page.waitForFunction(
    () => {
      const status = window.__WEBEX_STATUS;
      return status.joined || status.error;
    },
    { timeout: 60000 }
  );

  // Check for errors
  const status = await page.evaluate(() => window.__WEBEX_STATUS);
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
