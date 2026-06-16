"""
Wire Anna's three webhook tools into the ElevenLabs agent.

Run AFTER deploying both Cloudflare Workers:
    python update-agent-tools.py

You will be prompted for your Cloudflare Workers subdomain (the part before .workers.dev).
"""

import json
import urllib.request

AGENT_ID     = "agent_1001kv76d3gbfhctn4pjq20y1b0y"
ELEVENLABS_KEY = "sk_40964e12f2176d219967ce19be5b73e0894231cf50f4f746"

def patch_agent(payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req  = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/convai/agents/{AGENT_ID}",
        data=data,
        method="PATCH",
        headers={
            "xi-api-key":    ELEVENLABS_KEY,
            "Content-Type":  "application/json",
        },
    )
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())


def main():
    subdomain = input("Enter your Cloudflare Workers subdomain (e.g. 'myname' if workers are at myname.workers.dev): ").strip()

    cal_base  = f"https://anna-calendar-worker.{subdomain}.workers.dev"
    notif_url = f"https://anna-notification-worker.{subdomain}.workers.dev/send-notification"

    tools = [
        {
            "type": "webhook",
            "name": "check_calendar_availability",
            "description": (
                "Check Mahayla's Google Calendar for available callback slots. "
                "Returns free 30-minute slots within the next 7 days, at least 24 hours from now. "
                "Use when the caller wants to schedule a callback."
            ),
            "api_schema": {
                "url":    f"{cal_base}/check-availability",
                "method": "POST",
                "request_body_schema": {
                    "type": "object",
                    "properties": {
                        "date_range_start": {
                            "type":        "string",
                            "description": "ISO date string for start of range to check. Optional — defaults to 24 hours from now.",
                        },
                        "date_range_end": {
                            "type":        "string",
                            "description": "ISO date string for end of range. Optional — defaults to 7 days from now.",
                        },
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "webhook",
            "name": "book_calendar_event",
            "description": (
                "Book a callback appointment on Mahayla's calendar. "
                "Use after the caller has chosen a specific time slot from the available options."
            ),
            "api_schema": {
                "url":    f"{cal_base}/book-event",
                "method": "POST",
                "request_body_schema": {
                    "type": "object",
                    "properties": {
                        "caller_name": {
                            "type":        "string",
                            "description": "The caller's name.",
                        },
                        "caller_phone": {
                            "type":        "string",
                            "description": "The caller's phone number.",
                        },
                        "caller_email": {
                            "type":        "string",
                            "description": "The caller's email address, if provided.",
                        },
                        "reason": {
                            "type":        "string",
                            "description": "Brief reason for the callback.",
                        },
                        "datetime": {
                            "type":        "string",
                            "description": "ISO datetime string for the chosen slot.",
                        },
                    },
                    "required": ["caller_name", "datetime"],
                },
            },
        },
        {
            "type": "webhook",
            "name": "send_notification",
            "description": (
                "Send Mahayla an email notification about this call. "
                "Use at the END of every call to let Mahayla know who called and why."
            ),
            "api_schema": {
                "url":    notif_url,
                "method": "POST",
                "request_body_schema": {
                    "type": "object",
                    "properties": {
                        "caller_name": {
                            "type":        "string",
                            "description": "The caller's name, or 'Unknown' if not provided.",
                        },
                        "caller_phone": {
                            "type":        "string",
                            "description": "The caller's phone number.",
                        },
                        "caller_email": {
                            "type":        "string",
                            "description": "The caller's email address, if they provided one.",
                        },
                        "reason": {
                            "type":        "string",
                            "description": "Why they called — brief summary.",
                        },
                        "urgency": {
                            "type":        "string",
                            "enum":        ["high", "medium", "low"],
                            "description": (
                                "How urgent the call is. "
                                "high: time-sensitive, could cost money or damage a relationship if not handled today. "
                                "medium: needs attention within a day or two but not an emergency. "
                                "low: general inquiry, no time pressure, can wait days or longer."
                            ),
                        },
                        "scheduled_callback": {
                            "type":        "string",
                            "description": "The scheduled callback time if one was booked, or null if not.",
                        },
                    },
                    "required": ["caller_name", "reason", "urgency"],
                },
            },
        },
    ]

    print(f"\nPatching agent {AGENT_ID} with 3 tools...")
    result = patch_agent({
        "conversation_config": {
            "agent": {
                "prompt": {
                    "tools": tools,
                }
            }
        }
    })

    updated_tools = (
        result.get("conversation_config", {})
              .get("agent", {})
              .get("prompt", {})
              .get("tools", [])
    )

    print(f"Done. Agent now has {len(updated_tools)} tool(s).")
    for t in updated_tools:
        print(f"  - {t.get('name')}")


if __name__ == "__main__":
    main()
