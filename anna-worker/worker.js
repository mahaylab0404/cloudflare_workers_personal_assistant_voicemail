/**
 * Cloudflare Worker: Anna personal assistant agent tools
 *
 * POST /check-availability  — returns free 30-min slots on Mahayla's calendar
 * POST /book-event          — creates a callback event on the calendar
 * POST /send-notification   — emails Mahayla after every call
 *
 * Secrets (Cloudflare dashboard → Worker → Settings → Variables → Secrets):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *
 * Vars (wrangler.toml):
 *   CALENDAR_ID        = admin@zuldeira.com
 *   NOTIFICATION_EMAIL = mahaylabalentine04@gmail.com
 */

const TOKEN_URL    = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GMAIL_API    = "https://www.googleapis.com/gmail/v1";

// ─── Auth ────────────────────────────────────────────────────────────────────

async function getAccessToken(env) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ─── Calendar helpers ────────────────────────────────────────────────────────

function getETHour(date) {
  return parseInt(
    date.toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }),
    10
  );
}

function getETDay(date) {
  const dayName = date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  });
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dayName);
}

function formatSlotDisplay(date) {
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month:   "long",
    day:     "numeric",
    hour:    "numeric",
    minute:  "2-digit",
    hour12:  true,
  }) + " ET";
}

// ─── /check-availability ─────────────────────────────────────────────────────

