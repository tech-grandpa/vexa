import { Page } from "playwright";
import { log } from "../../utils";

export function startWebexRemovalMonitor(
  page: Page,
  onRemoval?: () => void | Promise<void>
): () => void {
  log("Starting Webex removal monitor...");

  let shouldStop = false;

  // Start monitoring loop
  const monitorLoop = async () => {
    while (!shouldStop) {
      await page.waitForTimeout(1000);

      try {
        const status = await page.evaluate(() => window.__WEBEX_STATUS);

        // Check if bot was removed
        if (status.removed) {
          log(
            `Bot was removed from Webex meeting (reason: ${status.removalReason || "unknown"})`
          );
          if (onRemoval) {
            await onRemoval();
          }
          break;
        }

        // Check if meeting ended
        if (status.ended) {
          log("Webex meeting ended by host");
          if (onRemoval) {
            await onRemoval();
          }
          break;
        }

        // Check for errors
        if (status.error) {
          log(`Webex error detected: ${status.error}`);
          if (onRemoval) {
            await onRemoval();
          }
          break;
        }
      } catch (err: any) {
        log(`Error in removal monitor: ${err.message}`);
        // Continue monitoring even if we hit an error
      }
    }

    log("Webex removal monitor stopped");
  };

  // Start the monitoring loop
  monitorLoop().catch((err) => {
    log(`Fatal error in removal monitor: ${err.message}`);
  });

  // Return cleanup function
  return () => {
    log("Stopping Webex removal monitor...");
    shouldStop = true;
  };
}
