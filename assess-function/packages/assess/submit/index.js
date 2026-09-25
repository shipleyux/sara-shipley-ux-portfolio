/**
 * DigitalOcean Function: assess/submit
 * -------------------------------------
 * Client-facing intake endpoint. The client never sees this is AI-assisted -
 * they just submit name/email/website and get a "thanks, you'll hear from
 * us" response. Behind the scenes this:
 *   1. Runs the same lightweight draft-assessment logic as assess/draft
 *      (fetch HTML, extract structure, ask Claude for 5 prioritised fixes).
 *   2. Emails the client's details + the AI draft to Sara (never to the
 *      client) via Brevo, so she can review, check the site herself, amend,
 *      and send the finished report on through her own process.
 *
 * Expects a POST with JSON body: { name, email, url, tier }
 *   - name, email, url: required, client-supplied
 *   - tier: optional free text (e.g. "standard" / "express"), just passed
 *     through into the notification email
 *
 * Always returns a generic success/failure shape to the client - never the
 * draft itself, never any AI-specific wording.
 */

const MODEL = process.env.ASSESS_MODEL || "claude-sonnet-5";
const NOTIFY_TO = process.env.NOTIFY_EMAIL || "shipley.ux@gmail.com";
const NOTIFY_FROM = process.env.NOTIFY_FROM_EMAIL || "onboarding@resend.dev";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function normalizeUrl(input) {
  let candidate = String(input || "").trim();
  if (!candidate) throw new Error("No website URL provided.");
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    return new URL(candidate).toString();
  } catch {
    throw new Error(`"${input}" doesn't look like a valid website address.`);
  }
}

async function fetchHtml(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      throw new Error(`Site responded with ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractStructure(html) {
  const stripTags = (s) =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&mdash;/g, "-")
      .replace(/&ndash;/g, "-")
      .replace(/&pound;/g, "GBP ")
      .replace(/\s+/g, " ")
      .trim();

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : null;

  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
  const metaDescription = descMatch ? stripTags(descMatch[1]) : null;

  const hasViewportMeta = /<meta[^>]+name=["']viewport["']/i.test(html);
  const forms = (html.match(/<form[\s>]/gi) || []).length;

  const headings = [];
  const headingRe = /<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi;
  let hm;
  while ((hm = headingRe.exec(html)) && headings.length < 30) {
    const text = stripTags(hm[2]);
    if (text) headings.push({ tag: hm[1].toLowerCase(), text });
  }

  const ctaSet = new Set();
  const ctaRe = /<(a|button)[^>]*>([\s\S]*?)<\/\1>/gi;
  let cm;
  while ((cm = ctaRe.exec(html)) && ctaSet.size < 30) {
    const text = stripTags(cm[2]);
    if (text && text.length > 0 && text.length < 60) ctaSet.add(text);
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyText = stripTags(bodyMatch ? bodyMatch[1] : html);
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

  return {
    title,
    metaDescription,
    headings,
    ctas: [...ctaSet],
    hasViewportMeta,
    forms,
    wordCount,
  };
}

function buildPrompt(url, structure) {
  return `You are drafting a "Quick-Win Snapshot" for a UX consultant, Sara Shipley (shipleyux.com), who reviews and edits every draft before it goes to the client. Your output is an internal working draft, not a finished deliverable - write it as if Sara will tighten it, not as final client-ready copy.

Format (Sara's standard Quick-Win Snapshot deliverable):
- Scope: ONE page - here, the page at ${url}
- Exactly 5 concrete, prioritised fixes, ranked by impact vs effort (most important first)
- Each fix: a one-line problem statement, then a one-line concrete recommendation
- Plain language, no jargon, written for a small business owner - not a developer
- Base every point on the actual page structure below. Do not invent generic advice ("improve your SEO", "add more content") that isn't grounded in what's given. If something would normally need a visual check (layout, spacing, colour contrast, whether something is above the fold) and you can't see the page, say so explicitly rather than guessing - this data is text/structure only, no screenshot.

Page structure extracted automatically (no screenshot available - text/HTML structure only):
${JSON.stringify(structure, null, 2)}

Write the 5 fixes now, numbered 1-5.`;
}

async function draftAssessment(url, structure) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set on this function.");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: buildPrompt(url, structure) }],
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Anthropic API returned ${res.status}`);
  }

  const draftText = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { draftText, usage: data.usage };
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendNotificationEmail({ name, email, tier, url, draftText, draftError }) {
  const brevoKey = process.env.BREVO_API_KEY;
  if (!brevoKey) {
    throw new Error("BREVO_API_KEY is not set on this function.");
  }

  const subject = `New Quick-Win Snapshot request: ${name} (${url})`;

  const bodyHtml = `
    <h2>New Quick-Win Snapshot request</h2>
    <p>
      <strong>Name:</strong> ${escapeHtml(name)}<br/>
      <strong>Email:</strong> ${escapeHtml(email)}<br/>
      <strong>Website:</strong> ${escapeHtml(url)}<br/>
      <strong>Tier:</strong> ${escapeHtml(tier || "not specified")}
    </p>
    <hr/>
    ${
      draftError
        ? `<p><strong>AI draft could not be generated:</strong> ${escapeHtml(draftError)}</p><p>You'll need to review this one from scratch.</p>`
        : `<h3>AI working draft (review before sending - not client-ready)</h3><pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(draftText)}</pre>`
    }
  `;

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "api-key": brevoKey,
    },
    body: JSON.stringify({
      sender: { email: NOTIFY_FROM, name: "Quick-Win Snapshot" },
      to: [{ email: NOTIFY_TO }],
      replyTo: { email },
      subject,
      htmlContent: bodyHtml,
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || `Brevo API returned ${res.status}`);
  }
}

exports.main = async (args) => {
  let payload = {};
  if (args.http?.body) {
    try {
      const raw = args.http.isBase64Encoded
        ? Buffer.from(args.http.body, "base64").toString("utf8")
        : args.http.body;
      payload = JSON.parse(raw);
    } catch {
      // fall through - handled by validation below
    }
  } else {
    payload = args;
  }

  if (args.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  const { name, email, url, tier } = payload;

  try {
    if (!name || !String(name).trim()) throw new Error("Please enter your name.");
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
      throw new Error("Please enter a valid email address.");
    }
    if (!url || !String(url).trim()) throw new Error("Please enter your website address.");

    const normalizedUrl = normalizeUrl(url);

    // Generate the draft, but never let a draft failure block the client's
    // submission from reaching Sara - she'd rather get a "draft failed, do
    // this one by hand" email than nothing at all.
    let draftText = null;
    let draftError = null;
    try {
      const html = await fetchHtml(normalizedUrl);
      const structure = extractStructure(html);
      const result = await draftAssessment(normalizedUrl, structure);
      draftText = result.draftText;
    } catch (err) {
      draftError = err.message || String(err);
    }

    await sendNotificationEmail({
      name: String(name).trim(),
      email: String(email).trim(),
      tier: tier ? String(tier).trim() : "",
      url: normalizedUrl,
      draftText,
      draftError,
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: err.message || String(err) }),
    };
  }
};
