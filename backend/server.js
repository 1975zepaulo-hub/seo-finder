if (process.env.NODE_ENV !== 'production') require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const Anthropic = require("@anthropic-ai/sdk");
const PDFDocument = require("pdfkit");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const SERPER_KEY = process.env.SERPER_KEY;
const PAGESPEED_KEY = process.env.PAGESPEED_KEY;

const jobs = {};

// Known directories/aggregators — never actual business sites
const SKIP_DOMAINS = [
  // Job/service directories
  'indeed.com','thumbtack.com','bark.com','bidvine.com','taskrabbit.com',
  'angi.com','homeadvisor.com','angieslist.com','houzz.com','fixr.co.uk',
  'checkatrade.com','trustatrader.com','mybuilder.com','ratedpeople.com',
  'habitissimo.com','porch.com','networx.com','improvenet.com',
  // Review/listing sites
  'yelp.com','yellowpages.com','bbb.org','trustpilot.com','sitejabber.com',
  'tripadvisor.com','foursquare.com','opentable.com','zomato.com',
  'bestpickreports.com','homewyse.com','costimates.com','fixr.com',
  'expertise.com','craftjack.com','localiq.com','yell.com','scoot.co.uk',
  'freeindex.co.uk','hotfrog.co.uk','thomson.co.uk','192.com',
  // Social / big platforms
  'facebook.com','linkedin.com','twitter.com','instagram.com','tiktok.com',
  'youtube.com','pinterest.com','nextdoor.com','reddit.com',
  // General web
  'google.com','bing.com','yahoo.com','amazon.com','ebay.com',
  'wikipedia.org','craigslist.org','gumtree.com','olx.com',
  // News/media
  'glassdoor.com','entrepreneur.com','forbes.com','businessinsider.com',
  'inc.com','huffpost.com','theguardian.com','bbc.co.uk','dailymail.co.uk',
];

function shouldSkip(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return SKIP_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch { return true; }
}

// ── 1. Search Google pages via Serper ───────────────────────────────────────
async function searchGoogle(query, startPage = 3, endPage = 10) {
  const results = [];
  for (let page = startPage; page <= endPage; page++) {
    try {
      const resp = await axios.post(
        "https://google.serper.dev/search",
        { q: query, page, num: 10 },
        { headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" } }
      );
      (resp.data.organic || []).forEach((r) => {
        if (r.link && !results.find((x) => x.url === r.link))
          results.push({ url: r.link, title: r.title, snippet: r.snippet, page });
      });
    } catch (e) {
      console.error(`Serper page ${page} error:`, e.message);
    }
  }
  return results;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── 2. PageSpeed Insights ────────────────────────────────────────────────────
async function runPageSpeed(url) {
  try {
    // Run mobile first, then desktop with a small gap to avoid rate limiting
    const psParams = (strategy) => ({
      url, key: PAGESPEED_KEY, strategy,
      category: ['performance', 'seo', 'accessibility', 'best-practices'],
    });
    const mobileResp = await axios.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", {
      params: psParams("mobile"), timeout: 20000,
    });
    await sleep(500);
    const desktopResp = await axios.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", {
      params: psParams("desktop"), timeout: 20000,
    });

    const mData = mobileResp.data;
    const dData = desktopResp.data;
    const cats = mData.lighthouseResult?.categories || {};
    const audits = mData.lighthouseResult?.audits || {};
    const dCats = dData.lighthouseResult?.categories || {};

    const issues = [];
    const checkAudit = (id, label, detail = null) => {
      const a = audits[id];
      if (a && a.score !== null && a.score < 0.9) issues.push({ label, detail: detail || a.displayValue || null });
    };

    checkAudit("uses-https", "No SSL / HTTPS");
    checkAudit("meta-description", "Missing meta description");
    checkAudit("document-title", "Missing or poor page title");
    checkAudit("image-alt", "Images missing alt text");
    checkAudit("link-text", "Poor link anchor text");
    checkAudit("tap-targets", "Tap targets too small on mobile");
    checkAudit("font-size", "Text too small to read on mobile");
    checkAudit("viewport", "No mobile viewport meta tag");
    checkAudit("render-blocking-resources", "Render-blocking resources slowing load");
    checkAudit("uses-optimized-images", "Images not compressed/optimized");
    checkAudit("uses-webp-images", "Images not in modern format (WebP/AVIF)");
    checkAudit("unused-css-rules", "Unused CSS adding page weight");
    checkAudit("unused-javascript", "Unused JavaScript adding page weight");
    checkAudit("uses-text-compression", "No Gzip/Brotli text compression");
    checkAudit("time-to-first-byte", "Slow server response time (TTFB)");
    checkAudit("server-response-time", "Server response time too high");
    checkAudit("dom-size", "DOM too large — too many HTML elements");
    checkAudit("efficient-animated-content", "Animated GIFs — should be video");

    return {
      mobileScore: Math.round((cats.performance?.score || 0) * 100),
      desktopScore: Math.round((dCats.performance?.score || 0) * 100),
      seoScore: Math.round((cats.seo?.score || 0) * 100),
      accessibilityScore: Math.round((cats.accessibility?.score || 0) * 100),
      bestPracticesScore: Math.round((cats["best-practices"]?.score || 0) * 100),
      lcp: audits["largest-contentful-paint"]?.displayValue || "N/A",
      tbt: audits["total-blocking-time"]?.displayValue || "N/A",
      cls: audits["cumulative-layout-shift"]?.displayValue || "N/A",
      fcp: audits["first-contentful-paint"]?.displayValue || "N/A",
      tti: audits["interactive"]?.displayValue || "N/A",
      issues,
      issueLabels: issues.map((i) => i.label),
      hasSSL: !issues.find((i) => i.label === "No SSL / HTTPS"),
    };
  } catch (e) {
    console.error("PageSpeed error:", e.message);
    return null;
  }
}

// ── 3. Crawl for contacts ────────────────────────────────────────────────────
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const EMAIL_SKIP = ["sentry","example","wixpress","cloudflare","schema.org","w3.org","googleapis","jquery","facebook","instagram","twitter","youtu"];

function extractEmails(html, existing = []) {
  return (html.match(EMAIL_REGEX) || []).filter(e =>
    !EMAIL_SKIP.some(s => e.toLowerCase().includes(s)) && !existing.includes(e)
  );
}

