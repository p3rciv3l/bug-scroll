import { expect, test } from "@playwright/test";
import { addConstrainedCpuLoad, mockWikipedia } from "../browser-fixtures.mjs";

async function failEachImageOnce(page) {
  const attempts = new Map();
  await page.route("**/test-images/**", async (route) => {
    const key = new URL(route.request().url()).pathname;
    const attempt = (attempts.get(key) || 0) + 1;
    attempts.set(key, attempt);
    if (attempt === 1) {
      await route.abort("failed");
      return;
    }
    await route.fulfill({
      contentType: "image/svg+xml",
      body: "<svg xmlns='http://www.w3.org/2000/svg' width='390' height='844'><rect width='390' height='844' fill='#263548'/></svg>",
    });
  });
  return attempts;
}

async function sampleOneCardScroll(page) {
  return page.locator("#feed").evaluate(async (feed) => {
    const maximum = feed.scrollHeight - feed.clientHeight;
    const from = Math.min(feed.scrollTop, Math.max(0, maximum - feed.clientHeight));
    const to = Math.min(from + feed.clientHeight, maximum);
    feed.scrollTop = from;
    const gaps = [];
    let previous = performance.now();
    const started = previous;
    await new Promise((resolve) => {
      function frame(now) {
        gaps.push(now - previous);
        previous = now;
        const progress = Math.min(1, (now - started) / 500);
        feed.scrollTop = from + (to - from) * progress;
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
    const samples = gaps.slice(1).sort((left, right) => left - right);
    return {
      frames: samples.length,
      p95: samples[Math.floor(samples.length * 0.95)] || 0,
      max: samples.at(-1) || 0,
    };
  });
}

test("iPhone feed keeps only Likes UI and persists a like", async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.__shareCalls = [];
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (payload) => { globalThis.__shareCalls.push(payload); },
    });
  });
  await mockWikipedia(page, { latency: 150 });
  await page.goto("/");
  await expect.poll(() => page.locator(".article").count()).toBeGreaterThanOrEqual(12);

  await expect(page.getByText("About", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Language", { exact: true })).toHaveCount(0);
  await expect(page.locator('[aria-label*="logo" i], .logo')).toHaveCount(0);

  const heart = page.locator(".heart-button").first();
  await heart.click();
  await expect(page.locator("#likes-count")).toHaveText("1");
  await expect(heart).toHaveCSS("background-color", "rgb(255, 45, 64)");
  await expect(heart.locator("svg")).toHaveCount(1);
  const share = page.locator(".share-button").first();
  await expect(share).toBeVisible();
  await share.click();
  await expect.poll(() => page.evaluate(() => globalThis.__shareCalls.length)).toBe(1);
  await expect(page.getByRole("link", { name: "Read article" }).first()).toBeVisible();
  await page.reload();
  await expect(page.locator("#likes-count")).toHaveText("1");
  await page.locator("#open-likes").click();
  await expect(page.getByRole("dialog", { name: "Likes" })).toBeVisible();
  await expect(page.locator(".liked-card")).toHaveCount(1);
});

test("long constrained session keeps DOM, images, and frame gaps bounded", async ({ page }) => {
  const wikipedia = await mockWikipedia(page, { latency: 180 });
  await addConstrainedCpuLoad(page);
  await page.addInitScript(() => {
    const articles = Array.from({ length: 30 }, (_, index) => ({
      pageid: 10_000 + index,
      title: `Liked science article ${index}`,
      extract: "Science, medicine, technology, astronomy, and research.",
      url: `https://en.wikipedia.org/?curid=${10_000 + index}`,
      categories: [{ title: "Category:Science" }],
    }));
    localStorage.setItem("big-scroll.likes.v1", JSON.stringify({ version: 1, articles }));
  });
  await page.goto("/");
  await expect.poll(() => page.locator(".article").count()).toBeGreaterThanOrEqual(36);
  await expect(page.locator("#likes-count")).toHaveText("30");

  for (let batch = 0; batch < 18; batch += 1) {
    const previousCalls = wikipedia.calls;
    await page.locator("#feed").evaluate((feed) => {
      feed.scrollTo({ top: feed.scrollHeight - feed.clientHeight, behavior: "instant" });
    });
    await expect.poll(() => wikipedia.calls).toBeGreaterThan(previousCalls);
    await page.waitForTimeout(350);
  }

  await page.waitForTimeout(500);
  expect(wikipedia.calls).toBeGreaterThanOrEqual(19);
  expect(await page.locator(".article").count()).toBeLessThanOrEqual(48);
  expect(await page.locator(".article-image[src]").count()).toBeLessThanOrEqual(5);

  const timing = await sampleOneCardScroll(page);
  console.log(`iPhone constrained scroll: ${JSON.stringify(timing)}`);
  expect(timing.frames).toBeGreaterThan(15);
  expect(timing.p95).toBeLessThan(50);
  expect(timing.max).toBeLessThan(150);
});

test("retries a transient failure for a visible article image", async ({ page }) => {
  const attempts = await failEachImageOnce(page);
  await mockWikipedia(page, {
    imageSource: ({ pageid }) => `http://127.0.0.1:4173/test-images/${pageid}.svg`,
  });

  await page.goto("/");
  const image = page.locator(".article-image").first();
  await expect(image).toBeVisible();
  const dataSource = await image.getAttribute("data-src");
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBe(true);
  expect(attempts.get(new URL(dataSource).pathname)).toBeGreaterThanOrEqual(2);
});

test("retries a transient failure for an image in Likes", async ({ page }) => {
  const attempts = await failEachImageOnce(page);
  await page.addInitScript(() => {
    const article = {
      pageid: 77,
      title: "Saved image article",
      extract: "Saved locally.",
      url: "https://en.wikipedia.org/?curid=77",
      image: "http://127.0.0.1:4173/test-images/liked.svg",
      categories: [],
    };
    localStorage.setItem("big-scroll.likes.v1", JSON.stringify({ version: 1, articles: [article] }));
  });
  await mockWikipedia(page);

  await page.goto("/");
  await page.locator("#open-likes").click();
  const image = page.locator(".liked-card-image").first();
  await expect(image).toBeVisible();
  const dataSource = await image.getAttribute("data-src");
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBe(true);
  expect(attempts.get(new URL(dataSource).pathname)).toBeGreaterThanOrEqual(2);
});
