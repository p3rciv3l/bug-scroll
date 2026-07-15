import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { devices, webkit } from "@playwright/test";

const currentUrl = process.env.CURRENT_URL || "http://127.0.0.1:4173/";
const upstreamUrl = process.env.UPSTREAM_URL || "http://127.0.0.1:4174/";
const currentDist = process.env.CURRENT_DIST || "site";
const upstreamDist = process.env.UPSTREAM_DIST;

function directorySize(path) {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name);
    return total + (entry.isDirectory() ? directorySize(child) : statSync(child).size);
  }, 0);
}

function summarize(gaps) {
  const sorted = gaps.sort((left, right) => left - right);
  return {
    frames: sorted.length,
    p95: sorted[Math.floor(sorted.length * 0.95)] || 0,
    over50: sorted.filter((gap) => gap > 50).length,
    max: sorted.at(-1) || 0,
  };
}

async function mockWikipedia(page) {
  let batch = 0;
  await page.route("https://*.wikipedia.org/w/api.php**", async (route) => {
    batch += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pages = {};
    for (let index = 0; index < 12; index += 1) {
      const pageid = batch * 100 + index;
      pages[pageid] = {
        pageid,
        title: `Baseline article ${pageid}`,
        extract: "Science, history, medicine, technology, culture, and art.",
        fullurl: `https://en.wikipedia.org/?curid=${pageid}`,
        thumbnail: {
          source: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='390' height='844'%3E%3Crect width='100%25' height='100%25' fill='%23263548'/%3E%3C/svg%3E",
        },
        categories: [{ title: `Category:Topic ${index % 4}` }],
      };
    }
    await route.fulfill({ json: { query: { pages } } });
  });
}

async function measure(browser, name, url) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: devices["iPhone 13"].userAgent,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  await mockWikipedia(page);
  await page.addInitScript(() => {
    setInterval(() => {
      const finish = performance.now() + 3;
      while (performance.now() < finish) { /* same constrained main-thread load */ }
    }, 16);
  });
  await page.goto(url);
  if (name === "Big Scroll") await page.locator(".article").first().waitFor();
  else await page.locator("canvas").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1_000);

  const before = name === "Big Scroll"
    ? String(await page.locator("#feed").evaluate((feed) => feed.scrollTop))
    : createHash("sha256").update(await page.locator("canvas").first().screenshot()).digest("hex");

  await page.evaluate(() => {
    window.__frameGaps = [];
    window.__sampleFrames = true;
    let previous = performance.now();
    function frame(now) {
      window.__frameGaps.push(now - previous);
      previous = now;
      if (window.__sampleFrames) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  await page.mouse.move(195, 422);
  for (let index = 0; index < 12; index += 1) {
    await page.mouse.wheel(0, 620);
    await page.waitForTimeout(85);
  }
  await page.waitForTimeout(300);
  const gaps = await page.evaluate(() => {
    window.__sampleFrames = false;
    return window.__frameGaps.slice(1);
  });

  const after = name === "Big Scroll"
    ? String(await page.locator("#feed").evaluate((feed) => feed.scrollTop))
    : createHash("sha256").update(await page.locator("canvas").first().screenshot()).digest("hex");
  await context.close();
  return { name, changed: before !== after, ...summarize(gaps) };
}

const browser = await webkit.launch();
try {
  const current = await measure(browser, "Big Scroll", currentUrl);
  const upstream = await measure(browser, "Upstream WikWok", upstreamUrl);
  const result = {
    current,
    upstream,
    deployableBytes: {
      current: directorySize(currentDist),
      upstream: upstreamDist ? directorySize(upstreamDist) : null,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!current.changed || !upstream.changed) process.exitCode = 2;
} finally {
  await browser.close();
}