async function crawlSite(url) {
  const result = {
    emails: [], phones: [], facebookUrl: null, crawlError: false,
    // Content signals
    pageTitle: "", metaTitleLength: 0,
    metaDesc: "", metaDescLength: 0,
    hasH1: false, h1Text: "", h1Count: 0,
    h2Count: 0, h3Count: 0,
    imagesTotal: 0, imagesWithAlt: 0,
    wordCount: 0, internalLinks: 0, externalLinks: 0,
    hasSchema: false, hasCanonical: false, hasOgTags: false, hasViewport: false,
    // Technical
    sitemapFound: false, robotsTxtFound: false,
  };

  const base = new URL(url);
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

  // Check sitemap and robots.txt in parallel
  await Promise.all([
    axios.get(base.origin + "/sitemap.xml", { timeout: 6000, headers: { "User-Agent": UA } })
      .then(() => { result.sitemapFound = true; }).catch(() => {}),
    axios.get(base.origin + "/robots.txt", { timeout: 6000, headers: { "User-Agent": UA } })
      .then(() => { result.robotsTxtFound = true; }).catch(() => {}),
  ]);

  const pages = [url, url.replace(/\/?$/, "/contact"), url.replace(/\/?$/, "/about")];

  for (const pageUrl of pages) {
    try {
      const resp = await axios.get(pageUrl, {
        timeout: 10000,
        headers: { "User-Agent": UA },
        maxRedirects: 5,
      });
      const html = resp.data;
      const $ = cheerio.load(html);

      extractEmails(html, result.emails).forEach(e => result.emails.push(e));

      const phoneRegex = /(\+?[\d\s\-().]{7,})/g;
      (html.match(phoneRegex) || []).forEach((p) => {
        const digits = p.replace(/\D/g, "");
        if (digits.length >= 7 && digits.length <= 15 && !result.phones.includes(p.trim()))
          result.phones.push(p.trim());
      });

      if (!result.facebookUrl) {
        $('a[href*="facebook.com"]').each((_, el) => {
          const href = $(el).attr("href") || "";
          if (href.match(/facebook\.com\/(?!sharer|share|login|home|watch|groups|events)[\w.]+/)) {
            result.facebookUrl = href.split("?")[0].replace(/\/$/, "");
          }
        });
      }

      // Deep content analysis on homepage only
      if (pageUrl === url) {
        result.pageTitle = $("title").text().trim();
        result.metaTitleLength = result.pageTitle.length;

        const metaDescContent = $('meta[name="description"]').attr("content") || "";
        result.metaDesc = metaDescContent.trim();
        result.metaDescLength = result.metaDesc.length;

        const h1s = $("h1");
        result.h1Count = h1s.length;
        result.hasH1 = h1s.length > 0;
        result.h1Text = h1s.first().text().trim().slice(0, 120);
        result.h2Count = $("h2").length;
        result.h3Count = $("h3").length;

        const imgs = $("img");
        result.imagesTotal = imgs.length;
        result.imagesWithAlt = imgs.filter((_, el) => {
          const alt = $(el).attr("alt");
          return alt && alt.trim().length > 0;
        }).length;

        // Word count from visible text
        $("script, style, nav, footer, header").remove();
        const bodyText = $("body").text().replace(/\s+/g, " ").trim();
        result.wordCount = bodyText.split(" ").filter(w => w.length > 1).length;

        // Links
        const allLinks = $("a[href]");
        let internal = 0, external = 0;
        allLinks.each((_, el) => {
          const href = $(el).attr("href") || "";
          if (href.startsWith("http") && !href.includes(base.hostname)) external++;
          else if (href.startsWith("/") || href.includes(base.hostname)) internal++;
        });
        result.internalLinks = internal;
        result.externalLinks = external;

        result.hasSchema = html.includes('"@context"') && (html.includes("schema.org") || html.includes("Schema.org"));
        result.hasCanonical = $('link[rel="canonical"]').length > 0;
        result.hasOgTags = $('meta[property^="og:"]').length > 0;
        result.hasViewport = $('meta[name="viewport"]').length > 0;
      }
    } catch (e) {
      if (pageUrl === url) result.crawlError = true;
    }
  }

  if (!result.emails.length && result.facebookUrl) {
    const fbEmails = await crawlFacebook(result.facebookUrl);
    fbEmails.forEach(e => result.emails.push(e));
    if (fbEmails.length) result.emailSource = "facebook";
  }

  return result;
}

// ── 3b. Crawl Facebook About page for email ──────────────────────────────────
async function crawlFacebook(fbUrl) {
  const aboutUrl = fbUrl + "/about";
  const emails = [];

  // Try the mobile version — less JS-heavy, more raw content
  const mobileUrl = aboutUrl.replace("www.facebook.com", "m.facebook.com");

  for (const tryUrl of [mobileUrl, aboutUrl]) {
    try {
      const resp = await axios.get(tryUrl, {
        timeout: 12000,
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
          "Accept-Language": "en-US,en;q=0.9",
        },
        maxRedirects: 3,
      });
      extractEmails(resp.data, emails).forEach(e => emails.push(e));
      if (emails.length) break;
    } catch (_) {}
  }

  return emails;
}

// ── 4. Generate TWO pitches: SEO email + Design email ───────────────────────
async function generatePitches(businessName, url, crawl, pageSpeed, query, aiKey, aiProvider, aiModel) {
  const allIssues = [
    ...(pageSpeed?.issueLabels || []),
    ...(!crawl.hasH1 ? ["No H1 heading on homepage"] : []),
    ...(!crawl.hasMetaDesc ? ["No meta description tag"] : []),
  ];
  const topIssues = allIssues.slice(0, 5).join("; ");
  const googlePage = crawl.googlePage || "unknown";

  // CTR data by page (industry averages)
  const ctrMap = { 1:"~28%", 2:"~6%", 3:"~3%", 4:"~2%", 5:"~1.5%" };
  const ctr = ctrMap[googlePage] || "<1%";
  const page1Ctr = "~28%";

  const prompt = `You are an SEO and web design expert who has ALREADY audited this business's website. The audit is done — present findings as facts, never offer to run one.

Write TWO cold outreach emails. Return ONLY valid JSON, no markdown, no code blocks.

=== AUDIT DATA ===
Business: ${businessName}
Website: ${url}
Search query (niche + location): "${query}"
Google page found on: PAGE ${googlePage} (meaning they are buried — only ${ctr} of searchers ever reach this page)
Page 1 competitors get: ${page1Ctr} of all clicks — that is the calls and bookings this business is MISSING right now
Mobile performance score: ${pageSpeed?.mobileScore ?? "N/A"}/100  (below 50 = slow site = Google ranks it lower)
Desktop score: ${pageSpeed?.desktopScore ?? "N/A"}/100
SEO score: ${pageSpeed?.seoScore ?? "N/A"}/100
Load time (TTI): ${pageSpeed?.tti ?? "N/A"}
SSL: ${pageSpeed?.hasSSL ? "Yes" : "NO — site is flagged as insecure by browsers"}
Technical issues found: ${topIssues || "general performance and SEO issues"}
Has H1 heading: ${crawl.hasH1 ? "Yes" : "No — missing, hurts rankings"}
Has meta description: ${crawl.hasMetaDesc ? "Yes" : "No — missing, hurts click-through rate"}

=== INSTRUCTIONS ===

EMAIL 1 — SEO Pitch (attach the PDF audit report to this):
- Open by naming the exact page they're on (e.g. "I found [Business] on page ${googlePage} of Google for [service] in [city]")
- Tell them what that means in plain English — how many people searching for their service never see them, and that the businesses on page 1 are getting those calls instead
- Mention the single most damaging technical issue from the audit (from the data above) and why it is directly hurting their ranking
- Include a short 3-row keyword search volume table (realistic estimates for their niche + city, monthly searches) like:
  Keyword | Est. monthly searches
  [their main service] [city] | ~XXX
  [variant keyword] [city] | ~XXX
  [near me variant] | ~XXX
  (use realistic numbers based on city size and niche — a Lagos plumber will have different volume than a Dubai dentist)
- For the CTA: do NOT just say "check the PDF". Instead, tease ONE specific surprising or alarming finding from the audit that you haven't mentioned in the email body yet — something that will make them curious enough to open it. Frame it like: "I've flagged [X] other issues in the full report — one of them in particular explains exactly why [competitor type] on page 1 is pulling your customers. It's attached." OR "The report also shows something most business owners don't realise is silently hurting their ranking — page 2 of the PDF." The goal: make opening the PDF feel like it has the answer to their problem, not just a list of complaints.
- Tone: direct, human, like a freelancer who spotted a real problem — not salesy

EMAIL 2 — Web Design Pitch:
- Open by noting you looked at the site while auditing it and spotted specific design/UX issues that are hurting conversions (name 1-2 specific things based on the audit — slow load, no clear CTA, mobile layout broken, looks like it hasn't been updated in years, etc.)
- Explain that even if SEO improves and brings people to page 1, a poor-looking site will lose those visitors immediately — you need both
- Say you've already mocked up a redesigned version and will share it at no cost or obligation just to show them what's possible
- CTA: "Want me to send it over?"
- Tone: same — human, direct, no jargon

Rules for BOTH emails:
- NEVER offer to "run an audit" — it is already done and the PDF is attached
- NEVER use: seamless, leverage, empower, holistic, synergy, game-changer, cutting-edge, boost
- Sound like one real freelancer writing to one real business owner
- No subject lines — body text only
- Max 5 sentences each (the keyword table in email 1 is additional, not counted)

Return exactly this JSON:
{"seoPitch": "...", "designPitch": "..."}`;

  try {
    let text;
    const provider = (aiProvider || "anthropic").toLowerCase();

    if (provider === "openai") {
      const resp = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: aiModel || "gpt-4o-mini",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }, { headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json" }, timeout: 30000 });
      text = resp.data.choices[0].message.content.trim();
    } else if (provider === "openrouter") {
      const resp = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
        model: aiModel || "anthropic/claude-haiku-4-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }, { headers: { Authorization: `Bearer ${aiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://zaram.app", "X-Title": "Zaram SEO PitchReady" }, timeout: 30000 });
      text = resp.data.choices[0].message.content.trim();
    } else {
      // Default: Anthropic
      const client = new Anthropic({ apiKey: aiKey || process.env.ANTHROPIC_KEY });
      const msg = await client.messages.create({
        model: aiModel || "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });
      text = msg.content[0].text.trim();
    }

    const json = JSON.parse(text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim());
    return { seoPitch: json.seoPitch, designPitch: json.designPitch };
  } catch (e) {
    console.error("Pitch generation error:", e.message);
    return {
      seoPitch: "Could not generate pitch — check your API key in Settings.",
      designPitch: "Could not generate pitch — check your API key in Settings.",
    };
  }
}

