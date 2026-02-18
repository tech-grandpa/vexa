import { Page } from "playwright";
import { log } from "../../utils";
import { BotConfig } from "../../types";
import { WhisperLiveService } from "../../services/whisperlive";
import { TranscriptRoomClient } from "../../services/transcript-room";
import { ensureBrowserUtils } from "../../utils/injection";

// Per-meeting transcript room clients, keyed by meeting_id
const activeTranscriptRooms = new Map<string | number, TranscriptRoomClient>();

export function getActiveTranscriptRoom(meetingId: string | number): TranscriptRoomClient | null {
  return activeTranscriptRooms.get(meetingId) || null;
}

export function setActiveTranscriptRoom(meetingId: string | number, client: TranscriptRoomClient | null): void {
  if (client) {
    activeTranscriptRooms.set(meetingId, client);
  } else {
    activeTranscriptRooms.delete(meetingId);
  }
}

/**
 * Clean up all active transcript rooms (e.g. on process crash/shutdown).
 * Iterates all entries, calls endRoom() on each, then clears the Map.
 */
export async function cleanupAllTranscriptRooms(): Promise<void> {
  const entries = Array.from(activeTranscriptRooms.entries());
  for (const [meetingId, client] of entries) {
    try {
      await client.endRoom();
      client.cleanup();
      log(`[TranscriptRoom] Cleaned up room for meeting ${meetingId}`);
    } catch (err: any) {
      log(`[TranscriptRoom] Error cleaning up room for meeting ${meetingId}: ${err.message}`);
    }
  }
  activeTranscriptRooms.clear();
}

