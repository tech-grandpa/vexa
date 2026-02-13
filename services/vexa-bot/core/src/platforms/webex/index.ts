import { Page } from "playwright";
import { BotConfig } from "../../types";
import { runMeetingFlow, PlatformStrategies } from "../shared/meetingFlow";

// Import modular functions
import { joinWebexMeeting } from "./join";
import {
  waitForWebexAdmission,
  checkForWebexAdmissionSilent,
} from "./admission";
import { startWebexRecording } from "./recording";
import { prepareForWebexRecording, leaveWebex } from "./leave";
import { startWebexRemovalMonitor } from "./removal";
import { log } from "../../utils";

// --- Webex Main Handler ---

export async function handleWebex(
  botConfig: BotConfig,
  page: Page,
  gracefulLeaveFunction: (
    page: Page | null,
    exitCode: number,
    reason: string,
    errorDetails?: any
  ) => Promise<void>
): Promise<void> {
  // Validate credentials
  if (!botConfig.data?.access_token) {
    log("Error: Webex platform requires access_token in botConfig.data");
    await gracefulLeaveFunction(page, 1, "missing_webex_credentials");
    return;
  }

  const strategies: PlatformStrategies = {
    join: async (page: Page, botConfig: BotConfig) => {
      await joinWebexMeeting(
        page,
        botConfig.meetingUrl!,
        botConfig.botName,
        botConfig
      );
    },
    waitForAdmission: waitForWebexAdmission,
    checkAdmissionSilent: checkForWebexAdmissionSilent,
    prepare: prepareForWebexRecording,
    startRecording: startWebexRecording,
    startRemovalMonitor: startWebexRemovalMonitor,
    leave: leaveWebex,
  };

  await runMeetingFlow(
    "webex",
    botConfig,
    page,
    gracefulLeaveFunction,
    strategies
  );
}

// Export the leave function for external use
export { leaveWebex };
