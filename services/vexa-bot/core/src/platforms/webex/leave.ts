import { Page } from "playwright";
import { log, callLeaveCallback } from "../../utils";
import { BotConfig } from "../../types";
import { LeaveReason } from "../shared/meetingFlow";
import { stopLocalServer } from "./join";

export async function prepareForWebexRecording(
  page: Page,
  botConfig: BotConfig
): Promise<void> {
  // Expose logBot function to browser context for logging
  await page.exposeFunction("logBot", (message: string) => {
    log(`[Browser] ${message}`);
  });

  log("Webex recording preparation complete");
}

export async function leaveWebex(
  page: Page | null,
  botConfig?: BotConfig,
  reason?: LeaveReason
): Promise<boolean> {
  if (!page) {
    log("Cannot leave Webex: page is null");
    return false;
  }

  try {
    log(`Leaving Webex meeting (reason: ${reason || "normal_completion"})...`);

    // Call leaveMeeting via SDK
    const leaveResult = await page.evaluate(() => (window as any).leaveMeeting());

    if (leaveResult && leaveResult.success) {
      log("Successfully left Webex meeting via SDK");

      // Call the leave callback after successful leave
      if (botConfig) {
        try {
          await callLeaveCallback(botConfig, reason);
          log("Leave callback sent successfully");
        } catch (callbackError: any) {
          log(
            `Warning: Failed to send leave callback: ${callbackError.message}`
          );
        }
      }

      return true;
    } else {
      log(
        `Failed to leave Webex meeting: ${leaveResult?.reason || "unknown"}`
      );
      return false;
    }
  } catch (err: any) {
    log(`Error leaving Webex meeting: ${err.message}`);
    return false;
  } finally {
    // Clean up the local HTTP server used to serve meeting.html
    stopLocalServer();
  }
}