export async function startWebexRecording(
  page: Page,
  botConfig: BotConfig
): Promise<void> {
  // Initialize WhisperLive service on Node.js side
  const whisperLiveService = new WhisperLiveService({
    whisperLiveUrl: process.env.WHISPER_LIVE_URL,
  });

  // Initialize Transcript Room (ephemeral live viewer)
  const transcriptRoomUrl = process.env.TRANSCRIPT_ROOM_URL || 'http://localhost:8790';
  const transcriptRoomSecret = process.env.ROOM_SECRET || undefined;
  const transcriptRoom = new TranscriptRoomClient({ baseUrl: transcriptRoomUrl, secret: transcriptRoomSecret });
  const meetingKey = botConfig.meeting_id ?? botConfig.meetingUrl ?? 'unknown';
  setActiveTranscriptRoom(meetingKey, transcriptRoom);

  try {
    const meetingIdStr = botConfig.meeting_id != null ? String(botConfig.meeting_id) : (botConfig.meetingUrl || undefined);
    const room = await transcriptRoom.createRoom(meetingIdStr);
    log(`[TranscriptRoom] Live viewer: ${room.viewerUrl}`);

    // Notify about the viewer URL
    // The URL can be delivered via:
    //  - Webex meeting chat (if bot has messaging scope)
    //  - Webhook callback to bot-manager
    //  - Simply logged for the host to share
    if (botConfig.data?.access_token) {
      try {
        await postViewerUrlToMeeting(page, room.viewerUrl, botConfig);
      } catch (err: any) {
        log(`[TranscriptRoom] Could not post viewer URL: ${err.message}`);
      }
    }
  } catch (err: any) {
    log(`[TranscriptRoom] Failed to create room (continuing without live viewer): ${err.message}`);
    setActiveTranscriptRoom(meetingKey, null);
  }

  // Initialize WhisperLive connection with STUBBORN reconnection
  const whisperLiveUrl =
    await whisperLiveService.initializeWithStubbornReconnection("Webex");

  log(`[Node.js] Using WhisperLive URL for Webex: ${whisperLiveUrl}`);
  log("Starting Webex recording with WebSocket connection");

  // Expose transcript segment bridge: browser → Node.js → transcript room
  await page.exposeFunction("__onTranscriptSegment", (text: string, speaker: string | null, timestamp: string) => {
    const room = activeTranscriptRooms.get(meetingKey);
    if (room) {
      room.sendSegment(text, speaker || undefined, timestamp);
    }
  });

  // Inject browser utilities
  await ensureBrowserUtils(
    page,
    require("path").join(__dirname, "../../browser-utils.global.js")
  );

  // Pass config and URL to browser context
  await page.evaluate(
    async (pageArgs: {
      botConfigData: BotConfig;
      whisperUrlForBrowser: string;
    }) => {
      const { botConfigData, whisperUrlForBrowser } = pageArgs;

      // Use browser utility classes from the global bundle
      const browserUtils = (window as any).VexaBrowserUtils;
      (window as any).logBot(
        `Browser utils available: ${Object.keys(browserUtils || {}).join(", ")}`
      );

      // --- Early reconfigure wiring (stub + event) ---
      (window as any).__vexaPendingReconfigure = null;
      if (typeof (window as any).triggerWebSocketReconfigure !== "function") {
        (window as any).triggerWebSocketReconfigure = async (
          lang: string | null,
          task: string | null
        ) => {
          (window as any).__vexaPendingReconfigure = { lang, task };
          (window as any).logBot?.(
            "[Reconfigure] Stub queued update; will apply when service is ready."
          );
        };
      }
      try {
        document.addEventListener("vexa:reconfigure", (ev: Event) => {
          try {
            const detail = (ev as CustomEvent).detail || {};
            const { lang, task } = detail;
            const fn = (window as any).triggerWebSocketReconfigure;
            if (typeof fn === "function") fn(lang, task);
          } catch {}
        });
      } catch {}
      // ---------------------------------------------

      const audioService = new browserUtils.BrowserAudioService({
        targetSampleRate: 16000,
        bufferSize: 4096,
        inputChannels: 1,
        outputChannels: 1,
      });

      // Use BrowserWhisperLiveService with stubborn mode
      const whisperLiveService = new browserUtils.BrowserWhisperLiveService(
        {
          whisperLiveUrl: whisperUrlForBrowser,
        },
        true
      ); // Enable stubborn mode

      // Expose references for reconfiguration
      (window as any).__vexaWhisperLiveService = whisperLiveService;
      (window as any).__vexaAudioService = audioService;
      (window as any).__vexaBotConfig = botConfigData;

      // Replace stub with real reconfigure implementation
      (window as any).triggerWebSocketReconfigure = async (
        lang: string | null,
        task: string | null
      ) => {
        try {
          const svc = (window as any).__vexaWhisperLiveService;
          const cfg = (window as any).__vexaBotConfig || {};
          cfg.language = lang;
          cfg.task = task || "transcribe";
          (window as any).__vexaBotConfig = cfg;

          (window as any).logBot?.(
            `[Reconfigure] Closing existing connection to establish new session...`
          );
          try {
            if (svc?.closeForReconfigure) {
              svc.closeForReconfigure();
            } else {
              svc?.close();
            }
            const audioSvc = (window as any).__vexaAudioService;
            if (audioSvc?.resetSessionStartTime) {
              audioSvc.resetSessionStartTime();
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (closeErr: any) {
            (window as any).logBot?.(
              `[Reconfigure] Error closing connection: ${closeErr?.message || closeErr}`
            );
          }

          (window as any).logBot?.(
            `[Reconfigure] Reconnecting with new config: language=${cfg.language}, task=${cfg.task}`
          );
          await svc?.connectToWhisperLive(
            cfg,
            (window as any).__vexaOnMessage,
            (window as any).__vexaOnError,
            (window as any).__vexaOnClose
          );
          (window as any).logBot?.(
            `[Reconfigure] Successfully reconnected with new session. Language=${cfg.language}, Task=${cfg.task}`
          );
        } catch (e: any) {
          (window as any).logBot?.(
            `[Reconfigure] Error applying new config: ${e?.message || e}`
          );
        }
      };
      try {
        const pending = (window as any).__vexaPendingReconfigure;
        if (
          pending &&
          typeof (window as any).triggerWebSocketReconfigure === "function"
        ) {
          (window as any).triggerWebSocketReconfigure(pending.lang, pending.task);
          (window as any).__vexaPendingReconfigure = null;
        }
      } catch {}

      await new Promise<void>((resolve, reject) => {
        (window as any).logBot(
          "Starting Webex recording process with SDK audio stream."
        );

        (async () => {
          // Wait for audio stream to be ready
          (window as any).logBot(
            "Waiting for Webex audio stream to be ready..."
          );

          let audioStreamReady = false;
          for (let i = 0; i < 30; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const status = (window as any).__WEBEX_STATUS;
            if (status.audioReady && (window as any).__WEBEX_AUDIO_STREAM) {
              audioStreamReady = true;
              break;
            }

            if (status.error) {
              throw new Error(`Webex error: ${status.error}`);
            }
          }

          if (!audioStreamReady) {
            throw new Error(
              "Webex audio stream not ready after 30 seconds"
            );
          }

          (window as any).logBot("Audio stream is ready");

          const audioStream = (window as any).__WEBEX_AUDIO_STREAM;
          if (!audioStream) {
            throw new Error("No audio stream available");
          }

          // Set up callbacks
          (window as any).__vexaOnMessage = (data: any) => {
            try {
              // Handle WhisperLive protocol messages
              if (data["status"] === "ERROR") {
                (window as any).logBot(`Webex WebSocket Server Error: ${data["message"]}`);
              } else if (data["status"] === "WAIT") {
                (window as any).logBot(`Webex Server busy: ${data["message"]}`);
              } else if (!whisperLiveService.isReady() && data["status"] === "SERVER_READY") {
                whisperLiveService.setServerReady(true);
                (window as any).logBot("Webex Server is ready.");
              } else if (data["language"]) {
                (window as any).logBot(`Webex Language detected: ${data["language"]}`);
              } else if (data["message"] === "DISCONNECT") {
                (window as any).logBot("Webex Server requested disconnect.");
                whisperLiveService.close();
              }

              // Forward finalized transcript segments to the live viewer room.
              const isFinal = data.is_final !== false;
              if (isFinal && data && data.text && data.text.trim()) {
                (window as any).__onTranscriptSegment(
                  data.text.trim(),
                  data.speaker || data.participant_name || null,
                  data.timestamp ? new Date(data.timestamp * 1000).toISOString() : new Date().toISOString()
                );
              }
            } catch (err: any) {
              (window as any).logBot(
                `[WhisperLive] Error processing transcription: ${err?.message || err}`
              );
            }
          };

          (window as any).__vexaOnError = (error: any) => {
            (window as any).logBot(
              `[WhisperLive] WebSocket error: ${error?.message || error}`
            );
          };

          (window as any).__vexaOnClose = () => {
            (window as any).logBot("[WhisperLive] WebSocket closed");
          };

          // Connect to WhisperLive
          (window as any).logBot("Connecting to WhisperLive...");
          await whisperLiveService.connectToWhisperLive(
            botConfigData,
            (window as any).__vexaOnMessage,
            (window as any).__vexaOnError,
            (window as any).__vexaOnClose
          );

          (window as any).logBot("Connected to WhisperLive successfully");

          // Set up audio capture from Webex SDK stream
          (window as any).logBot(
            "Setting up audio capture from Webex stream..."
          );

          const audioContext = new AudioContext({ sampleRate: 16000 });
          const source = audioContext.createMediaStreamSource(audioStream);
          const processor = audioContext.createScriptProcessor(4096, 1, 1);

          let sampleCount = 0;
          let lastLogAt = 0;
          processor.onaudioprocess = (e) => {
            const float32Audio = e.inputBuffer.getChannelData(0);

            // Convert to Int16
            const int16Audio = new Int16Array(float32Audio.length);
            for (let i = 0; i < float32Audio.length; i++) {
              int16Audio[i] =
                Math.max(-1, Math.min(1, float32Audio[i])) * 0x7fff;
            }

            // Send to WhisperLive
            whisperLiveService.sendAudioData(int16Audio.buffer);

            sampleCount += float32Audio.length;
            if (sampleCount >= lastLogAt + 160000) {
              // Log every ~10 seconds at 16kHz
              lastLogAt = sampleCount;
              (window as any).logBot(
                `Audio capture active: ${Math.floor(sampleCount / 16000)}s`
              );
            }
          };

          source.connect(processor);
          processor.connect(audioContext.destination);

          (window as any).logBot(
            "Audio capture started successfully. Recording meeting audio..."
          );

          // Store references for cleanup
          (window as any).__vexaAudioContext = audioContext;
          (window as any).__vexaAudioProcessor = processor;
          (window as any).__vexaAudioSource = source;

          // --- Stay alive: monitor meeting state until it ends ---
          const leaveCfg = (botConfigData && (botConfigData as any).automaticLeave) || {};
          const startupAloneTimeoutSeconds = Number(leaveCfg.startupAloneTimeoutSeconds ?? 10);
          const everyoneLeftTimeoutSeconds = Number(leaveCfg.everyoneLeftTimeoutSeconds ?? 10);

          let aloneTime = 0;
          let hasEverHadOtherParticipants = false;

          const checkForMeetingEnd = () => {
            try {
              const status = (window as any).__WEBEX_STATUS;
              if (status && status.error) {
                (window as any).logBot(`🚨 Webex error detected: ${status.error}`);
                return 'error';
              }
              // Check if meeting ended or bot was removed
              if (status && status.ended) {
                (window as any).logBot('🚨 Webex meeting ended detected via status.ended');
                return 'ended';
              }
              if (status && status.removed) {
                (window as any).logBot(`🚨 Webex bot removed from meeting: ${status.removalReason}`);
                return 'removed';
              }
              return null;
            } catch {
              return null;
            }
          };

          const monitorInterval = setInterval(() => {
            // Check for meeting end
            const endState = checkForMeetingEnd();
            if (endState) {
              (window as any).logBot(`Webex meeting ended (${endState}). Stopping recorder...`);
              clearInterval(monitorInterval);
              audioContext.close().catch(() => {});
              whisperLiveService.close();
              resolve();
              return;
            }

            // Check participant count if available
            const participantCount = (window as any).__WEBEX_PARTICIPANT_COUNT;
            const otherParticipants = typeof participantCount === 'number' ? participantCount : -1;

            if (otherParticipants > 0) {
              hasEverHadOtherParticipants = true;
              aloneTime = 0;
            } else if (otherParticipants === 0) {
              aloneTime++;
              const timeout = hasEverHadOtherParticipants ? everyoneLeftTimeoutSeconds : startupAloneTimeoutSeconds;
              const mode = hasEverHadOtherParticipants ? 'everyone_left' : 'startup_alone';

              if (aloneTime % 10 === 0) {
                (window as any).logBot(`⏱️ Webex bot alone: ${aloneTime}s/${timeout}s (${mode})`);
              }

              if (aloneTime >= timeout) {
                const token = hasEverHadOtherParticipants ? 'WEBEX_BOT_LEFT_ALONE_TIMEOUT' : 'WEBEX_BOT_STARTUP_ALONE_TIMEOUT';
                (window as any).logBot(`Webex bot alone timeout (${mode}). Stopping recorder...`);
                clearInterval(monitorInterval);
                audioContext.close().catch(() => {});
                whisperLiveService.close();
                reject(new Error(token));
                return;
              }
            }
            // If participantCount is -1 (not tracked), just keep running
          }, 1000);

          // Listen for page unload
          window.addEventListener("beforeunload", () => {
            (window as any).logBot("Webex page is unloading. Stopping recorder...");
            clearInterval(monitorInterval);
            audioContext.close().catch(() => {});
            whisperLiveService.close();
            resolve();
          });

          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") {
              (window as any).logBot("Webex document is hidden. Stopping recorder...");
              clearInterval(monitorInterval);
              audioContext.close().catch(() => {});
              whisperLiveService.close();
              resolve();
            }
          });
        })().catch(reject);
      });
    },
    {
      botConfigData: botConfig,
      whisperUrlForBrowser: whisperLiveUrl,
    }
  );

  log("Webex recording started successfully");
}

