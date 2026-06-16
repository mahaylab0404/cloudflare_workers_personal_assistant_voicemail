/**
 * Cloudflare Worker: Email notification for Anna agent.
 *
 * POST /send-notification — emails Mahayla after every call
 *
 * Secrets (set via: wrangler secret put <NAME>):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN
 *
 * Vars (wrangler.toml):
 *   NOTIFICATION_EMAIL  (default: mahaylabalentine04@gmail.com)
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://www.googleapis.com/gmail/v1";

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
  const urgency      = (body.urgency || "medium").toLowerCase();
  const urgencyColor = urgencyColors[urgency] || urgencyColors.medium;

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

  const htmlBody    = formatNotificationEmail(body);
  const rawMessage  = buildEmail(to, subject, htmlBody);

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

    const url = new URL(request.url);
    if (url.pathname !== "/send-notification") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    try {
      const body   = await request.json();
      const result = await sendNotification(env, body);
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
