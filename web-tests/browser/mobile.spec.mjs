import { expect, test } from "@playwright/test";
import { addConstrainedCpuLoad, mockWikipedia } from "../browser-fixtures.mjs";

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
  await mockWikipedia(page, { latency: 150 });
  await page.goto("/");
  await expect(page.locator(".article")).toHaveCount(12);

  await expect(page.getByText("About", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Language", { exact: true })).toHaveCount(0);
  await expect(page.locator('[aria-label*="logo" i], .logo')).toHaveCount(0);

  await page.locator(".heart-button").first().click();
  await expect(page.locator("#likes-count")).toHaveText("1");
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
  await expect(page.locator(".article")).toHaveCount(12);
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
