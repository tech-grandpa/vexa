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

  // If already joined, we're immediately admitted (no lobby)
  if (initialStatus.joined) {
    log("Bot immediately admitted (no lobby) — adding media...");
    await addMediaWithRetry(page);
    
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
        // Check for joined state or error
        if (status.joined) return true;
        if (status.error) return true;
        
        // Check meeting state if available
        if (status.meetingState) {
          if (status.meetingState === "JOINED") return true;
          if (status.meetingState === "REJECTED") return true;
        }
        
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
  if (finalStatus.meetingState === "REJECTED") {
    log("Bot was rejected by meeting admin");
    return { admitted: false, rejected: true, reason: "admission_rejected_by_admin" };
  }

  // Check for errors
  if (finalStatus.error) {
    log(`Admission failed with error: ${finalStatus.error}`);
    return { admitted: false, rejected: false, reason: finalStatus.error };
  }

  // Check if joined — then add media (WebRTC negotiation)
  if (finalStatus.joined) {
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
