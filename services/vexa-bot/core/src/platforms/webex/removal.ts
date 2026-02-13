import { Page } from "playwright";
import { log } from "../../utils";

export function startWebexRemovalMonitor(
  page: Page,
  onRemoval?: () => void | Promise<void>
): () => void {
  log("Starting periodic Webex removal monitoring...");
  let removalDetected = false;

  const removalCheckInterval = setInterval(async () => {
    try {
      const status = await page.evaluate(() => (window as any).__WEBEX_STATUS);

      // Check if bot was removed
      if (status.removed && !removalDetected) {
        removalDetected = true;
        log(
          `🚨 Bot was removed from Webex meeting (reason: ${status.removalReason || "unknown"})`
        );
        clearInterval(removalCheckInterval);
        try { await onRemoval?.(); } catch {}
        return;
      }

      // Check if meeting ended
      if (status.ended && !removalDetected) {
        removalDetected = true;
        log("🚨 Webex meeting ended by host");
        clearInterval(removalCheckInterval);
        try { await onRemoval?.(); } catch {}
        return;
      }

      // Check for errors that indicate disconnection
      if (status.error && !removalDetected) {
        removalDetected = true;
        log(`🚨 Webex error detected during removal monitoring: ${status.error}`);
        clearInterval(removalCheckInterval);
        try { await onRemoval?.(); } catch {}
        return;
      }
    } catch (err: any) {
      log(`Error during Webex removal check: ${err.message}`);
      // Continue monitoring even if we hit an error
    }
  }, 1500);

  // Return cleanup function
  return () => {
    clearInterval(removalCheckInterval);
  };
}
