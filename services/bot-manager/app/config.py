import os

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

# Org restriction: comma-separated list of allowed Webex org IDs.
# When empty or unset, all orgs are allowed (open access).
# When set, only users belonging to listed orgs can launch bots.
# Example: "Y2lzY29zcGFyazovL3VzL09SR0FOSVpBVElPTi8xMjM0"
_raw_allowed_orgs = os.environ.get("ALLOWED_ORG_IDS", "").strip()
ALLOWED_ORG_IDS: list[str] = [
    org.strip() for org in _raw_allowed_orgs.split(",") if org.strip()
] if _raw_allowed_orgs else [] 