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
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_KEY });

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
    const mobileResp = await axios.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", {
      params: { url, key: PAGESPEED_KEY, strategy: "mobile" }, timeout: 20000,
    });
    await sleep(500);
    const desktopResp = await axios.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", {
      params: { url, key: PAGESPEED_KEY, strategy: "desktop" }, timeout: 20000,
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
async function crawlSite(url) {
  const result = { emails: [], phones: [], hasH1: false, hasMetaDesc: false, pageTitle: "", crawlError: false };
  const pages = [url, url.replace(/\/?$/, "/contact"), url.replace(/\/?$/, "/about")];

  for (const pageUrl of pages) {
    try {
      const resp = await axios.get(pageUrl, {
        timeout: 10000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SEOBot/1.0)" },
        maxRedirects: 5,
      });
      const $ = cheerio.load(resp.data);

      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      (resp.data.match(emailRegex) || []).forEach((e) => {
        if (!e.includes("sentry") && !e.includes("example") && !result.emails.includes(e))
          result.emails.push(e);
      });

      const phoneRegex = /(\+?[\d\s\-().]{7,})/g;
      (resp.data.match(phoneRegex) || []).forEach((p) => {
        const digits = p.replace(/\D/g, "");
        if (digits.length >= 7 && digits.length <= 15 && !result.phones.includes(p.trim()))
          result.phones.push(p.trim());
      });

      if (pageUrl === url) {
        result.hasH1 = $("h1").length > 0;
        result.hasMetaDesc = !!$('meta[name="description"]').attr("content");
        result.pageTitle = $("title").text().trim();
      }
    } catch (e) {
      if (pageUrl === url) result.crawlError = true;
    }
  }
  return result;
}

// ── 4. Generate TWO pitches: SEO email + Design email ───────────────────────
async function generatePitches(businessName, url, crawl, pageSpeed, query) {
  const allIssues = [
    ...(pageSpeed?.issueLabels || []),
    ...(!crawl.hasH1 ? ["No H1 heading on homepage"] : []),
    ...(!crawl.hasMetaDesc ? ["No meta description tag"] : []),
  ];

  const topIssues = allIssues.slice(0, 3).join(", ");

  const prompt = `You are a web professional who has ALREADY audited this business's website. Write TWO short cold outreach emails. Return ONLY valid JSON, no markdown, no code blocks.

Business: ${businessName}
Website: ${url}
Niche: "${query}"
Google page they rank on: ${pageSpeed ? `page ${crawl.googlePage}` : "unknown"}
Mobile score: ${pageSpeed?.mobileScore ?? "unknown"}/100
Top issues found: ${topIssues || "general performance issues"}
Load time: ${pageSpeed?.tti ?? "unknown"}

EMAIL 1 — SEO pitch:
- You've audited their site. Mention ONE headline finding that is hurting their rankings or traffic.
- Say the full audit report is attached (as a PDF).
- CTA: ask if they'd like you to fix it — keep it soft and human.
- 3-4 sentences max.

EMAIL 2 — Design pitch:
- You've looked at their site design. Be specific about what looks outdated or unprofessional.
- Say you've already drafted a redesigned version and you'll show it to them free with no obligation.
- CTA: ask if they'd like to see it.
- 3-4 sentences max.

Rules for BOTH:
- Never offer to "run an audit" — it is already done
- Never use buzzwords: seamless, leverage, empower, holistic, synergy
- Sound like a real human freelancer, not an agency
- No subject lines, just the email body text

Return exactly this JSON structure:
{"seoPitch": "...", "designPitch": "..."}`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = msg.content[0].text.trim();
    const json = JSON.parse(text.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim());
    return { seoPitch: json.seoPitch, designPitch: json.designPitch };
  } catch (e) {
    console.error("Pitch generation error:", e.message);
    return {
      seoPitch: "Could not generate SEO pitch — check Anthropic API key.",
      designPitch: "Could not generate design pitch — check Anthropic API key.",
    };
  }
}

