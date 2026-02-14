import { Page } from "playwright";
import { log, callLeaveCallback } from "../../utils";
import { BotConfig } from "../../types";
import { LeaveReason } from "../shared/meetingFlow";
import { stopLocalServer } from "./join";
import { getActiveTranscriptRoom, setActiveTranscriptRoom } from "./recording";

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
    // End the transcript room and deliver final transcript to host
    const meetingKey = botConfig?.meeting_id ?? botConfig?.meetingUrl ?? 'unknown';
    const transcriptRoom = getActiveTranscriptRoom(meetingKey);
    if (transcriptRoom) {
      try {
        const transcript = await transcriptRoom.getTranscriptText();
        const viewerUrl = transcriptRoom.getViewerUrl();

        if (transcript && transcript.trim()) {
          const lineCount = transcript.split('\n').length;
          log(`[TranscriptRoom] Full transcript: ${lineCount} lines`);

          // Deliver transcript to host via Webex message
          if (botConfig?.data?.hostEmail && botConfig?.data?.access_token) {
            await deliverTranscriptToHost(
              botConfig.data.access_token,
              botConfig.data.hostEmail,
              transcript,
              viewerUrl
            );
          }

          // Deliver via webhook callback if configured
          const callbackUrl = process.env.TRANSCRIPT_DELIVERY_CALLBACK || botConfig?.data?.transcriptDeliveryCallback;
          if (callbackUrl) {
            await deliverTranscriptViaCallback(callbackUrl, transcript, botConfig);
          }
        }

        await transcriptRoom.endRoom();
        transcriptRoom.cleanup();
      } catch (err: any) {
        log(`[TranscriptRoom] Error during room cleanup: ${err.message}`);
      } finally {
        // Always remove the Map entry regardless of errors
        setActiveTranscriptRoom(meetingKey, null);
      }
    }

    // Clean up the local HTTP server used to serve meeting.html
    stopLocalServer();
  }
}

/**
 * Send the full transcript to the meeting host via Webex direct message.
 * Uses Node.js native fetch (not page.evaluate — page may be closing).
 * Truncates to fit Webex message limits (~7500 chars for markdown).
 */
async function deliverTranscriptToHost(
  accessToken: string,
  hostEmail: string,
  transcript: string,
  viewerUrl: string | null
): Promise<void> {
  try {
    const MAX_CHARS = 6000;
    let body = transcript;
    let truncated = false;
    if (body.length > MAX_CHARS) {
      body = body.slice(0, MAX_CHARS);
      truncated = true;
    }

    const lineCount = transcript.split('\n').length;
    const header = `📝 **Meeting Transcript**\n\n`;
    const footer = truncated
      ? `\n\n---\n_Transcript truncated (${lineCount} total lines).${viewerUrl ? ` Full version: ${viewerUrl}` : ''}_`
      : `\n\n---\n_${lineCount} lines total._`;

    const markdown = header + '```\n' + body + '\n```' + footer;
    const text = `📝 Meeting Transcript\n\n${body}${truncated ? '\n\n(truncated)' : ''}`;

    const resp = await fetch('https://webexapis.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        toPersonEmail: hostEmail,
        text,
        markdown,
      }),
    });

    if (resp.ok) {
      log(`[TranscriptRoom] Full transcript delivered to host: ${hostEmail}`);
    } else {
      log(`[TranscriptRoom] Failed to deliver transcript to host (HTTP ${resp.status})`);
    }
  } catch (err: any) {
    log(`[TranscriptRoom] Error delivering transcript to host: ${err.message}`);
  }
}

/**
 * Deliver the full transcript via a webhook callback (e.g. to bot-manager).
 */
async function deliverTranscriptViaCallback(
  callbackUrl: string,
  transcript: string,
  botConfig?: BotConfig
): Promise<void> {
  try {
    const resp = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        event: 'transcript_delivered',
        transcript,
        lineCount: transcript.split('\n').length,
        meetingId: botConfig?.meeting_id,
        meetingUrl: botConfig?.meetingUrl,
        timestamp: new Date().toISOString(),
      }),
    });

    log(`[TranscriptRoom] Transcript delivered via callback to ${callbackUrl} (HTTP ${resp.status})`);
  } catch (err: any) {
    log(`[TranscriptRoom] Callback delivery failed: ${err.message}`);
  }
}
