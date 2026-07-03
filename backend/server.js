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
  const doc = new PDFDocument({ margin: 50, size: "A4", autoFirstPage: true });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="audit-${new URL(lead.url).hostname}.pdf"`);
  doc.pipe(res);

  // ── Helpers ──
  const PASS  = [34, 197, 94];
  const WARN  = [251, 146, 60];
  const FAIL  = [239, 68, 68];
  const INFO  = [99, 102, 241];
  const DARK  = [15, 23, 42];
  const MID   = [51, 65, 85];
  const LIGHT = [100, 116, 139];

  const scoreColor = (s) => s >= 70 ? PASS : s >= 40 ? WARN : FAIL;

  const pageCheck = () => {
    if (doc.y > 720) { doc.addPage(); }
  };

  const section = (title) => {
    pageCheck();
    doc.moveDown(0.6);
    doc.rect(50, doc.y, 495, 20).fill([241, 245, 249]);
    doc.fillColor(DARK).fontSize(9).font("Helvetica-Bold")
      .text(title.toUpperCase(), 56, doc.y - 15, { characterSpacing: 0.8 });
    doc.moveDown(0.8);
  };

  // Status icon: PASS / WARN / FAIL
  const statusTag = (x, y, status) => {
    const colors = { PASS, WARN, FAIL };
    const labels = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL" };
    const [r, g, b] = colors[status] || INFO;
    doc.roundedRect(x, y, 34, 12, 3).fill([r, g, b]);
    doc.fillColor([255,255,255]).fontSize(6.5).font("Helvetica-Bold")
      .text(labels[status], x, y + 2.5, { width: 34, align: "center" });
  };

  // Checklist row
  const checkRow = (label, status, value, note, indent = 50) => {
    pageCheck();
    const y = doc.y;
    statusTag(indent, y, status);
    doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold")
      .text(label, indent + 42, y, { width: 200 });
    if (value) {
      doc.fillColor(MID).fontSize(8).font("Helvetica")
        .text(value, indent + 248, y, { width: 180, align: "right" });
    }
    if (note) {
      doc.fillColor(LIGHT).fontSize(7.5).font("Helvetica")
        .text(note, indent + 42, doc.y, { width: 380 });
    }
    doc.moveDown(note ? 0.55 : 0.45);
  };

  // Score box
  const drawScore = (x, y, label, score) => {
    const [r, g, b] = scoreColor(score);
    doc.roundedRect(x, y, 112, 58, 6).fill([r, g, b, 0.08]);
    doc.roundedRect(x, y, 112, 58, 6).strokeColor([r, g, b]).lineWidth(1.5).stroke();
    doc.fillColor([r, g, b]).fontSize(24).font("Helvetica-Bold")
      .text(score > 0 ? score : "N/A", x, y + 9, { width: 112, align: "center" });
    doc.fillColor(LIGHT).fontSize(7.5).font("Helvetica")
      .text(label, x, y + 40, { width: 112, align: "center" });
  };

  // ── PAGE 1: HEADER ──────────────────────────────────────────────────────────
  doc.rect(0, 0, 595, 100).fill(DARK);
  // accent stripe
  doc.rect(0, 0, 6, 100).fill(INFO);

  doc.fillColor(INFO).fontSize(8).font("Helvetica-Bold")
    .text("ZARAM SEO PITCHREADY  ·  WEBSITE AUDIT REPORT", 20, 20, { characterSpacing: 1.5 });

  const titleStr = (lead.title || lead.url).slice(0, 65);
  doc.fillColor([255,255,255]).fontSize(17).font("Helvetica-Bold")
    .text(titleStr, 20, 34);

  doc.fillColor([148, 163, 184]).fontSize(8.5).font("Helvetica")
    .text(lead.url, 20, 58);

  const ctrMap = { 1:"~28%", 2:"~6%", 3:"~3%", 4:"~2%", 5:"~1.5%" };
  const ctr = ctrMap[lead.googlePage] || "<1%";
  doc.fillColor([167, 139, 250]).fontSize(8.5).font("Helvetica-Bold")
    .text(`Found on Google PAGE ${lead.googlePage}  ·  Estimated click share: ${ctr}  ·  Audit: ${new Date().toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" })}`,
      20, 74, { characterSpacing: 0.3 });

  doc.y = 118;

  // ── OVERALL SCORE SUMMARY ────────────────────────────────────────────────────
  // Count total checks passed
  const checks = [
    lead.hasSSL, lead.hasH1, lead.metaDescLength > 0, lead.metaTitleLength >= 30 && lead.metaTitleLength <= 60,
    lead.sitemapFound, lead.robotsTxtFound, lead.hasCanonical, lead.hasSchema, lead.hasViewport, lead.hasOgTags,
    lead.h2Count > 0, lead.imagesWithAlt === lead.imagesTotal && lead.imagesTotal > 0,
    lead.wordCount >= 300, lead.internalLinks >= 3,
    lead.mobileScore >= 70, lead.seoScore >= 70,
  ];
  const passed = checks.filter(Boolean).length;
  const total = checks.length;
  const grade = passed >= 14 ? "A" : passed >= 11 ? "B" : passed >= 8 ? "C" : passed >= 5 ? "D" : "F";
  const gradeColor = passed >= 14 ? PASS : passed >= 11 ? WARN : FAIL;

  // Grade box
  doc.roundedRect(50, doc.y, 80, 70, 8).fill(gradeColor);
  doc.fillColor([255,255,255]).fontSize(36).font("Helvetica-Bold")
    .text(grade, 50, doc.y + 10, { width: 80, align: "center" });
  doc.fillColor([255,255,255]).fontSize(7.5).font("Helvetica")
    .text("OVERALL GRADE", 50, doc.y + 50, { width: 80, align: "center" });

  const summY = doc.y;
  doc.fillColor(DARK).fontSize(10).font("Helvetica-Bold")
    .text(`${passed} of ${total} checks passed`, 145, summY + 8);
  doc.fillColor(LIGHT).fontSize(8.5).font("Helvetica")
    .text(`This site has ${total - passed} issue${total - passed !== 1 ? "s" : ""} that need attention to improve its Google ranking.`, 145, summY + 26, { width: 350 });

  // mini bar
  const barX = 145, barY = summY + 48, barW = 350;
  doc.roundedRect(barX, barY, barW, 8, 4).fill([226,232,240]);
  doc.roundedRect(barX, barY, Math.round(barW * passed / total), 8, 4).fill(gradeColor);

  doc.y = summY + 80;

  // ── PERFORMANCE SCORES ───────────────────────────────────────────────────────
  section("Performance Scores  (Google PageSpeed Insights)");
  const sy = doc.y;
  drawScore(50,  sy, "Mobile Speed",  lead.mobileScore  || 0);
  drawScore(172, sy, "Desktop Speed", lead.desktopScore || 0);
  drawScore(294, sy, "SEO Score",     lead.seoScore     || 0);
  drawScore(416, sy, "Accessibility", lead.accessibilityScore || 0);
  doc.y = sy + 68;

  // ── CORE WEB VITALS ──────────────────────────────────────────────────────────
  section("Core Web Vitals");
  const vitals = [
    ["Largest Contentful Paint (LCP)", lead.lcp, "< 2.5s is good", !lead.lcp || lead.lcp === "N/A" ? "WARN" : parseFloat(lead.lcp) <= 2.5 ? "PASS" : parseFloat(lead.lcp) <= 4 ? "WARN" : "FAIL"],
    ["First Contentful Paint (FCP)",   lead.fcp, "< 1.8s is good", !lead.fcp || lead.fcp === "N/A" ? "WARN" : parseFloat(lead.fcp) <= 1.8 ? "PASS" : parseFloat(lead.fcp) <= 3 ? "WARN" : "FAIL"],
    ["Total Blocking Time (TBT)",      lead.tbt, "< 200ms is good", !lead.tbt || lead.tbt === "N/A" ? "WARN" : parseInt(lead.tbt) <= 200 ? "PASS" : parseInt(lead.tbt) <= 600 ? "WARN" : "FAIL"],
    ["Cumulative Layout Shift (CLS)",  lead.cls, "< 0.1 is good",  !lead.cls || lead.cls === "N/A" ? "WARN" : parseFloat(lead.cls) <= 0.1 ? "PASS" : parseFloat(lead.cls) <= 0.25 ? "WARN" : "FAIL"],
    ["Time to Interactive (TTI)",      lead.tti, "< 3.8s is good", !lead.tti || lead.tti === "N/A" ? "WARN" : parseFloat(lead.tti) <= 3.8 ? "PASS" : parseFloat(lead.tti) <= 7.3 ? "WARN" : "FAIL"],
  ];
  vitals.forEach(([name, val, note, status]) => {
    checkRow(name, status, val || "N/A", note);
  });

  // ── ON-PAGE SEO CHECKLIST ────────────────────────────────────────────────────
  doc.addPage();
  section("On-Page SEO Checklist");

  // SSL
  checkRow("SSL / HTTPS", lead.hasSSL ? "PASS" : "FAIL",
    lead.hasSSL ? "Secure" : "NOT SECURE",
    lead.hasSSL ? "Site is served over HTTPS" : "Site is HTTP — Google marks it insecure and demotes it in rankings");

  // Page Title
  const titleStatus = lead.metaTitleLength >= 30 && lead.metaTitleLength <= 60 ? "PASS"
    : lead.metaTitleLength > 0 ? "WARN" : "FAIL";
  checkRow("Page Title (meta title)", titleStatus,
    lead.metaTitleLength > 0 ? `${lead.metaTitleLength} chars` : "Missing",
    lead.pageTitle ? `"${lead.pageTitle.slice(0, 70)}"` : "No title tag found — critical for rankings and click-through rate");

  // Meta Description
  const descStatus = lead.metaDescLength >= 120 && lead.metaDescLength <= 160 ? "PASS"
    : lead.metaDescLength > 0 ? "WARN" : "FAIL";
  checkRow("Meta Description", descStatus,
    lead.metaDescLength > 0 ? `${lead.metaDescLength} chars` : "Missing",
    lead.metaDesc ? `"${lead.metaDesc.slice(0, 100)}${lead.metaDesc.length > 100 ? "…" : ""}"` : "No meta description — affects how the site appears in Google results");

  // H1
  const h1Status = lead.h1Count === 1 ? "PASS" : lead.h1Count > 1 ? "WARN" : "FAIL";
  checkRow("H1 Heading", h1Status,
    lead.h1Count > 0 ? `${lead.h1Count} found` : "Missing",
    lead.h1Text ? `"${lead.h1Text}"` : "No H1 heading on homepage — Google uses this as the main topic signal");

  // H2/H3
  const headingStatus = lead.h2Count >= 2 ? "PASS" : lead.h2Count > 0 ? "WARN" : "FAIL";
  checkRow("Heading Structure (H2/H3)", headingStatus,
    `${lead.h2Count} H2s, ${lead.h3Count} H3s`,
    lead.h2Count < 2 ? "Too few subheadings — content is hard to read and harder for Google to understand" : "Good heading structure helps Google index content topics");

  // Images alt
  const altStatus = lead.imagesTotal === 0 ? "WARN"
    : lead.imagesWithAlt === lead.imagesTotal ? "PASS"
    : lead.imagesWithAlt >= lead.imagesTotal * 0.7 ? "WARN" : "FAIL";
  checkRow("Image Alt Text", altStatus,
    lead.imagesTotal > 0 ? `${lead.imagesWithAlt} of ${lead.imagesTotal} images` : "No images found",
    lead.imagesWithAlt < lead.imagesTotal ? `${lead.imagesTotal - lead.imagesWithAlt} image(s) have no alt text — missed SEO signal and fails accessibility` : "All images have alt text");

  // Word count
  const wordStatus = lead.wordCount >= 600 ? "PASS" : lead.wordCount >= 300 ? "WARN" : "FAIL";
  checkRow("Homepage Word Count", wordStatus,
    `~${lead.wordCount} words`,
    lead.wordCount < 300 ? "Very thin content — Google needs enough text to understand what the page is about (aim for 400+ words)"
    : lead.wordCount < 600 ? "Acceptable but light — more relevant content helps rankings" : "Good content depth");

  // Internal links
  const linkStatus = lead.internalLinks >= 5 ? "PASS" : lead.internalLinks >= 2 ? "WARN" : "FAIL";
  checkRow("Internal Links", linkStatus,
    `${lead.internalLinks} internal links`,
    lead.internalLinks < 3 ? "Very few internal links — site structure is poor, Google struggles to crawl and rank all pages" : "Helps Google crawl the site and distributes ranking power");

  // ── TECHNICAL SEO CHECKLIST ──────────────────────────────────────────────────
  section("Technical SEO Checklist");

  checkRow("XML Sitemap (/sitemap.xml)", lead.sitemapFound ? "PASS" : "FAIL",
    lead.sitemapFound ? "Found" : "Not found",
    lead.sitemapFound ? "Sitemap is present — helps Google discover all pages" : "No sitemap — Google may miss pages entirely. Submit one via Google Search Console");

  checkRow("Robots.txt (/robots.txt)", lead.robotsTxtFound ? "PASS" : "WARN",
    lead.robotsTxtFound ? "Found" : "Not found",
    lead.robotsTxtFound ? "Robots.txt is present" : "No robots.txt — not critical but best practice to have one");

  checkRow("Canonical Tag", lead.hasCanonical ? "PASS" : "WARN",
    lead.hasCanonical ? "Present" : "Missing",
    lead.hasCanonical ? "Canonical tag present — prevents duplicate content issues" : "No canonical tag — if content is duplicated, Google may index the wrong version");

  checkRow("Structured Data / Schema", lead.hasSchema ? "PASS" : "WARN",
    lead.hasSchema ? "Detected" : "Not found",
    lead.hasSchema ? "Schema markup found — helps Google show rich results (stars, FAQs, etc.)" : "No schema markup — missing rich result opportunities (reviews, business hours, etc.)");

  checkRow("Mobile Viewport Meta Tag", lead.hasViewport ? "PASS" : "FAIL",
    lead.hasViewport ? "Present" : "Missing",
    lead.hasViewport ? "Viewport tag present" : "No viewport tag — site will not display correctly on mobile phones");

  checkRow("Open Graph / Social Tags", lead.hasOgTags ? "PASS" : "WARN",
    lead.hasOgTags ? "Present" : "Missing",
    lead.hasOgTags ? "OG tags found — shared links will display correctly on social media" : "No Open Graph tags — links shared on Facebook/WhatsApp won't show image or title preview");

  // ── PERFORMANCE ISSUES FROM PAGESPEED ────────────────────────────────────────
  if (lead.issues && lead.issues.length) {
    section("Performance Issues Detected");
    lead.issues.forEach((issue) => {
      pageCheck();
      const y = doc.y;
      statusTag(50, y, "FAIL");
      doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold")
        .text(issue.label, 92, y, { width: 340 });
      if (issue.detail) {
        doc.fillColor(LIGHT).fontSize(8).font("Helvetica").text(issue.detail, 92, doc.y, { width: 380 });
      }
      doc.moveDown(issue.detail ? 0.55 : 0.45);
    });
  }

  // ── CONTACT INFO ──────────────────────────────────────────────────────────────
  section("Contact Information Found on Site");
  if (lead.emails.length) {
    doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold").text("Email addresses:");
    lead.emails.forEach((e) => {
      doc.fillColor(INFO).fontSize(8.5).font("Helvetica").text("  " + e);
    });
    doc.moveDown(0.3);
  }
  if (lead.phones.length) {
    doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold").text("Phone numbers:");
    lead.phones.slice(0, 3).forEach((p) => {
      doc.fillColor(MID).fontSize(8.5).font("Helvetica").text("  " + p);
    });
    doc.moveDown(0.3);
  }
  if (lead.facebookUrl) {
    doc.fillColor(DARK).fontSize(8.5).font("Helvetica-Bold").text("Facebook page:");
    doc.fillColor([59, 130, 246]).fontSize(8.5).font("Helvetica").text("  " + lead.facebookUrl);
    doc.moveDown(0.3);
  }
  if (!lead.emails.length && !lead.phones.length) {
    doc.fillColor(LIGHT).fontSize(8.5).font("Helvetica").text("No contact details found on public pages.");
  }
  doc.moveDown(0.4);

  // ── PRIORITY RECOMMENDATIONS ──────────────────────────────────────────────────
  section("Priority Action List");
  const recs = [
    !lead.hasSSL          && { sev:"CRITICAL", text: "Install SSL certificate — Google penalises and browsers warn visitors on HTTP sites" },
    !lead.sitemapFound    && { sev:"HIGH",     text: "Create and submit an XML sitemap to Google Search Console so all pages get indexed" },
    !lead.hasH1           && { sev:"HIGH",     text: "Add a single clear H1 heading to the homepage containing the main keyword + location" },
    lead.metaDescLength === 0 && { sev:"HIGH", text: "Write meta descriptions (120-160 chars) for every page — they appear in Google results" },
    (lead.metaTitleLength < 30 || lead.metaTitleLength > 60) && lead.metaTitleLength !== 0
                          && { sev:"HIGH",     text: `Page title is ${lead.metaTitleLength} characters — ideal is 30-60 chars with main keyword near the start` },
    lead.wordCount < 300  && { sev:"HIGH",     text: `Homepage has only ~${lead.wordCount} words — add more relevant content describing services and location` },
    !lead.hasSchema       && { sev:"MEDIUM",   text: "Add LocalBusiness schema markup — enables rich results (ratings, hours) in Google" },
    !lead.hasCanonical    && { sev:"MEDIUM",   text: "Add canonical tags to prevent Google treating similar pages as duplicates" },
    lead.imagesWithAlt < lead.imagesTotal && { sev:"MEDIUM", text: `${lead.imagesTotal - lead.imagesWithAlt} image(s) missing alt text — add descriptive alt attributes` },
    lead.mobileScore < 50 && { sev:"HIGH",     text: `Mobile speed score is ${lead.mobileScore}/100 — compress images, remove unused JS/CSS, enable Gzip` },
    !lead.hasViewport     && { sev:"CRITICAL", text: "Add a mobile viewport meta tag — without it the site is broken on phones" },
    lead.h2Count < 2      && { sev:"MEDIUM",   text: "Add more H2/H3 subheadings — structure content into sections Google can index as topics" },
    lead.internalLinks < 3 && { sev:"MEDIUM",  text: "Add internal links between pages — helps Google crawl the site and improves user navigation" },
    !lead.hasOgTags       && { sev:"LOW",      text: "Add Open Graph tags so links shared on social media display a proper image and title" },
  ].filter(Boolean);

  const sevColor = { CRITICAL: FAIL, HIGH: WARN, MEDIUM: INFO, LOW: [148, 163, 184] };
  recs.slice(0, 10).forEach((rec, i) => {
    pageCheck();
    const y = doc.y;
    const [r, g, b] = sevColor[rec.sev] || INFO;
    doc.roundedRect(50, y, 48, 13, 3).fill([r, g, b]);
    doc.fillColor([255,255,255]).fontSize(6.5).font("Helvetica-Bold")
      .text(rec.sev, 50, y + 3, { width: 48, align: "center" });
    doc.fillColor(DARK).fontSize(8.5).font("Helvetica")
      .text(rec.text, 106, y, { width: 435 });
    doc.moveDown(0.7);
  });

  // ── FOOTER ────────────────────────────────────────────────────────────────────
  const totalPages = doc.bufferedPageRange ? doc.bufferedPageRange().count : "—";
  const range = doc.bufferedPageRange();
  for (let i = 0; i < (range ? range.count : 1); i++) {
    doc.switchToPage(range ? range.start + i : 0);
    doc.rect(0, 818, 595, 24).fill([241, 245, 249]);
    doc.fillColor(LIGHT).fontSize(7).font("Helvetica")
      .text(`Zaram SEO PitchReady  ·  Generated ${new Date().toLocaleDateString("en-GB")}  ·  Data from Google PageSpeed Insights API  ·  Page ${i + 1}`,
        50, 823, { width: 495, align: "center" });
  }

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
