if (process.env.NODE_ENV !== 'production') require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const Anthropic = require("@anthropic-ai/sdk");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const SERPER_KEY = process.env.SERPER_KEY;
const PAGESPEED_KEY = process.env.PAGESPEED_KEY;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

const jobs = {};

// ── 1. Search Google pages 3-10 via Serper ──────────────────────────────────
async function searchGoogle(query, startPage = 3, endPage = 10) {
  const results = [];
  for (let page = startPage; page <= endPage; page++) {
    try {
      const resp = await axios.post(
        "https://google.serper.dev/search",
        { q: query, page, num: 10 },
        { headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" } }
      );
      const organic = resp.data.organic || [];
      organic.forEach((r) => {
        if (r.link && !results.find((x) => x.url === r.link)) {
          results.push({ url: r.link, title: r.title, snippet: r.snippet, page });
        }
      });
    } catch (e) {
      console.error(`Serper page ${page} error:`, e.message);
    }
  }
  return results;
}

// ── 2. PageSpeed Insights (real Google audit) ────────────────────────────────
async function runPageSpeed(url) {
  try {
    const mobileResp = await axios.get(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed`,
      { params: { url, key: PAGESPEED_KEY, strategy: "mobile" }, timeout: 30000 }
    );
    const desktopResp = await axios.get(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed`,
      { params: { url, key: PAGESPEED_KEY, strategy: "desktop" }, timeout: 30000 }
    );

    const mData = mobileResp.data;
    const dData = desktopResp.data;
    const cats = mData.lighthouseResult?.categories || {};
    const audits = mData.lighthouseResult?.audits || {};
    const dCats = dData.lighthouseResult?.categories || {};

    const issues = [];
    const checkAudit = (id, label) => {
      const a = audits[id];
      if (a && a.score !== null && a.score < 0.9) issues.push(label);
    };

    checkAudit("uses-https", "No SSL/HTTPS");
    checkAudit("meta-description", "Missing meta description");
    checkAudit("document-title", "Missing page title");
    checkAudit("image-alt", "Images missing alt text");
    checkAudit("link-text", "Poor link text");
    checkAudit("tap-targets", "Buttons too small on mobile");
    checkAudit("font-size", "Text too small on mobile");
    checkAudit("viewport", "No mobile viewport tag");
    checkAudit("render-blocking-resources", "Render-blocking resources");
    checkAudit("uses-optimized-images", "Images not optimized");
    checkAudit("uses-webp-images", "Images not in modern format");
    checkAudit("unused-css-rules", "Unused CSS loading");
    checkAudit("unused-javascript", "Unused JavaScript loading");
    checkAudit("uses-text-compression", "No text compression (Gzip/Brotli)");
    checkAudit("time-to-first-byte", "Slow server response time");

    const lcp = audits["largest-contentful-paint"]?.displayValue || "N/A";
    const fid = audits["total-blocking-time"]?.displayValue || "N/A";
    const cls = audits["cumulative-layout-shift"]?.displayValue || "N/A";
    const loadTime = audits["interactive"]?.displayValue || "N/A";

    return {
      mobileScore: Math.round((cats.performance?.score || 0) * 100),
      desktopScore: Math.round((dCats.performance?.score || 0) * 100),
      seoScore: Math.round((cats.seo?.score || 0) * 100),
      accessibilityScore: Math.round((cats.accessibility?.score || 0) * 100),
      bestPracticesScore: Math.round((cats["best-practices"]?.score || 0) * 100),
      lcp,
      fid,
      cls,
      loadTime,
      issues,
      hasSSL: !issues.includes("No SSL/HTTPS"),
    };
  } catch (e) {
    console.error("PageSpeed error:", e.message);
    return null;
  }
}

// ── 3. Crawl site for contact info + on-page checks ─────────────────────────
async function crawlSite(url) {
  const result = { emails: [], phones: [], hasH1: false, hasMetaDesc: false, hasFavicon: false, crawlError: false };
  const pagesToCheck = [url, url.replace(/\/?$/, "/contact"), url.replace(/\/?$/, "/about")];

  for (const pageUrl of pagesToCheck) {
    try {
      const resp = await axios.get(pageUrl, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SEOBot/1.0)" },
        maxRedirects: 5,
      });
      const html = resp.data;
      const $ = cheerio.load(html);

      // Extract emails
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const found = html.match(emailRegex) || [];
      found.forEach((e) => {
        if (!e.includes("sentry") && !e.includes("example") && !result.emails.includes(e)) {
          result.emails.push(e);
        }
      });

      // Extract phones
      const phoneRegex = /(\+?1?\s?)?(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/g;
      const phones = html.match(phoneRegex) || [];
      phones.forEach((p) => {
        if (p.replace(/\D/g, "").length >= 10 && !result.phones.includes(p.trim())) {
          result.phones.push(p.trim());
        }
      });

      // On-page checks (homepage only)
      if (pageUrl === url) {
        result.hasH1 = $("h1").length > 0;
        result.hasMetaDesc = !!$('meta[name="description"]').attr("content");
        result.hasFavicon = !!($('link[rel="icon"]').length || $('link[rel="shortcut icon"]').length);
      }
    } catch (e) {
      if (pageUrl === url) result.crawlError = true;
    }
  }
  return result;
}

