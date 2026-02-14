import { Page } from "playwright";
import { log, callLeaveCallback } from "../../utils";
import { BotConfig } from "../../types";
import { LeaveReason } from "../shared/meetingFlow";
import { stopLocalServer } from "./join";
import { getActiveTranscriptRoom } from "./recording";

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
    // End the transcript room (starts expiry countdown)
    const transcriptRoom = getActiveTranscriptRoom();
    if (transcriptRoom) {
      try {
        const transcript = await transcriptRoom.getTranscriptText();
        if (transcript) {
          log(`[TranscriptRoom] Full transcript (${transcript.split('\n').length} lines) available until room expires`);
          // TODO: Deliver full transcript to host (email, Webex message, etc.)
        }
        await transcriptRoom.endRoom();
        transcriptRoom.cleanup();
      } catch (err: any) {
        log(`[TranscriptRoom] Error during room cleanup: ${err.message}`);
      }
    }

    // Clean up the local HTTP server used to serve meeting.html
    stopLocalServer();
  }
}
