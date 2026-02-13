import { Page } from "playwright";
import { log } from "../../utils";
import { BotConfig } from "../../types";
import { WhisperLiveService } from "../../services/whisperlive";
import { ensureBrowserUtils } from "../../utils/injection";

export async function startWebexRecording(
  page: Page,
  botConfig: BotConfig
): Promise<void> {
  // Initialize WhisperLive service on Node.js side
  const whisperLiveService = new WhisperLiveService({
    whisperLiveUrl: process.env.WHISPER_LIVE_URL,
  });

  // Initialize WhisperLive connection with STUBBORN reconnection
  const whisperLiveUrl =
    await whisperLiveService.initializeWithStubbornReconnection("Webex");

  log(`[Node.js] Using WhisperLive URL for Webex: ${whisperLiveUrl}`);
  log("Starting Webex recording with WebSocket connection");

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

            const status = window.__WEBEX_STATUS;
            if (status.audioReady && window.__WEBEX_AUDIO_STREAM) {
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

          const audioStream = window.__WEBEX_AUDIO_STREAM;
          if (!audioStream) {
            throw new Error("No audio stream available");
          }

          // Set up callbacks
          (window as any).__vexaOnMessage = (data: any) => {
            try {
              audioService.processTranscription(
                data,
                whisperLiveService,
                (window as any).__vexaBotConfig
              );
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

          resolve();
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