async function checkAvailability(env, body) {
  const token      = await getAccessToken(env);
  const calendarId = env.CALENDAR_ID || "admin@zuldeira.com";

  const now     = new Date();
  const minTime = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  let rangeStart = body.date_range_start ? new Date(body.date_range_start) : minTime;
  let rangeEnd   = body.date_range_end   ? new Date(body.date_range_end)   : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (rangeStart < minTime) rangeStart = minTime;

  const eventsUrl = new URL(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`
  );
  eventsUrl.searchParams.set("timeMin",      rangeStart.toISOString());
  eventsUrl.searchParams.set("timeMax",      rangeEnd.toISOString());
  eventsUrl.searchParams.set("singleEvents", "true");
  eventsUrl.searchParams.set("orderBy",      "startTime");

  const eventsRes  = await fetch(eventsUrl.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const eventsData = await eventsRes.json();

  if (!eventsRes.ok) {
    throw new Error(`Calendar API error: ${JSON.stringify(eventsData.error || eventsData)}`);
  }

  const busySlots = (eventsData.items || []).map((e) => ({
    start: e.start.dateTime || e.start.date,
    end:   e.end.dateTime   || e.end.date,
  }));

  const available = [];
  const current   = new Date(rangeStart);
  current.setMinutes(0, 0, 0);

  while (current < rangeEnd && available.length < 6) {
    const hour = getETHour(current);
    const day  = getETDay(current);

    if (day === 0 || day === 6 || hour < 9 || hour >= 17) {
      current.setTime(current.getTime() + 30 * 60 * 1000);
      continue;
    }

    if (current < minTime) {
      current.setTime(current.getTime() + 30 * 60 * 1000);
      continue;
    }

    const slotEnd   = new Date(current.getTime() + 30 * 60 * 1000);
    const conflicts = busySlots.some((busy) => {
      const s = new Date(busy.start);
      const e = new Date(busy.end);
      return current < e && slotEnd > s;
    });

    if (!conflicts) {
      available.push({
        start:   current.toISOString(),
        end:     slotEnd.toISOString(),
        display: formatSlotDisplay(current),
      });
    }

    current.setTime(current.getTime() + 30 * 60 * 1000);
  }

  return {
    available_slots: available,
    timezone: "America/New_York",
    message: available.length > 0
      ? `Found ${available.length} available slots`
      : "No availability found in the requested range",
  };
}

// ─── /book-event ─────────────────────────────────────────────────────────────

async function bookEvent(env, body) {
  const token      = await getAccessToken(env);
  const calendarId = env.CALENDAR_ID || "admin@zuldeira.com";

  // Normalize datetime — if no offset provided assume ET (-04:00 EDT / -05:00 EST)
  let datetimeStr = body.datetime || "";
  if (datetimeStr && !datetimeStr.includes("+") && !datetimeStr.match(/-\d{2}:\d{2}$/)) {
    datetimeStr = datetimeStr.replace("Z", "") + "-04:00";
  }

  const eventStart = new Date(datetimeStr);
  const now        = new Date();
  const minTime    = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  if (eventStart < minTime) {
    return { success: false, error: "Cannot book less than 24 hours in advance" };
  }

  const eventEnd = new Date(eventStart.getTime() + 30 * 60 * 1000);

  // Format datetime strings with ET offset for Google Calendar
  const formatET = (date) => {
    const iso = date.toISOString().replace("Z", "");
    return iso + "-04:00";
  };

  const event = {
    summary: `Callback: ${body.caller_name || "Unknown"}`,
    description: [
      `Caller: ${body.caller_name || "Unknown"}`,
      `Phone: ${body.caller_phone || "Not provided"}`,
      `Email: ${body.caller_email || "Not provided"}`,
      `Reason: ${body.reason || "Not specified"}`,
      "",
      "Booked by Anna (personal assistant agent)",
    ].join("\n"),
    start: { dateTime: formatET(eventStart), timeZone: "America/New_York" },
    end:   { dateTime: formatET(eventEnd),   timeZone: "America/New_York" },
    reminders: {
      useDefault: false,
      overrides:  [{ method: "popup", minutes: 30 }],
    },
  };

  const createRes = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );

  const created = await createRes.json();

  if (!createRes.ok) {
    throw new Error(`Failed to create event: ${JSON.stringify(created.error || created)}`);
  }

  return {
    success:  true,
    event_id: created.id,
    summary:  created.summary,
    start:    created.start.dateTime,
    end:      created.end.dateTime,
    message:  `Callback scheduled with ${body.caller_name} at ${formatSlotDisplay(eventStart)}`,
  };
}

// ─── /send-notification ──────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function buildEmail(to, subject, htmlBody) {
  const boundary = "boundary_anna_notify";
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    stripHtml(htmlBody),
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ].join("\r\n");

  return btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function formatNotificationEmail(body) {
  const urgencyColors = { high: "#e74c3c", medium: "#f39c12", low: "#27ae60" };
  const urgency       = (body.urgency || "medium").toLowerCase();
  const urgencyColor  = urgencyColors[urgency] || urgencyColors.medium;

  const scheduledRow = body.scheduled_callback
    ? `<tr>
        <td style="padding:8px 12px;font-weight:600;color:#555;">Callback Scheduled</td>
        <td style="padding:8px 12px;color:#2c3e50;">${body.scheduled_callback}</td>
      </tr>`
    : "";

  return `<!DOCTYPE html>
<html>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:20px;background:#f5f5f5;">
  <div style="max-width:500px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
    <div style="background:#1a1a2e;padding:20px 24px;">
      <h2 style="margin:0;color:white;font-size:18px;">Missed Call Summary</h2>
      <p style="margin:4px 0 0;color:#a0a0b0;font-size:13px;">from Anna</p>
    </div>
    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:8px 12px;font-weight:600;color:#555;">Caller</td>
          <td style="padding:8px 12px;color:#2c3e50;">${body.caller_name || "Unknown"}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:600;color:#555;">Phone</td>
          <td style="padding:8px 12px;color:#2c3e50;">${body.caller_phone || "Not provided"}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:600;color:#555;">Email</td>
          <td style="padding:8px 12px;color:#2c3e50;">${body.caller_email || "Not provided"}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:600;color:#555;">Reason</td>
          <td style="padding:8px 12px;color:#2c3e50;">${body.reason || "Not specified"}</td>
        </tr>
        <tr>
          <td style="padding:8px 12px;font-weight:600;color:#555;">Urgency</td>
          <td style="padding:8px 12px;">
            <span style="background:${urgencyColor};color:white;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;text-transform:uppercase;">${urgency}</span>
          </td>
        </tr>
        ${scheduledRow}
      </table>
    </div>
  </div>
</body>
</html>`;
}

async function sendNotification(env, body) {
  const token      = await getAccessToken(env);
  const to         = env.NOTIFICATION_EMAIL || "mahaylabalentine04@gmail.com";
  const callerName = body.caller_name || "Unknown caller";
  const urgency    = (body.urgency || "medium").toLowerCase();
  const subject    = `${urgency === "high" ? "[URGENT] " : ""}Missed call from ${callerName}`;

  const htmlBody   = formatNotificationEmail(body);
  const rawMessage = buildEmail(to, subject, htmlBody);

  const sendRes = await fetch(`${GMAIL_API}/users/me/messages/send`, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: rawMessage }),
  });

  const result = await sendRes.json();

  if (!sendRes.ok) {
    throw new Error(`Gmail send failed: ${JSON.stringify(result.error || result)}`);
  }

  return {
    success:    true,
    message_id: result.id,
    message:    `Notification sent to ${to}`,
  };
}

// ─── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const url  = new URL(request.url);
    const body = await request.json();

    try {
      let result;
      if (url.pathname === "/check-availability") {
        result = await checkAvailability(env, body);
      } else if (url.pathname === "/book-event") {
        result = await bookEvent(env, body);
      } else if (url.pathname === "/send-notification") {
        result = await sendNotification(env, body);
      } else {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      return Response.json(result, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    } catch (err) {
      return Response.json(
        { error: err.message || "Internal error" },
        { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
  },
};
