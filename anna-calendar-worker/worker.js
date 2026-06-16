/**
 * Cloudflare Worker: Google Calendar integration for Anna agent.
 *
 * POST /check-availability — returns free 30-min slots in business hours (ET)
 * POST /book-event        — creates a calendar event
 *
 * Secrets (set via: wrangler secret put <NAME>):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *
 * Vars (wrangler.toml):
 *   CALENDAR_ID  (default: admin@zuldeira.com)
 */

const TOKEN_URL   = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

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

// Returns the hour (0-23) in America/New_York for a given Date object.
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

// Returns the day of week (0=Sun … 6=Sat) in America/New_York.
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

async function checkAvailability(env, body) {
  const token     = await getAccessToken(env);
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

    // Skip weekends and outside 9am–5pm ET
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

async function bookEvent(env, body) {
  const token      = await getAccessToken(env);
  const calendarId = env.CALENDAR_ID || "admin@zuldeira.com";

  const eventStart = new Date(body.datetime);
  const now        = new Date();
  const minTime    = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  if (eventStart < minTime) {
    return { success: false, error: "Cannot book less than 24 hours in advance" };
  }

  const eventEnd = new Date(eventStart.getTime() + 30 * 60 * 1000);

  const event = {
    summary: `Callback: ${body.caller_name || "Unknown"}`,
    description: [
      `Caller: ${body.caller_name || "Unknown"}`,
      `Phone: ${body.caller_phone || "Not provided"}`,
      `Reason: ${body.reason || "Not specified"}`,
      "",
      "Booked by Anna (personal assistant agent)",
    ].join("\n"),
    start: { dateTime: eventStart.toISOString(), timeZone: "America/New_York" },
    end:   { dateTime: eventEnd.toISOString(),   timeZone: "America/New_York" },
    reminders: {
      useDefault: false,
      overrides:  [{ method: "popup", minutes: 30 }],
    },
  };

  const createUrl = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

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