// ── 4. Claude generates a real, specific pitch ───────────────────────────────
async function generatePitch(businessName, url, siteData, pageSpeedData, query) {
  const issues = [
    ...(pageSpeedData?.issues || []),
    ...(!siteData.hasH1 ? ["No H1 heading on homepage"] : []),
    ...(!siteData.hasMetaDesc ? ["No meta description"] : []),
  ];

  const prompt = `You are a web designer reaching out to a cold lead. Write a SHORT, specific, conversational cold outreach message (3-5 sentences max) for this business:

Business: ${businessName}
Website: ${url}
They searched for: "${query}"
Google page they rank on: ${siteData.googlePage}

Real SEO/performance issues found on their site:
${issues.map((i) => `- ${i}`).join("\n")}

Mobile performance score: ${pageSpeedData?.mobileScore ?? "unknown"}/100
Desktop score: ${pageSpeedData?.desktopScore ?? "unknown"}/100
Load time: ${pageSpeedData?.loadTime ?? "unknown"}
Largest Contentful Paint: ${pageSpeedData?.lcp ?? "unknown"}

Rules:
- Only mention issues that are ACTUALLY listed above — never invent problems
- Sound like a real human, not a bot
- Don't use buzzwords like "seamless", "leverage", "empower"
- End with one soft CTA (offer to send a plan, a quick call, or show a sample)
- No subject line, just the message body`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content[0].text.trim();
  } catch (e) {
    return "Could not generate pitch — check Anthropic API key.";
  }
}

// ── Main job runner ──────────────────────────────────────────────────────────
async function runJob(jobId, query, startPage, endPage) {
  const job = jobs[jobId];
  job.status = "searching";
  job.log("Searching Google pages " + startPage + "–" + endPage + " for: " + query);

  const serperResults = await searchGoogle(query, startPage, endPage);
  job.log(`Found ${serperResults.length} URLs across pages ${startPage}–${endPage}`);
  job.totalFound = serperResults.length;

  const leads = [];

  for (let i = 0; i < serperResults.length; i++) {
    const r = serperResults[i];
    job.status = "auditing";
    job.log(`[${i + 1}/${serperResults.length}] Auditing: ${r.url}`);

    const [pageSpeed, crawl] = await Promise.all([runPageSpeed(r.url), crawlSite(r.url)]);

    if (!pageSpeed) {
      job.log(`  ↳ Skipped (PageSpeed failed)`);
      continue;
    }

    crawl.googlePage = r.page;
    const pitch = await generatePitch(r.title, r.url, crawl, pageSpeed, query);

    leads.push({
      title: r.title,
      url: r.url,
      googlePage: r.page,
      snippet: r.snippet,
      mobileScore: pageSpeed.mobileScore,
      desktopScore: pageSpeed.desktopScore,
      seoScore: pageSpeed.seoScore,
      accessibilityScore: pageSpeed.accessibilityScore,
      loadTime: pageSpeed.loadTime,
      lcp: pageSpeed.lcp,
      cls: pageSpeed.cls,
      hasSSL: pageSpeed.hasSSL,
      issues: pageSpeed.issues,
      emails: crawl.emails,
      phones: crawl.phones,
      hasH1: crawl.hasH1,
      hasMetaDesc: crawl.hasMetaDesc,
      pitch,
    });

    job.log(`  ↳ Mobile: ${pageSpeed.mobileScore}/100 · SEO: ${pageSpeed.seoScore}/100 · Issues: ${pageSpeed.issues.length} · Emails: ${crawl.emails.length}`);
    job.leads = leads;
  }

  job.status = "done";
  job.leads = leads;
  job.log(`✓ Done — ${leads.length} leads audited and pitched`);
}

// ── API Routes ───────────────────────────────────────────────────────────────

app.post("/api/search", (req, res) => {
  const { query, startPage = 3, endPage = 10 } = req.body;
  if (!query) return res.status(400).json({ error: "query is required" });

  const jobId = uuidv4();
  const logs = [];
  jobs[jobId] = {
    id: jobId,
    status: "starting",
    query,
    startPage,
    endPage,
    leads: [],
    totalFound: 0,
    logs,
    log: (msg) => { logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`); console.log(msg); },
    startedAt: new Date().toISOString(),
  };

  runJob(jobId, query, startPage, endPage).catch((e) => {
    jobs[jobId].status = "error";
    jobs[jobId].log("Fatal error: " + e.message);
  });

  res.json({ jobId });
});

app.get("/api/job/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json({
    id: job.id,
    status: job.status,
    query: job.query,
    totalFound: job.totalFound,
    leadsReady: job.leads.length,
    logs: job.logs.slice(-20),
    leads: job.leads,
    startedAt: job.startedAt,
  });
});

app.get("/api/job/:id/csv", (req, res) => {
  const job = jobs[req.params.id];
  if (!job || !job.leads.length) return res.status(404).json({ error: "No leads" });

  const headers = ["title","url","googlePage","mobileScore","desktopScore","seoScore","loadTime","lcp","cls","hasSSL","issueCount","issues","emails","phones","pitch"];
  const rows = job.leads.map((l) => [
    `"${l.title}"`, l.url, l.googlePage, l.mobileScore, l.desktopScore, l.seoScore,
    l.loadTime, l.lcp, l.cls, l.hasSSL,
    l.issues.length, `"${l.issues.join("; ")}"`,
    `"${l.emails.join(", ")}"`, `"${l.phones.join(", ")}"`,
    `"${l.pitch.replace(/"/g, "'")}"`,
  ].join(","));

  const csv = [headers.join(","), ...rows].join("\n");
  const filename = `seo-leads-${job.query.replace(/\s+/g, "-")}.csv`;
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Type", "text/csv");
  res.send(csv);
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`SEO Lead Finder backend on http://localhost:${PORT}`));
