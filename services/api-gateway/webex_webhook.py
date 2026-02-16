"""
Webex Webhook processing logic for auto-joining meetings when the bot is invited.
"""

import hashlib
import hmac
import json
import logging
import os
import re
from typing import Optional

import httpx
from fastapi import APIRouter, Request, HTTPException, Response

logger = logging.getLogger("vexa.webhook.webex")

router = APIRouter(prefix="/webhooks", tags=["Webhooks"])

WEBEX_API_BASE = "https://webexapis.com/v1"
BOT_EMAIL = os.getenv("WEBEX_BOT_EMAIL", "scribe-bot@webex.bot")

# Regex patterns for Webex meeting links
MEETING_LINK_PATTERNS = [
    re.compile(r"https?://[\w.-]+\.webex\.com/[\w.-]+/j\.php\?MTID=\w+", re.IGNORECASE),
    re.compile(r"https?://[\w.-]+\.webex\.com/meet/[\w.-]+", re.IGNORECASE),
    re.compile(r"https?://[\w.-]+\.webex\.com/\w+/j\.php\?MTID=\w+", re.IGNORECASE),
]

# SIP URI pattern (e.g., meetingnumber@webex.com)
SIP_PATTERN = re.compile(r"\b(\d{9,11}@[\w.-]+\.webex\.com)\b", re.IGNORECASE)

# Meeting number pattern (9-11 digits)
MEETING_NUMBER_PATTERN = re.compile(r"\b(\d{9,11})\b")


def _get_webhook_secret() -> Optional[str]:
    return os.getenv("WEBEX_WEBHOOK_SECRET")


def _get_bot_token() -> str:
    token = os.getenv("WEBEX_BOT_TOKEN")
    if not token:
        raise RuntimeError("WEBEX_BOT_TOKEN not configured")
    return token


def _get_bot_manager_url() -> str:
    url = os.getenv("BOT_MANAGER_URL")
    if not url:
        raise RuntimeError("BOT_MANAGER_URL not configured")
    return url


def verify_webhook_signature(body: bytes, signature: str, secret: str) -> bool:
    """Verify Webex webhook HMAC-SHA1 signature."""
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha1).hexdigest()
    return hmac.compare_digest(expected, signature)


