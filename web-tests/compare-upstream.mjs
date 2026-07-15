import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { devices, webkit } from "@playwright/test";
import { addConstrainedCpuLoad, mockWikipedia } from "./browser-fixtures.mjs";

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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function aggregate(name, trials) {
  return {
    name,
    changed: trials.every((trial) => trial.changed),
    frames: median(trials.map((trial) => trial.frames)),
    p95: median(trials.map((trial) => trial.p95)),
    over50: median(trials.map((trial) => trial.over50)),
    max: median(trials.map((trial) => trial.max)),
    trials,
  };
}

const surfaces = {
  current: {
    name: "Big Scroll",
    ready: (page) => page.locator(".article").first().waitFor({ timeout: 30_000 }),
    snapshot: (page) => page.locator("#feed").evaluate((feed) => String(feed.scrollTop)),
  },
  upstream: {
    name: "Upstream WikWok",
    ready: (page) => page.locator("canvas").first().waitFor({ timeout: 30_000 }),
    snapshot: async (page) => createHash("sha256")
      .update(await page.locator("canvas").first().screenshot())
      .digest("hex"),
  },
};

async function measure(browser, surface, url) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: devices["iPhone 13"].userAgent,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  await mockWikipedia(page, {
    latency: 150,
    pattern: "https://*.wikipedia.org/w/api.php**",
    titlePrefix: "Baseline article",
  });
  await addConstrainedCpuLoad(page);
  await page.goto(url);
  await surface.ready(page);
  await page.waitForTimeout(1_000);

  const before = await surface.snapshot(page);

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

  const after = await surface.snapshot(page);
  await context.close();
  return { name: surface.name, changed: before !== after, ...summarize(gaps) };
}

const browser = await webkit.launch();
try {
  await measure(browser, surfaces.current, currentUrl);
  await measure(browser, surfaces.upstream, upstreamUrl);

  const currentTrials = [];
  const upstreamTrials = [];
  for (let round = 0; round < 3; round += 1) {
    if (round % 2 === 0) {
      currentTrials.push(await measure(browser, surfaces.current, currentUrl));
      upstreamTrials.push(await measure(browser, surfaces.upstream, upstreamUrl));
    } else {
      upstreamTrials.push(await measure(browser, surfaces.upstream, upstreamUrl));
      currentTrials.push(await measure(browser, surfaces.current, currentUrl));
    }
  }

  const current = aggregate(surfaces.current.name, currentTrials);
  const upstream = aggregate(surfaces.upstream.name, upstreamTrials);
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
  const regressed =
    current.p95 > upstream.p95 + 3 ||
    current.over50 > upstream.over50 + 1 ||
    current.max > upstream.max + 10;
  if (regressed) {
    console.error("Big Scroll exceeded the upstream scroll-latency tolerance.");
    process.exitCode = 3;
  }
} finally {
  await browser.close();
}
