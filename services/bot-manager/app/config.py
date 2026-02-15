import os
import logging

logger = logging.getLogger("bot_manager.config")

REDIS_URL = os.environ.get("REDIS_URL")
if not REDIS_URL:
    raise ValueError("Missing required environment variable: REDIS_URL")

# Bot configuration
BOT_IMAGE_NAME = os.environ.get("BOT_IMAGE_NAME", "vexa-bot:latest")
DOCKER_NETWORK = os.environ.get("DOCKER_NETWORK", "vexa_default")

# Lock settings
LOCK_TIMEOUT_SECONDS = 300 # 5 minutes
LOCK_PREFIX = "bot_lock:"
MAP_PREFIX = "bot_map:"
STATUS_PREFIX = "bot_status:"

# --- Webex Org Restriction ---
# Bot token for Webex API calls (used to determine home org and validate requests).
# When set, the bot's org is fetched at startup and used to restrict access.
# When unset, org restriction is disabled (open access).
WEBEX_BOT_TOKEN = os.environ.get("WEBEX_BOT_TOKEN", "").strip()

# Resolved at startup by fetching /v1/people/me with the bot token.
# None means org restriction is disabled.
WEBEX_BOT_ORG_ID: str | None = None

def resolve_bot_org_id() -> str | None:
    """Fetch the bot's org ID from the Webex API (called once at startup)."""
    global WEBEX_BOT_ORG_ID
    if not WEBEX_BOT_TOKEN:
        logger.info("WEBEX_BOT_TOKEN not set — org restriction disabled (open access).")
        return None
    import httpx
    try:
        resp = httpx.get(
            "https://webexapis.com/v1/people/me",
            headers={"Authorization": f"Bearer {WEBEX_BOT_TOKEN}"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        WEBEX_BOT_ORG_ID = data.get("orgId")
        logger.info(f"Webex org restriction enabled. Bot org ID: {WEBEX_BOT_ORG_ID}")
        return WEBEX_BOT_ORG_ID
    except Exception as e:
        logger.error(f"Failed to resolve Webex bot org ID: {e}. Org restriction disabled.")
        WEBEX_BOT_ORG_ID = None
        return None 