async def _webex_api_get(path: str, token: str) -> dict:
    """Make a GET request to Webex API."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{WEBEX_API_BASE}{path}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10.0,
        )
        resp.raise_for_status()
        return resp.json()


async def _webex_api_post(path: str, token: str, data: dict) -> dict:
    """Make a POST request to Webex API."""
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{WEBEX_API_BASE}{path}",
            headers={"Authorization": f"Bearer {token}"},
            json=data,
            timeout=10.0,
        )
        resp.raise_for_status()
        return resp.json()


async def _launch_bot(meeting_url: str, bot_token: str) -> dict:
    """Call bot-manager to launch a bot for the given meeting."""
    bot_manager_url = _get_bot_manager_url()
    payload = {
        "platform": "webex",
        "native_meeting_id": meeting_url,
        "bot_name": "Vexa Scribe",
        "access_token": bot_token,
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{bot_manager_url}/bots",
            json=payload,
            timeout=30.0,
        )
        if resp.status_code in (200, 201):
            logger.info(f"Bot launched for meeting: {meeting_url}")
            return resp.json()
        else:
            logger.error(f"Bot launch failed ({resp.status_code}): {resp.text}")
            raise HTTPException(status_code=502, detail=f"Bot manager error: {resp.text}")


async def _send_welcome_message(room_id: str, token: str):
    """Send a welcome message to a Webex space."""
    message = (
        "👋 Hi! I'm **Vexa Scribe Bot** — I join meetings and transcribe them automatically.\n\n"
        "**How to use me:**\n"
        "1. **Invite me to a meeting** — just add me as a participant and I'll join automatically\n"
        "2. **Send me a meeting link** — paste a Webex meeting URL here and I'll join\n\n"
        "I'll transcribe the meeting and you can access the transcript via the Vexa API."
    )
    try:
        await _webex_api_post("/messages", token, {
            "roomId": room_id,
            "markdown": message,
        })
        logger.info(f"Sent welcome message to room {room_id}")
    except Exception as e:
        logger.error(f"Failed to send welcome message: {e}")


def _extract_meeting_link(text: str) -> Optional[str]:
    """Extract a Webex meeting link from text."""
    for pattern in MEETING_LINK_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(0)
    sip_match = SIP_PATTERN.search(text)
    if sip_match:
        return sip_match.group(1)
    return None


async def _handle_membership_created(data: dict, bot_token: str):
    """Handle memberships:created event — bot was added to a space or meeting."""
    membership_id = data.get("id")
    if not membership_id:
        logger.warning("Membership event missing id")
        return

    # Fetch full membership details
    try:
        membership = await _webex_api_get(f"/memberships/{membership_id}", bot_token)
    except Exception as e:
        logger.error(f"Failed to fetch membership {membership_id}: {e}")
        return

    person_email = membership.get("personEmail", "")
    room_id = membership.get("roomId", "")

    # Only act if the bot itself was added
    if person_email.lower() != BOT_EMAIL.lower():
        logger.debug(f"Membership event not for bot ({person_email}), ignoring")
        return

    logger.info(f"Bot added to room {room_id}")

    # Fetch room details to check type
    try:
        room = await _webex_api_get(f"/rooms/{room_id}", bot_token)
    except Exception as e:
        logger.error(f"Failed to fetch room {room_id}: {e}")
        return

    room_type = room.get("type", "")
    meeting_link = room.get("sipAddress") or room.get("meetingLink")

    if room_type == "direct":
        # 1:1 space — send welcome
        await _send_welcome_message(room_id, bot_token)
    elif meeting_link:
        # Has a meeting link — join it
        await _launch_bot(meeting_link, bot_token)
    else:
        # Group space without obvious meeting — send welcome
        await _send_welcome_message(room_id, bot_token)


async def _handle_message_created(data: dict, bot_token: str):
    """Handle messages:created event — look for meeting links in 1:1 messages."""
    message_id = data.get("id")
    if not message_id:
        return

    # Fetch full message
    try:
        message = await _webex_api_get(f"/messages/{message_id}", bot_token)
    except Exception as e:
        logger.error(f"Failed to fetch message {message_id}: {e}")
        return

    # Ignore messages from the bot itself
    person_email = message.get("personEmail", "")
    if person_email.lower() == BOT_EMAIL.lower():
        return

    room_type = message.get("roomType", "")
    text = message.get("text", "") or message.get("html", "")

    if not text:
        return

    meeting_link = _extract_meeting_link(text)

    if meeting_link:
        logger.info(f"Meeting link found in message: {meeting_link}")
        room_id = message.get("roomId", "")
        try:
            await _launch_bot(meeting_link, bot_token)
            # Confirm to user
            await _webex_api_post("/messages", bot_token, {
                "roomId": room_id,
                "markdown": f"✅ Joining meeting: `{meeting_link}`\n\nI'll start transcribing once I'm in.",
            })
        except Exception as e:
            logger.error(f"Failed to launch bot for link {meeting_link}: {e}")
            try:
                await _webex_api_post("/messages", bot_token, {
                    "roomId": room_id,
                    "markdown": f"❌ Sorry, I couldn't join that meeting. Error: {e}",
                })
            except Exception:
                pass
    elif room_type == "direct":
        # 1:1 but no link found
        room_id = message.get("roomId", "")
        try:
            await _webex_api_post("/messages", bot_token, {
                "roomId": room_id,
                "markdown": (
                    "I didn't find a meeting link in your message. "
                    "Please send me a Webex meeting URL and I'll join to transcribe it."
                ),
            })
        except Exception:
            pass


@router.post("/webex", summary="Webex webhook receiver", description="Receives Webex webhook events. No API key required — validated via webhook secret.")
async def webex_webhook(request: Request):
    """Process incoming Webex webhook events."""
    body = await request.body()

    # Validate webhook signature if secret is configured
    secret = _get_webhook_secret()
    if secret:
        signature = request.headers.get("x-spark-signature", "")
        if not signature:
            logger.warning("Webhook request missing x-spark-signature header")
            raise HTTPException(status_code=401, detail="Missing signature")
        if not verify_webhook_signature(body, signature, secret):
            logger.warning("Webhook signature verification failed")
            raise HTTPException(status_code=401, detail="Invalid signature")

    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    resource = payload.get("resource")
    event = payload.get("event")
    data = payload.get("data", {})

    logger.info(f"Webhook received: {resource}:{event}")

    try:
        bot_token = _get_bot_token()
    except RuntimeError as e:
        logger.error(str(e))
        raise HTTPException(status_code=500, detail="Bot not configured")

    if resource == "memberships" and event == "created":
        await _handle_membership_created(data, bot_token)
    elif resource == "messages" and event == "created":
        await _handle_message_created(data, bot_token)
    else:
        logger.debug(f"Unhandled webhook event: {resource}:{event}")

    # Always return 200 to Webex to acknowledge receipt
    return Response(status_code=200)