// ── 5. Generate PDF audit report ─────────────────────────────────────────────
function generatePDF(lead, res) {
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="audit-${new URL(lead.url).hostname}.pdf"`);
  doc.pipe(res);

  const W = 495;
  const scoreColor = (s) => s >= 70 ? [34, 197, 94] : s >= 40 ? [251, 146, 60] : [239, 68, 68];
  const drawScore = (x, y, label, score) => {
    const [r, g, b] = scoreColor(score);
    doc.roundedRect(x, y, 100, 60, 8).fillColor([r, g, b], 0.12).fill();
    doc.fillColor([r, g, b]).fontSize(22).font("Helvetica-Bold").text(score, x, y + 10, { width: 100, align: "center" });
    doc.fillColor("#64748b").fontSize(8).font("Helvetica").text(label, x, y + 40, { width: 100, align: "center" });
  };
  const section = (title, y) => {
    doc.moveDown(0.5);
    doc.fillColor("#1e1b4b").fontSize(11).font("Helvetica-Bold").text(title.toUpperCase(), 50, doc.y, { characterSpacing: 1 });
    doc.moveTo(50, doc.y + 3).lineTo(545, doc.y + 3).strokeColor("#e2e8f0").lineWidth(1).stroke();
    doc.moveDown(0.5);
  };

  // Header
  doc.rect(0, 0, 595, 90).fill("#0f172a");
  doc.fillColor("#a78bfa").fontSize(9).font("Helvetica-Bold").text("ZARAM SEO PITCHREADY", 50, 25, { characterSpacing: 2 });
  doc.fillColor("#ffffff").fontSize(16).font("Helvetica-Bold").text("Website SEO Audit Report", 50, 40);
  doc.fillColor("#94a3b8").fontSize(9).font("Helvetica").text(`Prepared: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, 50, 65);

  doc.y = 110;

  // Business details
  doc.fillColor("#1e293b").fontSize(14).font("Helvetica-Bold").text(lead.title, 50, doc.y);
  doc.moveDown(0.2);
  doc.fillColor("#6366f1").fontSize(10).font("Helvetica").text(lead.url);
  doc.fillColor("#64748b").fontSize(9).text(`Currently ranking on Google page ${lead.googlePage} · Audit date: ${new Date().toLocaleDateString()}`);
  doc.moveDown(1);

  // Score cards
  section("Performance Scores");
  const sy = doc.y;
  drawScore(50, sy, "Mobile Speed", lead.mobileScore);
  drawScore(160, sy, "Desktop Speed", lead.desktopScore);
  drawScore(270, sy, "SEO Score", lead.seoScore);
  drawScore(380, sy, "Accessibility", lead.accessibilityScore);
  doc.y = sy + 75;
  doc.moveDown(0.5);

  // Core Web Vitals
  section("Core Web Vitals");
  const vitals = [
    ["Largest Contentful Paint (LCP)", lead.lcp, "Should be under 2.5s"],
    ["Total Blocking Time (TBT)", lead.tbt, "Should be under 200ms"],
    ["Cumulative Layout Shift (CLS)", lead.cls, "Should be under 0.1"],
    ["First Contentful Paint (FCP)", lead.fcp, "Should be under 1.8s"],
    ["Time to Interactive (TTI)", lead.tti, "Should be under 3.8s"],
  ];
  vitals.forEach(([name, val, target]) => {
    const rowY = doc.y;
    doc.fillColor("#1e293b").fontSize(9).font("Helvetica-Bold").text(name, 50, rowY, { width: 220 });
    doc.fillColor("#334155").fontSize(9).font("Helvetica").text(val || "N/A", 280, rowY, { width: 80, align: "right" });
    doc.fillColor("#94a3b8").fontSize(8).text(target, 370, rowY, { width: 175 });
    doc.moveDown(0.55);
  });
  doc.moveDown(0.3);

  // Issues found
  section("Issues Found");
  if (lead.issues && lead.issues.length) {
    lead.issues.forEach((issue) => {
      const rowY = doc.y;
      doc.circle(56, rowY + 4, 3).fill("#ef4444");
      doc.fillColor("#1e293b").fontSize(9).font("Helvetica-Bold").text(issue.label, 65, rowY, { width: 300 });
      if (issue.detail) {
        doc.fillColor("#64748b").fontSize(8).font("Helvetica").text(issue.detail, 65, doc.y, { width: 430 });
      }
      doc.moveDown(0.5);
    });
  } else {
    doc.fillColor("#22c55e").fontSize(9).text("No critical issues detected.");
    doc.moveDown(0.5);
  }

  if (!lead.hasH1) {
    const rowY = doc.y;
    doc.circle(56, rowY + 4, 3).fill("#ef4444");
    doc.fillColor("#1e293b").fontSize(9).font("Helvetica-Bold").text("No H1 heading found on homepage", 65, rowY);
    doc.moveDown(0.5);
  }
  if (!lead.hasMetaDesc) {
    const rowY = doc.y;
    doc.circle(56, rowY + 4, 3).fill("#ef4444");
    doc.fillColor("#1e293b").fontSize(9).font("Helvetica-Bold").text("No meta description tag", 65, rowY);
    doc.moveDown(0.5);
  }
  doc.moveDown(0.3);

  // Contact info found
  section("Contact Information Found on Site");
  doc.fillColor("#64748b").fontSize(9).font("Helvetica").text("The following contact details were extracted by crawling the site:");
  doc.moveDown(0.4);
  if (lead.emails.length) {
    doc.fillColor("#1e293b").fontSize(9).font("Helvetica-Bold").text("Email addresses:");
    lead.emails.forEach((e) => doc.fillColor("#6366f1").fontSize(9).font("Helvetica").text("  " + e));
    doc.moveDown(0.3);
  }
  if (lead.phones.length) {
    doc.fillColor("#1e293b").fontSize(9).font("Helvetica-Bold").text("Phone numbers:");
    lead.phones.slice(0, 3).forEach((p) => doc.fillColor("#334155").fontSize(9).font("Helvetica").text("  " + p));
    doc.moveDown(0.3);
  }
  if (!lead.emails.length && !lead.phones.length) {
    doc.fillColor("#94a3b8").fontSize(9).text("No contact details found on public pages.");
    doc.moveDown(0.3);
  }
  doc.moveDown(0.3);

  // Recommendations
  section("Top Recommendations");
  const recs = [
    lead.mobileScore < 50 && "Optimise mobile performance — compress images, remove unused JS/CSS, enable Gzip compression",
    !lead.hasSSL && "Install an SSL certificate immediately — Google flags HTTP sites as insecure",
    !lead.hasMetaDesc && "Write a meta description for every page — this directly affects click-through rates in search",
    !lead.hasH1 && "Add a clear H1 heading to the homepage — essential for on-page SEO",
    lead.seoScore < 70 && "Improve on-page SEO: title tags, structured headings, internal linking",
    lead.lcp && lead.lcp !== "N/A" && parseFloat(lead.lcp) > 2.5 && "Reduce Largest Contentful Paint — defer offscreen images, preload key resources",
  ].filter(Boolean);

  recs.slice(0, 5).forEach((rec, i) => {
    const rowY = doc.y;
    doc.fillColor("#6366f1").fontSize(9).font("Helvetica-Bold").text(`${i + 1}.`, 50, rowY, { width: 15 });
    doc.fillColor("#1e293b").fontSize(9).font("Helvetica").text(rec, 68, rowY, { width: 477 });
    doc.moveDown(0.6);
  });

  // Footer
  const footerY = 780;
  doc.moveTo(50, footerY).lineTo(545, footerY).strokeColor("#e2e8f0").lineWidth(1).stroke();
  doc.fillColor("#94a3b8").fontSize(8).font("Helvetica")
    .text("This report was generated by Zaram SEO PitchReady using Google PageSpeed Insights API.", 50, footerY + 8, { align: "center", width: 495 })
    .text("Data reflects the live state of the website at the time of audit.", { align: "center", width: 495 });

  doc.end();
}