/**
 * Notify about the live transcript viewer URL.
 *
 * Delivery strategies (tried in order):
 * 1. Webhook callback to bot-manager (if configured) — most reliable
 * 2. Webex REST API direct message to meeting host (if hostEmail available)
 * 3. Log only (always happens as fallback)
 */
async function postViewerUrlToMeeting(_page: Page, viewerUrl: string, botConfig: BotConfig): Promise<void> {
  // Strategy 1: Webhook callback to bot-manager
  const callbackUrl = process.env.TRANSCRIPT_URL_CALLBACK || botConfig.data?.transcriptUrlCallback;
  if (callbackUrl) {
    try {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          event: 'transcript_room_created',
          viewerUrl,
          meetingId: botConfig.meeting_id,
          meetingUrl: botConfig.meetingUrl,
        }),
      });

      log(`[TranscriptRoom] Viewer URL sent via callback to ${callbackUrl}`);
      return;
    } catch (err: any) {
      log(`[TranscriptRoom] Callback failed: ${err.message}, trying next strategy`);
    }
  }

  // Strategy 2: Direct message to host via Webex REST API (Node.js native fetch)
  const hostEmail = botConfig.data?.hostEmail;
  const accessToken = botConfig.data?.access_token;
  if (hostEmail && accessToken) {
    try {
      const resp = await fetch('https://webexapis.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          toPersonEmail: hostEmail,
          text: `📝 Live transcript for your meeting is ready: ${viewerUrl}`,
          markdown: `📝 **Live Transcript** for your meeting is ready: [Open Viewer](${viewerUrl})\n\nShare this link with participants so they can follow along.`,
        }),
      });

      if (resp.ok) {
        log(`[TranscriptRoom] Viewer URL sent to host: ${hostEmail}`);
        return;
      }
    } catch (err: any) {
      log(`[TranscriptRoom] Webex message to host failed: ${err.message}`);
    }
  }

  // Strategy 3: Log only (always)
  log(`[TranscriptRoom] Viewer URL (share manually): ${viewerUrl}`);
}
