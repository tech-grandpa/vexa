import { Page } from "playwright";
import { log, callAwaitingAdmissionCallback } from "../../utils";
import { BotConfig } from "../../types";
import { AdmissionResult } from "../shared/meetingFlow";

/**
 * Call addMeetingMedia() on the page with retry logic.
 * The bot may still be transitioning from lobby → active, so we retry
 * on "lobby" or "not Active" errors.
 */
async function addMediaWithRetry(page: Page, maxAttempts = 6): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.evaluate(() => (window as any).addMeetingMedia());
      log("Media added successfully");
      return;
    } catch (err: any) {
      const msg = err.message || "";
      if ((msg.includes("lobby") || msg.includes("not Active")) && attempt < maxAttempts) {
        log(`addMedia attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 100)}) — retrying in 5s...`);
        await page.waitForTimeout(5000);
      } else {
        throw new Error(`addMedia failed after ${attempt} attempts: ${msg.slice(0, 200)}`);
      }
    }
  }
}

export async function waitForWebexAdmission(
  page: Page,
  timeoutMs: number,
  botConfig: BotConfig
): Promise<AdmissionResult> {
  log("Waiting for Webex admission...");

  // Check current status
  const initialStatus = await page.evaluate(() => (window as any).__WEBEX_STATUS);

  // If already joined (stateChange fired JOINED/ACTIVE before we got here),
  // we're immediately admitted (no lobby)
  if (initialStatus.joined) {
    log("Bot immediately admitted (no lobby, stateChange already fired) — adding media...");
    try {
      await addMediaWithRetry(page);
    } catch (mediaErr: any) {
      // If addMedia fails despite joined=true, the bot may actually be in lobby
      // (joined flag was set prematurely). Fall through to lobby-waiting logic.
      log(`addMedia failed despite joined=true — falling through to lobby wait: ${mediaErr.message}`);
      // Reset joined so the waiting logic works correctly
      await page.evaluate(() => { (window as any).__WEBEX_STATUS.joined = false; });
      return await waitInLobby(page, timeoutMs, botConfig);
    }
    
    // Send AWAITING_ADMISSION callback even for immediate admission
    // to ensure state machine progresses correctly
    try {
      await callAwaitingAdmissionCallback(botConfig);
      log("Awaiting admission callback sent successfully");
    } catch (callbackError: any) {
      log(
        `Warning: Failed to send awaiting admission callback: ${callbackError.message}`
      );
    }
    
    return { admitted: true, rejected: false };
  }

  // Not yet admitted — wait in lobby
  return await waitInLobby(page, timeoutMs, botConfig);
}

async function waitInLobby(
  page: Page,
  timeoutMs: number,
  botConfig: BotConfig
): Promise<AdmissionResult> {
  log("Bot is in lobby — waiting for admission...");

  // Send awaiting admission callback
  try {
    await callAwaitingAdmissionCallback(botConfig);
    log("Awaiting admission callback sent successfully");
  } catch (callbackError: any) {
    log(
      `Warning: Failed to send awaiting admission callback: ${callbackError.message}`
    );
  }

  // Wait for admission or rejection
  try {
    await page.waitForFunction(
      () => {
        const status = (window as any).__WEBEX_STATUS;
        // Check for joined state (set by stateChange handler) or error
        if (status.joined) return true;
        if (status.error) return true;
        
        // Check meeting state if available
        if (status.meetingState) {
          const state = String(status.meetingState).toUpperCase();
          if (state === "JOINED" || state === "ACTIVE" || state === "IN_MEETING") return true;
          if (state === "REJECTED") return true;
        }

        // Check if audio stream appeared (strong signal of admission)
        if (status.audioReady) return true;
        
        return false;
      },
      { timeout: timeoutMs }
    );
  } catch (timeoutError) {
    log("Admission timeout reached");
    return { admitted: false, rejected: false, reason: "admission_timeout" };
  }

  // Get final status
  const finalStatus = await page.evaluate(() => (window as any).__WEBEX_STATUS);

  // Check for rejection
  const meetingState = String(finalStatus.meetingState || "").toUpperCase();
  if (meetingState === "REJECTED") {
    log("Bot was rejected by meeting admin");
    return { admitted: false, rejected: true, reason: "admission_rejected_by_admin" };
  }

  // Check for errors
  if (finalStatus.error) {
    log(`Admission failed with error: ${finalStatus.error}`);
    return { admitted: false, rejected: false, reason: finalStatus.error };
  }

  // Admitted — add media (WebRTC negotiation)
  if (finalStatus.joined || meetingState === "JOINED" || meetingState === "ACTIVE" || meetingState === "IN_MEETING" || finalStatus.audioReady) {
    log("Bot admitted to meeting — adding media...");
    await addMediaWithRetry(page);
    return { admitted: true, rejected: false };
  }

  // Unknown state
  log("Admission check completed with unknown state");
  return { admitted: false, rejected: false, reason: "unknown_state" };
}

export async function checkForWebexAdmissionSilent(page: Page): Promise<boolean> {
  // Silent check without callbacks
  try {
    const status = await page.evaluate(() => (window as any).__WEBEX_STATUS);
    return status.joined === true;
  } catch (err) {
    log(`Error during silent admission check: ${err}`);
    return false;
  }
}