// ── 5. Generate PDF audit report ─────────────────────────────────────────────
function generatePDF(lead, res) {
  const doc = new PDFDocument({ margin: 50, size: "A4", autoFirstPage: true, bufferPages: true });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="audit-${new URL(lead.url).hostname}.pdf"`);
  doc.pipe(res);

  // ── Colour palette ──
  const PASS  = [22, 163, 74];
  const WARN  = [234, 88, 12];
  const FAIL  = [220, 38, 38];
  const BLUE  = [79, 70, 229];
  const DARK  = [15, 23, 42];
  const MID   = [51, 65, 85];
  const LIGHT = [100, 116, 139];
  const BG    = [248, 250, 252];
  const WHITE = [255, 255, 255];

  const scoreColor = (s) => s >= 70 ? PASS : s >= 40 ? WARN : FAIL;

  const W = 595, ML = 50, MR = 50, CW = W - ML - MR; // page width, margins, content width

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const pageCheck = (needed = 60) => { if (doc.y > 842 - needed) doc.addPage(); };

  const footer = () => {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.rect(0, 820, W, 22).fill([234, 238, 245]);
      doc.fillColor(LIGHT).fontSize(6.5).font("Helvetica")
        .text(
          `CONFIDENTIAL — Prepared by Zaram SEO PitchReady  ·  ${new Date().toLocaleDateString("en-GB", { day:"numeric", month:"long", year:"numeric" })}  ·  Data source: Google PageSpeed Insights API  ·  Page ${i + 1} of ${range.count}`,
          ML, 826, { width: CW, align: "center" }
        );
    }
  };

  // Section header bar
  const section = (title, subtitle = "") => {
    pageCheck(50);
    doc.moveDown(0.7);
    const y = doc.y;
    doc.rect(ML, y, CW, subtitle ? 28 : 22).fill([234, 238, 245]);
    doc.rect(ML, y, 4, subtitle ? 28 : 22).fill(BLUE);
    doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold")
      .text(title.toUpperCase(), ML + 12, y + 5, { characterSpacing: 0.9, width: CW - 12 });
    if (subtitle) {
      doc.fillColor(LIGHT).fontSize(7.5).font("Helvetica")
        .text(subtitle, ML + 12, y + 17, { width: CW - 12 });
    }
    doc.y = y + (subtitle ? 28 : 22) + 8;
  };

  // PASS / WARN / FAIL badge
  const badge = (x, y, status, w = 36) => {
    const map = { PASS: [PASS, "PASS"], WARN: [WARN, "WARN"], FAIL: [FAIL, "FAIL"] };
    const [col, lbl] = map[status] || [BLUE, status];
    doc.roundedRect(x, y, w, 13, 3).fill(col);
    doc.fillColor(WHITE).fontSize(6.5).font("Helvetica-Bold")
      .text(lbl, x, y + 3, { width: w, align: "center" });
  };

  // Full audit row: badge + bold title + plain-English explanation + optional measurement
  const auditRow = (status, title, explain, measure = "") => {
    pageCheck(50);
    const y = doc.y;
    badge(ML, y, status);
    // title
    doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold")
      .text(title, ML + 44, y, { width: 330, lineBreak: false });
    // measurement right-aligned
    if (measure) {
      const mCol = status === "PASS" ? PASS : status === "WARN" ? WARN : FAIL;
      doc.fillColor(mCol).fontSize(8).font("Helvetica-Bold")
        .text(measure, ML + 44 + 330, y, { width: CW - 44 - 330, align: "right" });
    }
    doc.y = y + 14;
    // plain-English explanation
    if (explain) {
      doc.fillColor(MID).fontSize(8).font("Helvetica")
        .text(explain, ML + 44, doc.y, { width: CW - 44 });
    }
    doc.moveDown(0.65);
  };

  // Score card (smaller, 4 across)
  const scoreCard = (x, y, label, sublabel, score) => {
    const [r, g, b] = scoreColor(score);
    const h = 64;
    doc.roundedRect(x, y, 114, h, 6).fill([r, g, b, 0.07]);
    doc.roundedRect(x, y, 114, h, 6).strokeColor([r, g, b]).lineWidth(1.2).stroke();
    doc.fillColor([r, g, b]).fontSize(26).font("Helvetica-Bold")
      .text(score > 0 ? score : "N/A", x, y + 8, { width: 114, align: "center" });
    doc.fillColor(DARK).fontSize(7.5).font("Helvetica-Bold")
      .text(label, x, y + 42, { width: 114, align: "center" });
    doc.fillColor(LIGHT).fontSize(6.5).font("Helvetica")
      .text(sublabel, x, y + 53, { width: 114, align: "center" });
  };

  // Callout box (coloured background info block)
  const callout = (x, y, w, h, col, text, textCol = WHITE) => {
    doc.roundedRect(x, y, w, h, 6).fill(col);
    doc.fillColor(textCol).fontSize(8.5).font("Helvetica")
      .text(text, x + 12, y + 10, { width: w - 24 });
    return y + h;
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PAGE 1 — EXECUTIVE SUMMARY
  // ════════════════════════════════════════════════════════════════════════════

  // Dark header band
  doc.rect(0, 0, W, 108).fill(DARK);
  doc.rect(0, 0, 5, 108).fill(BLUE);

  doc.fillColor(BLUE).fontSize(7.5).font("Helvetica-Bold")
    .text("WEBSITE PERFORMANCE & SEO AUDIT REPORT", ML, 18, { characterSpacing: 1.4 });

  const titleStr = (lead.title || new URL(lead.url).hostname).slice(0, 62);
  doc.fillColor(WHITE).fontSize(18).font("Helvetica-Bold").text(titleStr, ML, 32);
  doc.fillColor([148, 163, 184]).fontSize(8).font("Helvetica").text(lead.url, ML, 56);

  const ctrMap = { 1:"~28%", 2:"~6%", 3:"~3%", 4:"~2%", 5:"~1.5%" };
  const ctr = ctrMap[lead.googlePage] || "<1%";
  const auditDate = new Date().toLocaleDateString("en-GB", { day:"numeric", month:"long", year:"numeric" });
  doc.fillColor([167, 139, 250]).fontSize(8).font("Helvetica-Bold")
    .text(`Found on Google PAGE ${lead.googlePage}  ·  Estimated click-through rate at this position: ${ctr}  ·  Audit date: ${auditDate}`,
      ML, 72, { characterSpacing: 0.2 });

  doc.y = 120;

  // ── Overall grade + summary ──
  const checks = [
    lead.hasSSL, lead.hasH1, lead.metaDescLength > 0,
    lead.metaTitleLength >= 30 && lead.metaTitleLength <= 60,
    lead.sitemapFound, lead.robotsTxtFound, lead.hasCanonical, lead.hasSchema,
    lead.hasViewport, lead.hasOgTags, lead.h2Count >= 2,
    lead.imagesWithAlt === lead.imagesTotal && lead.imagesTotal > 0,
    lead.wordCount >= 300, lead.internalLinks >= 3,
    lead.mobileScore >= 70, lead.seoScore >= 70,
  ];
  const passed = checks.filter(Boolean).length;
  const total  = checks.length;
  const failed = total - passed;
  const grade  = passed >= 14 ? "A" : passed >= 11 ? "B" : passed >= 8 ? "C" : passed >= 5 ? "D" : "F";
  const [gr, gg, gb] = passed >= 14 ? PASS : passed >= 11 ? WARN : FAIL;

  const gradeY = doc.y;
  // Grade circle
  doc.circle(ML + 36, gradeY + 36, 36).fill([gr, gg, gb]);
  doc.fillColor(WHITE).fontSize(34).font("Helvetica-Bold")
    .text(grade, ML, gradeY + 16, { width: 72, align: "center" });
  doc.fillColor(WHITE).fontSize(6).font("Helvetica-Bold")
    .text("GRADE", ML, gradeY + 56, { width: 72, align: "center" });

  // Summary text
  const gradeMeaning = {
    A: "This site is in good shape — a few optimisations will push it to the top.",
    B: "Solid foundation with some gaps. Fixing the highlighted issues could move it to page 1.",
    C: "Moderate issues are holding this site back from page 1. Each fix directly improves ranking.",
    D: "Significant problems are preventing this site from competing. Without fixes, it will stay buried.",
    F: "Critical issues are blocking this site from ranking. Competitors are winning every search it should appear for.",
  };
  const gradeLabel = { A:"Excellent", B:"Good", C:"Needs Work", D:"Poor", F:"Critical" };

  doc.fillColor(DARK).fontSize(13).font("Helvetica-Bold")
    .text(`${gradeLabel[grade]} — ${passed}/${total} checks passed`, ML + 84, gradeY + 4);
  doc.fillColor(MID).fontSize(8.5).font("Helvetica")
    .text(gradeMeaning[grade], ML + 84, gradeY + 24, { width: CW - 84 });

  // Progress bar
  const barY2 = gradeY + 50, barW = CW - 84;
  doc.roundedRect(ML + 84, barY2, barW, 9, 4).fill([226, 232, 240]);
  doc.roundedRect(ML + 84, barY2, Math.round(barW * passed / total), 9, 4).fill([gr, gg, gb]);
  doc.fillColor(LIGHT).fontSize(7).font("Helvetica")
    .text(`${failed} issue${failed !== 1 ? "s" : ""} found`, ML + 84, barY2 + 12);

  doc.y = gradeY + 80;

  // ── Business impact callout ──
  const ctrLost = lead.googlePage >= 3 ? "97" : lead.googlePage === 2 ? "94" : "72";
  const impactText =
    `RIGHT NOW: ${ctrLost}% of people searching for this business's services on Google never see this website — because it is buried on page ${lead.googlePage}. ` +
    `The businesses appearing on page 1 are receiving those calls, bookings, and enquiries instead. ` +
    `The ${failed} issue${failed !== 1 ? "s" : ""} identified in this report are the specific reasons why this site is not ranking higher. ` +
    `Each one fixed is a step closer to page 1.`;
  const impactH = 12 + Math.ceil(impactText.length / 90) * 11 + 10;
  callout(ML, doc.y, CW, impactH, [30, 41, 59], impactText);
  doc.y += impactH + 12;

  // ── Performance score cards ──
  section("Google Performance Scores", "Measured by Google PageSpeed Insights — the same tool Google uses to evaluate sites for ranking");
  const scY = doc.y;
  scoreCard(ML,       scY, "Mobile Speed",   "How fast on phones",    lead.mobileScore  || 0);
  scoreCard(ML + 122, scY, "Desktop Speed",  "How fast on computers", lead.desktopScore || 0);
  scoreCard(ML + 244, scY, "SEO Score",      "Google readability",    lead.seoScore     || 0);
  scoreCard(ML + 366, scY, "Accessibility",  "Usability for all",     lead.accessibilityScore || 0);
  doc.y = scY + 76;

  // Score legend
  doc.fillColor(LIGHT).fontSize(7.5).font("Helvetica")
    .text("Score guide:  ", ML, doc.y, { continued: true });
  doc.fillColor(PASS).text("90–100 = Excellent  ", { continued: true });
  doc.fillColor(WARN).text("50–89 = Needs Improvement  ", { continued: true });
  doc.fillColor(FAIL).text("0–49 = Poor (hurting rankings)", { continued: false });
  doc.moveDown(0.8);

  // ── Core Web Vitals ──
  section("Page Speed Breakdown (Core Web Vitals)", "Google officially uses these 5 metrics to decide your ranking position. Slow = lower rank.");

  const vitals = [
    {
      name: "Largest Contentful Paint (LCP)", val: lead.lcp,
      explain: "How long it takes for the main content of your page to fully appear. If this is slow, visitors stare at a blank or partial screen before they can read anything — most will leave and go to a competitor.",
      benchmark: "Under 2.5s = good",
      status: !lead.lcp || lead.lcp === "N/A" ? "WARN" : parseFloat(lead.lcp) <= 2.5 ? "PASS" : parseFloat(lead.lcp) <= 4 ? "WARN" : "FAIL",
    },
    {
      name: "First Contentful Paint (FCP)", val: lead.fcp,
      explain: "The moment your page starts showing anything at all. People judge a website in under a second — a slow FCP means a bad first impression before a single word is read.",
      benchmark: "Under 1.8s = good",
      status: !lead.fcp || lead.fcp === "N/A" ? "WARN" : parseFloat(lead.fcp) <= 1.8 ? "PASS" : parseFloat(lead.fcp) <= 3 ? "WARN" : "FAIL",
    },
    {
      name: "Total Blocking Time (TBT)", val: lead.tbt,
      explain: "How long the page is frozen and unresponsive after it loads. During this time, visitors can tap buttons or links and nothing happens — they think the site is broken and leave.",
      benchmark: "Under 200ms = good",
      status: !lead.tbt || lead.tbt === "N/A" ? "WARN" : parseInt(lead.tbt) <= 200 ? "PASS" : parseInt(lead.tbt) <= 600 ? "WARN" : "FAIL",
    },
    {
      name: "Cumulative Layout Shift (CLS)", val: lead.cls,
      explain: "How much the page jumps and rearranges while loading. A high score means text or buttons visually shift — visitors click the wrong thing, or simply lose trust in the site.",
      benchmark: "Under 0.1 = good",
      status: !lead.cls || lead.cls === "N/A" ? "WARN" : parseFloat(lead.cls) <= 0.1 ? "PASS" : parseFloat(lead.cls) <= 0.25 ? "WARN" : "FAIL",
    },
    {
      name: "Time to Interactive (TTI)", val: lead.tti,
      explain: "How long before a visitor can actually use the site — click a button, dial a phone number, or fill a contact form. Delays here directly cost the business enquiries.",
      benchmark: "Under 3.8s = good",
      status: !lead.tti || lead.tti === "N/A" ? "WARN" : parseFloat(lead.tti) <= 3.8 ? "PASS" : parseFloat(lead.tti) <= 7.3 ? "WARN" : "FAIL",
    },
  ];

  vitals.forEach(v => {
    auditRow(v.status, v.name, v.explain, v.val ? `${v.val}  (${v.benchmark})` : `N/A — ${v.benchmark}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // PAGE 2 — SEO & TECHNICAL AUDIT
  // ════════════════════════════════════════════════════════════════════════════
  doc.addPage();

  // ── On-Page SEO ──
  section("On-Page SEO Findings", "These are the signals Google reads on the page itself to decide what you rank for and how trustworthy your site is.");

  // SSL
  auditRow(
    lead.hasSSL ? "PASS" : "FAIL",
    "SSL Security Certificate (HTTPS)",
    lead.hasSSL
      ? "The site is secure (HTTPS). Google confirms this as a ranking factor and visitors see a padlock in their browser, building trust."
      : "The site runs on HTTP — every visitor's browser shows a 'Not Secure' warning. Google actively penalises unsecured sites in rankings. Many people will immediately leave a site with this warning, especially before booking or buying anything.",
    lead.hasSSL ? "Secure ✓" : "NOT SECURE"
  );

  // Page Title
  const titleStatus = lead.metaTitleLength >= 30 && lead.metaTitleLength <= 60 ? "PASS"
    : lead.metaTitleLength > 0 ? "WARN" : "FAIL";
  auditRow(
    titleStatus,
    "Page Title Tag",
    lead.metaTitleLength === 0
      ? "No page title was found. The page title is the clickable blue headline people see in Google search results. Without it, Google writes one automatically — usually something generic that very few people click."
      : lead.metaTitleLength < 30
        ? `The title is too short at ${lead.metaTitleLength} characters. It should include the main service keyword and the business location. Short titles miss ranking opportunities.`
        : lead.metaTitleLength > 60
          ? `At ${lead.metaTitleLength} characters, the title is too long — Google cuts it off mid-sentence in search results, making it look unprofessional and reducing click-through rates.`
          : `Title is well-optimised at ${lead.metaTitleLength} characters.${lead.pageTitle ? ' Current title: "' + lead.pageTitle.slice(0, 80) + '"' : ""}`,
    lead.metaTitleLength > 0 ? `${lead.metaTitleLength} chars` : "Missing"
  );

  // Meta Description
  const descStatus = lead.metaDescLength >= 120 && lead.metaDescLength <= 160 ? "PASS"
    : lead.metaDescLength > 0 ? "WARN" : "FAIL";
  auditRow(
    descStatus,
    "Meta Description",
    lead.metaDescLength === 0
      ? "No meta description found. This is the 2-line preview that appears under the business name in Google results. Without one, Google picks random sentences from the page — often something that makes no sense out of context. A good description is what convinces someone to click your link over the one above or below it."
      : lead.metaDescLength < 120
        ? `The description is too short (${lead.metaDescLength} chars). At this length, Google may rewrite it with something less persuasive.`
        : lead.metaDescLength > 160
          ? `The description is too long (${lead.metaDescLength} chars) and will be cut off in Google results. Shorten it to under 160 characters.`
          : "Meta description is a good length and will display fully in Google results.",
    lead.metaDescLength > 0 ? `${lead.metaDescLength} chars` : "Missing"
  );

  // H1
  const h1Status = lead.h1Count === 1 ? "PASS" : lead.h1Count > 1 ? "WARN" : "FAIL";
  auditRow(
    h1Status,
    "H1 Main Heading",
    lead.h1Count === 0
      ? "No H1 heading was found on the homepage. The H1 is the main headline of a page — it tells Google exactly what this business does and who it serves. Without it, Google has to guess, and often gets it wrong, showing the site to the wrong audience or not at all."
      : lead.h1Count > 1
        ? `${lead.h1Count} H1 headings were found. There should be exactly one — multiple H1s confuse Google about the page's main topic.${lead.h1Text ? ' Main H1: "' + lead.h1Text.slice(0, 80) + '"' : ""}`
        : `H1 is present and well-structured.${lead.h1Text ? ' Heading: "' + lead.h1Text.slice(0, 80) + '"' : ""}`,
    lead.h1Count > 0 ? `${lead.h1Count} found` : "Missing"
  );

  // Headings
  const headingStatus = lead.h2Count >= 2 ? "PASS" : lead.h2Count > 0 ? "WARN" : "FAIL";
  auditRow(
    headingStatus,
    "Content Structure (H2 & H3 Subheadings)",
    lead.h2Count < 2
      ? `Only ${lead.h2Count} H2 subheadings found. Well-organised content with clear sections (like a well-written article) consistently outranks walls of text. Google uses subheadings to understand the range of topics on a page — fewer subheadings means fewer ranking opportunities.`
      : `Good heading structure with ${lead.h2Count} H2 and ${lead.h3Count} H3 subheadings. This helps Google index the range of services and topics covered.`,
    `${lead.h2Count} H2s · ${lead.h3Count} H3s`
  );

  // Images
  const altStatus = lead.imagesTotal === 0 ? "WARN"
    : lead.imagesWithAlt === lead.imagesTotal ? "PASS"
    : lead.imagesWithAlt >= lead.imagesTotal * 0.7 ? "WARN" : "FAIL";
  auditRow(
    altStatus,
    "Image Alt Text",
    lead.imagesTotal === 0
      ? "No images were found on the page. Images with descriptive alt text help Google understand your content and can bring in traffic through Google Image Search."
      : lead.imagesWithAlt === lead.imagesTotal
        ? "All images have descriptive alt text — Google can read and rank these images."
        : `${lead.imagesTotal - lead.imagesWithAlt} of ${lead.imagesTotal} images have no alt text. Images are invisible to Google without descriptions — this is a missed SEO opportunity. It also makes the site inaccessible to visually impaired users.`,
    lead.imagesTotal > 0 ? `${lead.imagesWithAlt}/${lead.imagesTotal} images` : "None found"
  );

  // Word count
  const wordStatus = lead.wordCount >= 600 ? "PASS" : lead.wordCount >= 300 ? "WARN" : "FAIL";
  auditRow(
    wordStatus,
    "Content Volume (Word Count)",
    lead.wordCount < 300
      ? `The homepage has only ~${lead.wordCount} words — this is very thin content. Google needs enough text to understand what the business does, where it operates, and who it serves. Pages with thin content rarely rank on page 1. Competitors with 500–1000 words of relevant content will consistently outrank this site.`
      : lead.wordCount < 600
        ? `~${lead.wordCount} words is acceptable but on the lighter side. Adding more detail about services, location, and customer benefits would strengthen rankings.`
        : `Good content volume at ~${lead.wordCount} words. More content gives Google more signals and more ways to match this page to searches.`,
    `~${lead.wordCount} words`
  );

  // Internal links
  const linkStatus = lead.internalLinks >= 5 ? "PASS" : lead.internalLinks >= 2 ? "WARN" : "FAIL";
  auditRow(
    linkStatus,
    "Internal Links (Links Between Pages)",
    lead.internalLinks < 3
      ? `Only ${lead.internalLinks} internal link${lead.internalLinks !== 1 ? "s" : ""} found. Internal links are the roads Google follows to discover and rank every page on the site. Without them, pages like the Services page, Contact page, and About page may never be properly indexed — they exist but Google can't find them.`
      : `${lead.internalLinks} internal links found. Good site structure helps Google crawl every page and distributes ranking authority across the site.`,
    `${lead.internalLinks} links`
  );

  // ── Technical SEO ──
  section("Technical SEO Findings", "Behind-the-scenes settings that affect whether Google can access, understand, and rank this site.");

  // Sitemap
  auditRow(
    lead.sitemapFound ? "PASS" : "FAIL",
    "XML Sitemap (/sitemap.xml)",
    lead.sitemapFound
      ? "A sitemap was found. This is a direct list of every page on the site given to Google — it ensures nothing gets missed."
      : "No XML sitemap found. A sitemap is essentially a map that tells Google every page this site has. Without one, Google has to discover pages by following links — and may never find newer or less-linked pages. Any service page or location page that isn't in a sitemap may never rank.",
    lead.sitemapFound ? "Found ✓" : "Missing"
  );

  auditRow(
    lead.robotsTxtFound ? "PASS" : "WARN",
    "Robots.txt File",
    lead.robotsTxtFound
      ? "Robots.txt file is present, directing how search engines should crawl the site."
      : "No robots.txt file found. While not critical, this file gives Google instructions on how to crawl the site efficiently. Its absence can lead to Google wasting time on unimportant pages instead of indexing key ones.",
    lead.robotsTxtFound ? "Found ✓" : "Missing"
  );

  auditRow(
    lead.hasViewport ? "PASS" : "FAIL",
    "Mobile Viewport Meta Tag",
    lead.hasViewport
      ? "Viewport tag is present — the site is configured to display correctly on mobile devices."
      : "No mobile viewport tag found. Without this, the site will appear as a tiny, zoomed-out desktop page on a mobile phone. Since over 65% of local business searches happen on mobile, this is likely causing visitors to leave immediately without contacting the business.",
    lead.hasViewport ? "Present ✓" : "Missing"
  );

  auditRow(
    lead.hasSchema ? "PASS" : "WARN",
    "Schema Markup (Structured Data)",
    lead.hasSchema
      ? "Schema markup detected. This tells Google this is a local business — enabling rich results like star ratings, opening hours, and contact details to appear directly in Google search results."
      : "No schema markup found. Schema is invisible code that tells Google 'this is a local business with these services, hours, and location.' With schema, businesses can appear with rich snippets in search results — star ratings, phone numbers, business hours — all visible before anyone clicks. Without it, this business appears as a plain blue link while competitors may show rich info.",
    lead.hasSchema ? "Detected ✓" : "Not found"
  );

  auditRow(
    lead.hasCanonical ? "PASS" : "WARN",
    "Canonical Tags",
    lead.hasCanonical
      ? "Canonical tags are present — preventing duplicate content issues that could split ranking authority."
      : "No canonical tags found. Without these, Google may discover and index multiple versions of the same page (e.g. http vs https, www vs non-www, or with and without trailing slashes). This splits the ranking power between versions, weakening all of them — instead of one strong page, there are several weak versions competing against each other.",
    lead.hasCanonical ? "Present ✓" : "Missing"
  );

  auditRow(
    lead.hasOgTags ? "PASS" : "WARN",
    "Open Graph / Social Preview Tags",
    lead.hasOgTags
      ? "Open Graph tags are present. When this site is shared on Facebook, WhatsApp, or Instagram, it shows a proper image, title, and description preview."
      : "No Open Graph tags found. When someone shares this website on WhatsApp, Facebook, or Instagram, it appears as a plain, unformatted link with no image, no title, and no description — it looks like a spam link. OG tags make shared links look professional and get far more clicks.",
    lead.hasOgTags ? "Present ✓" : "Missing"
  );

  // ── PageSpeed issues ──
  if (lead.issues && lead.issues.length) {
    const psExplain = {
      "No SSL / HTTPS": "Browsers actively warn visitors with a 'Not Secure' label. Many people will not proceed past this warning.",
      "Missing meta description": "Google picks random text to show under this site in search results — usually something unhelpful that reduces clicks.",
      "Missing or poor page title": "Without a clear title, Google doesn't know what to rank this page for.",
      "Images missing alt text": "Google cannot read images without descriptions — missed SEO and accessibility opportunity.",
      "Poor link anchor text": "Vague link text like 'click here' tells Google nothing. Descriptive links pass context and ranking signals.",
      "Tap targets too small on mobile": "Buttons and links are too close together on phones — visitors accidentally tap the wrong thing and leave.",
      "Text too small to read on mobile": "If visitors need to pinch-zoom to read text on their phone, they will leave. Mobile readability is a confirmed ranking factor.",
      "No mobile viewport meta tag": "The site appears broken on mobile phones — extremely damaging given how many local searches happen on phones.",
      "Render-blocking resources slowing load": "CSS or JavaScript files are forcing the page to pause before displaying anything — visitors see a blank screen longer than necessary.",
      "Images not compressed/optimized": "Oversized image files are a leading cause of slow load times — directly reducing the mobile speed score Google measures.",
      "Images not in modern format (WebP/AVIF)": "Older image formats (JPEG/PNG) are 2-5x larger than modern formats. Switching reduces page size and improves speed score.",
      "Unused CSS adding page weight": "Stylesheet code that isn't used on this page is still being downloaded, slowing the site for no reason.",
      "Unused JavaScript adding page weight": "JavaScript that isn't needed on this page is loading anyway — a common cause of slow, unresponsive pages.",
      "No Gzip/Brotli text compression": "The server is sending full-size text files instead of compressed versions. Compression can reduce file sizes by 60-80%, significantly speeding up load times.",
      "Slow server response time (TTFB)": "The server itself is responding slowly before any content is even sent to the visitor's browser — often a hosting issue.",
      "Server response time too high": "The web server is taking too long to respond to requests — every visitor experiences this delay before seeing anything.",
      "DOM too large — too many HTML elements": "The page has too many HTML elements, making it slow to render and respond to clicks. Often caused by bloated page builders.",
      "Animated GIFs — should be video": "Animated GIF files are extremely large. Converting them to video format (MP4/WebM) can reduce file size by over 90%.",
    };
    section("Speed & Performance Issues", "Specific problems identified by Google's tools that are slowing this site down and hurting its ranking.");
    lead.issues.forEach(issue => {
      const explain = psExplain[issue.label] || "";
      auditRow("FAIL", issue.label, explain + (issue.detail ? `  Measured: ${issue.detail}` : ""));
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PAGE 3 — ACTION PLAN
  // ════════════════════════════════════════════════════════════════════════════
  doc.addPage();

  // Header
  doc.rect(0, 0, W, 70).fill(DARK);
  doc.rect(0, 0, 5, 70).fill(BLUE);
  doc.fillColor(BLUE).fontSize(7.5).font("Helvetica-Bold")
    .text("PRIORITY ACTION PLAN", ML, 18, { characterSpacing: 1.4 });
  doc.fillColor(WHITE).fontSize(15).font("Helvetica-Bold")
    .text("What Needs to Be Fixed — In Order of Urgency", ML, 32);
  doc.fillColor([148, 163, 184]).fontSize(8).font("Helvetica")
    .text("Issues are ranked by how directly they are costing this business Google rankings and customers.", ML, 54);
  doc.y = 84;

  const recs = [
    !lead.hasSSL && {
      sev: "CRITICAL", title: "Install an SSL Certificate (HTTPS)",
      why: "Every single visitor sees a 'Not Secure' browser warning. Google confirms SSL as a ranking factor. This is costing rankings AND customer trust simultaneously. Free SSL certificates (Let's Encrypt) are available for almost all web hosts.",
    },
    !lead.hasViewport && {
      sev: "CRITICAL", title: "Add a Mobile Viewport Meta Tag",
      why: "Without this one line of code, the site displays as a tiny desktop page on every phone. Since over 65% of local service searches happen on mobile, this is likely the single biggest source of lost enquiries.",
    },
    !lead.hasH1 && {
      sev: "HIGH", title: "Add an H1 Heading to the Homepage",
      why: "The homepage needs a clear headline that includes the main service and city (e.g. 'Professional Plumber in Lagos'). This is one of the strongest signals Google uses to decide what searches to show this site for.",
    },
    lead.metaDescLength === 0 && {
      sev: "HIGH", title: "Write a Meta Description for Every Page",
      why: "Right now, Google is generating random preview text for this site in search results. A compelling 120-160 character description is the difference between someone clicking this result or the one above it.",
    },
    !lead.sitemapFound && {
      sev: "HIGH", title: "Create and Submit an XML Sitemap",
      why: "Service pages, location pages, and contact pages may never get indexed because Google can't find them. A sitemap takes 30 minutes to create and ensures every page gets submitted to Google Search Console.",
    },
    (lead.metaTitleLength === 0 || lead.metaTitleLength < 30 || lead.metaTitleLength > 60) && {
      sev: "HIGH", title: `Fix the Page Title Tag${lead.metaTitleLength > 0 ? ` (currently ${lead.metaTitleLength} chars)` : " (missing)"}`,
      why: "The title is what appears as the clickable blue link in Google results. It should be 30-60 characters, include the main service keyword, and mention the city. A well-crafted title alone can significantly improve click-through rates.",
    },
    lead.wordCount < 300 && {
      sev: "HIGH", title: `Increase Homepage Content (currently ~${lead.wordCount} words)`,
      why: "Google needs enough content to understand what this business does, which areas it serves, and why customers should choose them. Pages with less than 400 words of relevant content rarely rank on page 1 — there simply isn't enough for Google to work with.",
    },
    lead.mobileScore < 50 && {
      sev: "HIGH", title: `Improve Mobile Page Speed (score: ${lead.mobileScore}/100)`,
      why: "A mobile score below 50 means the site is significantly slower than competitors. Google uses mobile speed as a ranking signal. Quick wins: compress images, remove unused plugins/scripts, enable browser caching, and use Gzip compression.",
    },
    !lead.hasSchema && {
      sev: "MEDIUM", title: "Add LocalBusiness Schema Markup",
      why: "Schema markup tells Google this is a real local business with a physical location, opening hours, and contact details. With it, this site becomes eligible for rich results in Google — star ratings, phone numbers, and hours visible directly in search without needing a click.",
    },
    lead.h2Count < 2 && {
      sev: "MEDIUM", title: "Improve Heading Structure (H2 and H3 Tags)",
      why: "Each service, service area, and customer benefit should have its own subheading. This makes the content easy to read for visitors and tells Google exactly what topics the page covers — each subheading is an additional ranking opportunity.",
    },
    !lead.hasCanonical && {
      sev: "MEDIUM", title: "Add Canonical Tags to Prevent Duplicate Content",
      why: "Without canonical tags, Google may be indexing multiple versions of the same page and splitting ranking power between them. Adding canonical tags consolidates this into a single, authoritative version that ranks better.",
    },
    lead.imagesWithAlt < lead.imagesTotal && {
      sev: "MEDIUM", title: `Add Alt Text to ${lead.imagesTotal - lead.imagesWithAlt} Image(s)`,
      why: "Every image without alt text is invisible to Google. Descriptive alt text (e.g. 'interior of Lagos hair salon') helps Google understand the images, improves accessibility for visually impaired visitors, and creates additional ranking signals.",
    },
    lead.internalLinks < 3 && {
      sev: "MEDIUM", title: "Add Internal Links Between Pages",
      why: "Internal links act as pathways for Google to discover and crawl every page on the site. Without them, important pages may be effectively invisible to Google. Every page should link to at least 2-3 other relevant pages.",
    },
    !lead.hasOgTags && {
      sev: "LOW", title: "Add Open Graph Tags for Social Media Sharing",
      why: "When someone shares this business's website on WhatsApp or Facebook, it currently appears as a plain link with no image or preview. Open Graph tags make it display like a professional card with an image, business name, and description — significantly more likely to be clicked.",
    },
  ].filter(Boolean);

  const sevColor = { CRITICAL: FAIL, HIGH: WARN, MEDIUM: BLUE, LOW: [148, 163, 184] };
  const sevW = { CRITICAL: 52, HIGH: 32, MEDIUM: 48, LOW: 28 };

  recs.slice(0, 12).forEach((rec, i) => {
    pageCheck(55);
    const y = doc.y;
    const [r, g, b] = sevColor[rec.sev] || BLUE;
    const sw = sevW[rec.sev] || 40;
    // Number circle
    doc.circle(ML + 9, y + 9, 9).fill([r, g, b]);
    doc.fillColor(WHITE).fontSize(7.5).font("Helvetica-Bold")
      .text(String(i + 1), ML, y + 5, { width: 18, align: "center" });
    // Severity badge
    doc.roundedRect(ML + 22, y + 2, sw, 14, 3).fill([r, g, b]);
    doc.fillColor(WHITE).fontSize(6.5).font("Helvetica-Bold")
      .text(rec.sev, ML + 22, y + 5, { width: sw, align: "center" });
    // Title
    doc.fillColor(DARK).fontSize(9).font("Helvetica-Bold")
      .text(rec.title, ML + 22 + sw + 8, y + 3, { width: CW - 22 - sw - 8 });
    doc.y = Math.max(doc.y, y + 20);
    // Why it matters
    doc.fillColor(MID).fontSize(8).font("Helvetica")
      .text(rec.why, ML + 22, doc.y, { width: CW - 22 });
    doc.moveDown(0.8);
    // Divider
    if (i < recs.length - 1) {
      pageCheck(10);
      doc.rect(ML + 22, doc.y, CW - 22, 0.5).fill([226, 232, 240]);
      doc.moveDown(0.5);
    }
  });

  // ── Contact info ──
  if (lead.emails.length || lead.phones.length || lead.facebookUrl) {
    pageCheck(60);
    doc.moveDown(0.8);
    section("Contact Details Found During Audit");
    if (lead.emails.length) {
      doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold").text("Email:", ML, doc.y, { continued: true });
      doc.fillColor(BLUE).font("Helvetica").text("  " + lead.emails.join("  ·  "));
    }
    if (lead.phones.length) {
      doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold").text("Phone:", ML, doc.y, { continued: true });
      doc.fillColor(MID).font("Helvetica").text("  " + lead.phones.slice(0,3).join("  ·  "));
    }
    if (lead.facebookUrl) {
      doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold").text("Facebook:", ML, doc.y, { continued: true });
      doc.fillColor([59, 130, 246]).font("Helvetica").text("  " + lead.facebookUrl);
    }
    doc.moveDown(0.5);
  }

  // ── CTA footer block ──
  pageCheck(70);
  doc.moveDown(1);
  const ctaY = doc.y;
  const ctaText =
    "This audit was prepared to show the specific, fixable reasons why this business is not showing up on Google page 1. " +
    "Every issue listed above has a solution — and fixing even the top 3 items typically produces a measurable improvement in rankings within 30–60 days. " +
    "If you would like help fixing these issues or would like to discuss a redesign, reply to the email that accompanied this report.";
  callout(ML, ctaY, CW, 14 + Math.ceil(ctaText.length / 90) * 11 + 10, [30, 41, 59], ctaText);

  // ── Footers on all pages ──
  footer();
  doc.end();
}

// ── Main job runner ──────────────────────────────────────────────────────────
async function runJob(jobId, query, startPage, endPage, aiKey, aiProvider, aiModel) {
  const job = jobs[jobId];
  job.status = "searching";
  job.log(`Searching Google pages ${startPage}–${endPage} for: ${query}`);

  const serperResults = await searchGoogle(query, startPage, endPage);
  job.log(`Found ${serperResults.length} URLs across pages ${startPage}–${endPage}`);
  job.totalFound = serperResults.length;

  const leads = [];
  const CONCURRENCY = 3;

  // Filter out directories before auditing
  const targets = serperResults.filter(r => {
    if (shouldSkip(r.url)) {
      job.log(`Skipped (directory): ${r.url}`);
      return false;
    }
    return true;
  });
  job.totalFound = targets.length;
  job.crawled = 0;
  job.log(`${targets.length} business sites to crawl (${serperResults.length - targets.length} directories removed)`);

  // Audit in parallel batches of CONCURRENCY
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    job.status = "auditing";

    await Promise.all(batch.map(async (r, bi) => {
      const idx = i + bi + 1;
      job.log(`[${idx}/${targets.length}] Crawling: ${r.url}`);

      // Step 1: crawl for email first
      const crawl = await crawlSite(r.url);
      job.crawled++;

      // Step 2: only run PageSpeed if we found an email (saves API quota)
      const hasEmail = crawl.emails.length > 0;
      const emailSrc = hasEmail ? (crawl.emailSource === 'facebook' ? `Email via Facebook: ${crawl.emails[0]}` : `Email: ${crawl.emails[0]}`) : 'No email — skipping PageSpeed';
      job.log(`  ↳ [${idx}] ${emailSrc}`);
      const pageSpeed = hasEmail ? await runPageSpeed(r.url) : null;

      const ps = pageSpeed || {
        mobileScore: 0, desktopScore: 0, seoScore: 0, accessibilityScore: 0,
        lcp: 'N/A', tbt: 'N/A', cls: 'N/A', fcp: 'N/A', tti: 'N/A',
        hasSSL: r.url.startsWith('https'), issues: [], issueLabels: [],
      };
      if (!pageSpeed) job.log(`  ↳ [${idx}] PageSpeed unavailable — saved with basic data`);

      crawl.googlePage = r.page;
      const { seoPitch, designPitch } = await generatePitches(r.title, r.url, crawl, ps, query, aiKey, aiProvider, aiModel);

      leads.push({
        title: r.title,
        url: r.url,
        googlePage: r.page,
        snippet: r.snippet,
        // Performance
        mobileScore: ps.mobileScore,
        desktopScore: ps.desktopScore,
        seoScore: ps.seoScore,
        accessibilityScore: ps.accessibilityScore,
        loadTime: ps.tti,
        lcp: ps.lcp, tbt: ps.tbt, fcp: ps.fcp, tti: ps.tti, cls: ps.cls,
        hasSSL: ps.hasSSL,
        issues: ps.issues,
        issueLabels: ps.issueLabels,
        // Content signals
        pageTitle: crawl.pageTitle,
        metaTitleLength: crawl.metaTitleLength,
        metaDesc: crawl.metaDesc,
        metaDescLength: crawl.metaDescLength,
        hasH1: crawl.hasH1, h1Text: crawl.h1Text, h1Count: crawl.h1Count,
        h2Count: crawl.h2Count, h3Count: crawl.h3Count,
        imagesTotal: crawl.imagesTotal, imagesWithAlt: crawl.imagesWithAlt,
        wordCount: crawl.wordCount,
        internalLinks: crawl.internalLinks,
        hasSchema: crawl.hasSchema,
        hasCanonical: crawl.hasCanonical,
        hasOgTags: crawl.hasOgTags,
        hasViewport: crawl.hasViewport,
        sitemapFound: crawl.sitemapFound,
        robotsTxtFound: crawl.robotsTxtFound,
        // Contact
        emails: crawl.emails,
        phones: crawl.phones,
        facebookUrl: crawl.facebookUrl || null,
        emailSource: crawl.emailSource || "website",
        seoPitch,
        designPitch,
      });

      job.log(`  ↳ [${idx}] Mobile: ${ps.mobileScore}/100 · SEO: ${ps.seoScore}/100 · ${crawl.emails.length ? 'Email: ' + crawl.emails[0] : 'No email'}`);
      job.leads = [...leads];
    }));
  }

  job.status = "done";
  job.leads = leads;
  const withEmail = leads.filter(l => l.emails.length).length;
  job.log(`✓ Done — ${leads.length} leads audited · ${withEmail} with email · ${leads.length - withEmail} without`);
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get("/api/ping", (req, res) => res.json({ ok: true, ts: Date.now() }));

// Verify a user-supplied AI key with a minimal test call
app.post("/api/verify-key", async (req, res) => {
  const { provider, key, model } = req.body;
  if (!key) return res.status(400).json({ ok: false, error: "No key provided" });

  // Use the safest/most universally available model per provider for the test
  const testModels = {
    openai: ["gpt-4o-mini", "gpt-3.5-turbo"],
    openrouter: ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5"],
    anthropic: ["claude-haiku-4-5-20251001", "claude-3-haiku-20240307"],
  };
  const modelsToTry = testModels[provider] || testModels.anthropic;

  for (const testModel of modelsToTry) {
    try {
      if (provider === "openai") {
        const resp = await axios.post("https://api.openai.com/v1/chat/completions", {
          model: testModel, max_tokens: 5,
          messages: [{ role: "user", content: "hi" }],
        }, {
          headers: { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json" },
          timeout: 25000,
        });
        // Success — also verify the user's chosen model exists by listing models
        return res.json({ ok: true, model: testModel });
      } else if (provider === "openrouter") {
        await axios.post("https://openrouter.ai/api/v1/chat/completions", {
          model: testModel, max_tokens: 5,
          messages: [{ role: "user", content: "hi" }],
        }, {
          headers: {
            Authorization: `Bearer ${key.trim()}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://zaram.app",
            "X-Title": "Zaram SEO PitchReady",
          },
          timeout: 25000,
        });
        return res.json({ ok: true, model: testModel });
      } else {
        const client = new Anthropic({ apiKey: key.trim() });
        await client.messages.create({
          model: testModel, max_tokens: 5,
          messages: [{ role: "user", content: "hi" }],
        });
        return res.json({ ok: true, model: testModel });
      }
    } catch (e) {
      const status = e.response?.status;
      const msg = e.response?.data?.error?.message || e.message;
      console.error(`verify-key [${provider}/${testModel}] ${status}: ${msg}`);
      // 401 = bad key — no point trying other models
      if (status === 401 || status === 403) {
        return res.json({ ok: false, error: `Invalid API key — ${msg}` });
      }
      // 404 = model not found — try next model
      if (status === 404) continue;
      // Any other error on last model
      if (testModel === modelsToTry[modelsToTry.length - 1]) {
        return res.json({ ok: false, error: msg || "Could not reach AI provider — check your connection" });
      }
    }
  }
  res.json({ ok: false, error: "All test models failed — key may have restricted access" });
});

app.post("/api/search", (req, res) => {
  const { query, startPage = 3, endPage = 10 } = req.body;
  if (!query) return res.status(400).json({ error: "query is required" });

  const aiKey = req.headers["x-ai-key"] || "";
  const aiProvider = req.headers["x-ai-provider"] || "anthropic";
  const aiModel = req.headers["x-ai-model"] || "";

  const jobId = uuidv4();
  const logs = [];
  jobs[jobId] = {
    id: jobId, status: "starting", query, startPage, endPage,
    leads: [], totalFound: 0, logs,
    log: (msg) => { logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`); console.log(msg); },
    startedAt: new Date().toISOString(),
  };

  runJob(jobId, query, startPage, endPage, aiKey, aiProvider, aiModel).catch((e) => {
    jobs[jobId].status = "error";
    jobs[jobId].log("Fatal error: " + e.message);
  });

  res.json({ jobId });
});

app.get("/api/job/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({
    id: job.id, status: job.status, query: job.query,
    totalFound: job.totalFound,
    crawled: job.crawled || 0,
    leadsReady: job.leads.length,
    logs: job.logs.slice(-20), leads: job.leads, startedAt: job.startedAt,
  });
});

app.get("/api/job/:id/lead/:idx/pdf", (req, res) => {
  const job = jobs[req.params.id];
  const lead = job?.leads[parseInt(req.params.idx)];
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  try {
    generatePDF(lead, res);
  } catch (e) {
    console.error("PDF error:", e.message);
    res.status(500).json({ error: "PDF generation failed" });
  }
});

app.get("/api/job/:id/csv", (req, res) => {
  const job = jobs[req.params.id];
  if (!job || !job.leads.length) return res.status(404).json({ error: "No leads" });

  const headers = ["title","url","googlePage","mobileScore","desktopScore","seoScore","accessibilityScore","loadTime","lcp","cls","hasSSL","issueCount","issues","emails","phones","seoPitch","designPitch"];
  const rows = job.leads.map((l) => [
    `"${l.title}"`, l.url, l.googlePage,
    l.mobileScore, l.desktopScore, l.seoScore, l.accessibilityScore,
    l.loadTime, l.lcp, l.cls, l.hasSSL,
    l.issueLabels.length, `"${l.issueLabels.join("; ")}"`,
    `"${l.emails.join(", ")}"`, `"${l.phones.join(", ")}"`,
    `"${(l.seoPitch || "").replace(/"/g, "'")}"`,
    `"${(l.designPitch || "").replace(/"/g, "'")}"`,
  ].join(","));

  const csv = [headers.join(","), ...rows].join("\n");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${job.query.replace(/\s+/g, "-")}.csv"`);
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Zaram SEO PitchReady backend on http://localhost:${PORT}`));
