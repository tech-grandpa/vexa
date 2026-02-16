#!/usr/bin/env python3
"""
Register or update Webex webhooks for the Vexa bot.

Usage:
    export WEBEX_BOT_TOKEN=<your-bot-token>
    export WEBEX_WEBHOOK_SECRET=<your-webhook-secret>
    python scripts/register_webex_webhook.py https://your-domain.com/webhooks/webex

Options:
    --list      List existing webhooks
    --clean     Delete all existing webhooks before registering
"""

import argparse
import os
import sys

import requests

WEBEX_API = "https://webexapis.com/v1"

WEBHOOKS_TO_REGISTER = [
    {"name": "Vexa Bot - Memberships", "resource": "memberships", "event": "created"},
    {"name": "Vexa Bot - Messages", "resource": "messages", "event": "created"},
]


def get_headers():
    token = os.getenv("WEBEX_BOT_TOKEN")
    if not token:
        print("Error: WEBEX_BOT_TOKEN environment variable not set", file=sys.stderr)
        sys.exit(1)
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def list_webhooks():
    resp = requests.get(f"{WEBEX_API}/webhooks", headers=get_headers())
    resp.raise_for_status()
    webhooks = resp.json().get("items", [])
    if not webhooks:
        print("No webhooks registered.")
        return webhooks
    print(f"\n{'ID':<40} {'Name':<30} {'Resource':<15} {'Event':<10} {'Target URL'}")
    print("-" * 130)
    for wh in webhooks:
        print(f"{wh['id']:<40} {wh['name']:<30} {wh['resource']:<15} {wh['event']:<10} {wh['targetUrl']}")
    print()
    return webhooks


def delete_webhook(webhook_id: str):
    resp = requests.delete(f"{WEBEX_API}/webhooks/{webhook_id}", headers=get_headers())
    resp.raise_for_status()
    print(f"  Deleted webhook {webhook_id}")


def create_webhook(name: str, target_url: str, resource: str, event: str, secret: str = None):
    payload = {
        "name": name,
        "targetUrl": target_url,
        "resource": resource,
        "event": event,
    }
    if secret:
        payload["secret"] = secret
    resp = requests.post(f"{WEBEX_API}/webhooks", headers=get_headers(), json=payload)
    resp.raise_for_status()
    wh = resp.json()
    print(f"  Created: {wh['name']} ({wh['resource']}:{wh['event']}) -> {wh['targetUrl']}")
    return wh


def main():
    parser = argparse.ArgumentParser(description="Register Webex webhooks for Vexa bot")
    parser.add_argument("target_url", nargs="?", help="Public URL for webhook endpoint (e.g. https://api.vexa.ai/webhooks/webex)")
    parser.add_argument("--list", action="store_true", help="List existing webhooks")
    parser.add_argument("--clean", action="store_true", help="Delete all existing webhooks before registering")
    args = parser.parse_args()

    if args.list:
        list_webhooks()
        return

    if not args.target_url:
        parser.error("target_url is required (unless using --list)")

    secret = os.getenv("WEBEX_WEBHOOK_SECRET")
    if not secret:
        print("Warning: WEBEX_WEBHOOK_SECRET not set. Webhooks will be created without signature validation.", file=sys.stderr)

    # List existing
    existing = list_webhooks()

    if args.clean and existing:
        print("Cleaning existing webhooks...")
        for wh in existing:
            delete_webhook(wh["id"])
        print()

    # Register new webhooks
    print("Registering webhooks...")
    for wh_config in WEBHOOKS_TO_REGISTER:
        # Check if already exists with same target
        already = any(
            e["resource"] == wh_config["resource"]
            and e["event"] == wh_config["event"]
            and e["targetUrl"] == args.target_url
            for e in existing
        ) if not args.clean else False

        if already:
            print(f"  Skipping {wh_config['name']} (already registered)")
            continue

        create_webhook(
            name=wh_config["name"],
            target_url=args.target_url,
            resource=wh_config["resource"],
            event=wh_config["event"],
            secret=secret,
        )

    print("\nDone! Webhooks registered.")
    print("\nVerifying...")
    list_webhooks()


if __name__ == "__main__":
    main()