// ── Main job runner ──────────────────────────────────────────────────────────
async function runJob(jobId, query, startPage, endPage) {
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

      // Step 2: run PageSpeed for all sites (email or not)
      const hasEmail = crawl.emails.length > 0;
      job.log(`  ↳ [${idx}] ${hasEmail ? 'Email: ' + crawl.emails[0] : 'No email'} — auditing...`);
      const pageSpeed = await runPageSpeed(r.url);

      const ps = pageSpeed || {
        mobileScore: 0, desktopScore: 0, seoScore: 0, accessibilityScore: 0,
        lcp: 'N/A', tbt: 'N/A', cls: 'N/A', fcp: 'N/A', tti: 'N/A',
        hasSSL: r.url.startsWith('https'), issues: [], issueLabels: [],
      };
      if (!pageSpeed) job.log(`  ↳ [${idx}] PageSpeed unavailable — saved with basic data`);

      crawl.googlePage = r.page;
      const { seoPitch, designPitch } = await generatePitches(r.title, r.url, crawl, ps, query);

      leads.push({
        title: r.title,
        url: r.url,
        googlePage: r.page,
        snippet: r.snippet,
        mobileScore: ps.mobileScore,
        desktopScore: ps.desktopScore,
        seoScore: ps.seoScore,
        accessibilityScore: ps.accessibilityScore,
        loadTime: ps.tti,
        lcp: ps.lcp,
        tbt: ps.tbt,
        fcp: ps.fcp,
        tti: ps.tti,
        cls: ps.cls,
        hasSSL: ps.hasSSL,
        issues: ps.issues,
        issueLabels: ps.issueLabels,
        emails: crawl.emails,
        phones: crawl.phones,
        hasH1: crawl.hasH1,
        hasMetaDesc: crawl.hasMetaDesc,
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
app.post("/api/search", (req, res) => {
  const { query, startPage = 3, endPage = 10 } = req.body;
  if (!query) return res.status(400).json({ error: "query is required" });

  const jobId = uuidv4();
  const logs = [];
  jobs[jobId] = {
    id: jobId, status: "starting", query, startPage, endPage,
    leads: [], totalFound: 0, logs,
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
