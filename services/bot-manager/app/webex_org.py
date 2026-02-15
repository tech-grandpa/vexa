"""Webex org restriction: validate that a Webex access token belongs to the bot's org."""

import logging
import httpx
from .config import WEBEX_BOT_ORG_ID, WEBEX_BOT_TOKEN

logger = logging.getLogger("bot_manager.webex_org")

WEBEX_API_BASE = "https://webexapis.com/v1"


async def validate_org(access_token: str) -> tuple[bool, str]:
    """
    Check if the given Webex access token belongs to the same org as the bot.
    
    Returns:
        (allowed, reason) — allowed=True if access is permitted.
    """
    if not WEBEX_BOT_ORG_ID:
        # Org restriction not configured — allow all
        return True, "org restriction disabled"

    if not access_token:
        return False, "No access_token provided; cannot verify org membership."

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Use the provided access token to identify the requester
            resp = await client.get(
                f"{WEBEX_API_BASE}/people/me",
                headers={"Authorization": f"Bearer {access_token}"},
            )

            if resp.status_code == 401:
                return False, "Invalid or expired Webex access token."

            resp.raise_for_status()
            data = resp.json()
            requester_org = data.get("orgId", "")
            requester_email = data.get("emails", ["unknown"])[0]

            if requester_org == WEBEX_BOT_ORG_ID:
                logger.info(f"Org check passed: {requester_email} (org {requester_org})")
                return True, "ok"
            else:
                logger.warning(
                    f"Org check FAILED: {requester_email} org={requester_org} "
                    f"!= bot org={WEBEX_BOT_ORG_ID}"
                )
                return False, (
                    f"Access denied: your Webex organization does not match. "
                    f"This bot is restricted to its home organization."
                )

    except httpx.HTTPStatusError as e:
        logger.error(f"Webex API error during org check: {e}")
        return False, f"Failed to verify org membership: Webex API returned {e.response.status_code}"
    except Exception as e:
        logger.error(f"Unexpected error during org check: {e}")
        return False, f"Failed to verify org membership: {e}"
