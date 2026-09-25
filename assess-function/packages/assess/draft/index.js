/**
 * DigitalOcean Function: assess/draft
 * ------------------------------------
 * Lightweight (no headless browser) version of the Website Quick-Fix
 * Review drafter. Fetches a page's raw HTML, pulls out its structure with regex
 * (title, headings, CTAs, forms, word count - no screenshots), and asks
 * Claude to draft 5 prioritised UX fixes.
 *
 * This trades away the desktop/mobile screenshots (so it can't catch
 * purely visual issues like overlapping elements or bad spacing) in
 * exchange for being deployable as a plain serverless function with zero
 * npm dependencies and no browser binary to install.
 *
 * Called as a web function (project.yml sets `web: true`), so it's reachable
 * directly over HTTPS. Expects a POST with JSON body: { "url": "https://..." }
 * Returns JSON: { url, structure, draftText, usage } or { error }.
 */

const MODEL = process.env.ASSESS_MODEL || "claude-sonnet-5";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function normalizeUrl(input) {
  let candidate = String(input || "").trim();
  if (!candidate) throw new Error("No URL provided.");
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    return new URL(candidate).toString();
  } catch {
    throw new Error(`"${input}" doesn't look like a valid URL. Try something like https://example.com`);
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
        // A plain fetch UA gets blocked by some sites' bot protection more
        // often than a browser UA does.
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

// Very small, dependency-free "structure extraction" using regex instead of
// a real DOM. Good enough for headings/CTAs/meta on typical marketing pages;
// won't handle content injected by JavaScript after page load (a real
// headless-browser pass, like the local prototype's Playwright version,
// would be needed for JS-heavy sites).
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
  return `You are drafting a "Website Quick-Fix Review" for a UX consultant, Sara Shipley (shipleyux.com), who reviews and edits every draft before it goes to the client. Your output is an internal working draft, not a finished deliverable - write it as if Sara will tighten it, not as final client-ready copy.

Format (Sara's standard Website Quick-Fix Review deliverable):
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
    throw new Error("ANTHROPIC_API_KEY is not set on this function. Add it as a secret/env var in the App Platform component settings.");
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

exports.main = async (args) => {
  // DO Functions merge query/body params into `args`; the raw HTTP body also
  // arrives under `args.http.body` (base64 if binary) on web actions.
  let url = args.url;
  if (!url && args.http?.body) {
    try {
      const raw = args.http.isBase64Encoded
        ? Buffer.from(args.http.body, "base64").toString("utf8")
        : args.http.body;
      url = JSON.parse(raw).url;
    } catch {
      // fall through - handled by the !url check below
    }
  }

  // CORS preflight
  if (args.http?.method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    if (!url) throw new Error("Missing required field: url");
    const normalized = normalizeUrl(url);

    const html = await fetchHtml(normalized);
    const structure = extractStructure(html);
    const { draftText, usage } = await draftAssessment(normalized, structure);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ url: normalized, structure, draftText, usage }),
    };
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      body: JSON.stringify({ error: err.message || String(err) }),
    };
  }
};
