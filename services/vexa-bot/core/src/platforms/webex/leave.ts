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
    // End the transcript room and deliver final transcript to host
    const transcriptRoom = getActiveTranscriptRoom();
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
              page,
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
      }
    }

    // Clean up the local HTTP server used to serve meeting.html
    stopLocalServer();
  }
}

/**
 * Send the full transcript to the meeting host via Webex direct message.
 * Truncates to fit Webex message limits (~7500 chars for markdown).
 */
async function deliverTranscriptToHost(
  page: Page | null,
  accessToken: string,
  hostEmail: string,
  transcript: string,
  viewerUrl: string | null
): Promise<void> {
  try {
    // Webex message limit is ~7500 chars. If transcript is longer, truncate and note.
    const MAX_CHARS = 6000;
    let body = transcript;
    let truncated = false;
    if (body.length > MAX_CHARS) {
      body = body.slice(0, MAX_CHARS);
      truncated = true;
    }

    const header = `📝 **Meeting Transcript**\n\n`;
    const footer = truncated
      ? `\n\n---\n_Transcript truncated (${transcript.split('\n').length} total lines).${viewerUrl ? ` Full version: ${viewerUrl}` : ''}_`
      : `\n\n---\n_${transcript.split('\n').length} lines total._`;

    const markdown = header + '```\n' + body + '\n```' + footer;
    const text = `📝 Meeting Transcript\n\n${body}${truncated ? '\n\n(truncated)' : ''}`;

    // Use fetch from page context (has network access)
    if (page) {
      const sent = await page.evaluate(async ({ token, email, md, txt }: any) => {
        try {
          const resp = await fetch('https://webexapis.com/v1/messages', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              toPersonEmail: email,
              text: txt,
              markdown: md,
            }),
          });
          return resp.ok;
        } catch { return false; }
      }, { token: accessToken, email: hostEmail, md: markdown, txt: text });

      if (sent) {
        log(`[TranscriptRoom] Full transcript delivered to host: ${hostEmail}`);
      } else {
        log(`[TranscriptRoom] Failed to deliver transcript to host (API returned error)`);
      }
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
    const http = require('http');
    const https = require('https');
    const parsed = new URL(callbackUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify({
      event: 'transcript_delivered',
      transcript,
      lineCount: transcript.split('\n').length,
      meetingId: botConfig?.meeting_id,
      meetingUrl: botConfig?.meetingUrl,
      timestamp: new Date().toISOString(),
    });

    await new Promise<void>((resolve, reject) => {
      const req = client.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (res: any) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Callback timeout')); });
      req.write(body);
      req.end();
    });

    log(`[TranscriptRoom] Transcript delivered via callback to ${callbackUrl}`);
  } catch (err: any) {
    log(`[TranscriptRoom] Callback delivery failed: ${err.message}`);
  }
}
