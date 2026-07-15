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
  await expect(page.locator(".article")).toHaveCount(10);

  await expect(page.getByText("About", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Language", { exact: true })).toHaveCount(0);
  await expect(page.locator('[aria-label*="logo" i], .logo')).toHaveCount(0);

  const heart = page.locator(".heart-button").first();
  await heart.click();
  await expect(page.locator("#likes-count")).toHaveText("1");
  await expect(heart).toHaveCSS("background-color", "rgb(255, 45, 64)");
  await expect(heart.locator("svg")).toHaveCount(1);
  await expect(page.locator(".share-button")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Read article" }).first()).toBeVisible();
  await page.reload();
  await expect(page.locator("#likes-count")).toHaveText("1");
  await page.locator("#open-likes").click();
  await expect(page.getByRole("dialog", { name: "Likes" })).toBeVisible();
  await expect(page.locator(".liked-card")).toHaveCount(1);
});

test("visible time and Read clicks become local recommendation feedback", async ({ page }) => {
  await mockWikipedia(page, { latency: 0 });
  await page.goto("/");
  await expect(page.locator(".article")).toHaveCount(10);

  const firstPageId = Number(await page.locator(".article").first().getAttribute("data-pageid"));
  await page.waitForTimeout(300);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Read article" }).first().click();
  const popup = await popupPromise;
  await popup.close();
  await page.locator("#feed").evaluate((feed) => feed.scrollTo({ top: feed.clientHeight, behavior: "instant" }));

  await expect.poll(() => page.evaluate((pageid) => {
    const payload = JSON.parse(localStorage.getItem("big-scroll.engagement.v1"));
    const item = payload?.engagements?.find(({ article }) => article.pageid === pageid);
    return item && { clicked: item.clicked, hasView: item.viewMs > 100 };
  }, firstPageId)).toEqual({ clicked: true, hasView: true });

  const first = await page.evaluate((pageid) => {
    const payload = JSON.parse(localStorage.getItem("big-scroll.engagement.v1"));
    return payload.engagements.find(({ article }) => article.pageid === pageid);
  }, firstPageId);
  expect(first.viewMs).toBeGreaterThan(100);
});

test("warm engagement history batches scroll-time persistence", async ({ page }) => {
  await mockWikipedia(page, { latency: 0 });
  await page.addInitScript(() => {
    const engagements = Array.from({ length: 250 }, (_, index) => ({
      article: {
        pageid: 10_000 + index,
        title: `History article ${index}`,
        extract: "Science, history, culture, technology, medicine, and art.",
        url: `https://en.wikipedia.org/?curid=${10_000 + index}`,
      },
      clicked: index % 3 === 0,
      viewMs: 5_000 + index,
      updatedAt: index,
    }));
    const original = Storage.prototype.setItem;
    original.call(localStorage, "big-scroll.engagement.v1", JSON.stringify({ version: 1, engagements }));
    window.__engagementWrites = 0;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === "big-scroll.engagement.v1") window.__engagementWrites += 1;
      return original.call(this, key, value);
    };
  });
  await page.goto("/");
  await expect(page.locator(".article")).toHaveCount(10);

  for (let index = 1; index < 5; index += 1) {
    await page.locator(".article").nth(index).scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
  }

  expect(await page.evaluate(() => window.__engagementWrites)).toBeLessThanOrEqual(1);
});

test("persisted engagement changes the next ranking after reload", async ({ page }) => {
  await page.addInitScript(() => { Math.random = () => 0.5; });
  const image = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='390' height='844'%3E%3Crect width='390' height='844' fill='%23263548'/%3E%3C/svg%3E";
  await page.route("https://en.wikipedia.org/w/api.php**", (route) => route.fulfill({ json: {
    query: { pages: {
      101: { pageid: 101, title: "French cooking", extract: "Recipes, bread, sauce, pastry, cuisine and restaurants.", fullurl: "https://en.wikipedia.org/?curid=101", thumbnail: { source: image } },
      102: { pageid: 102, title: "Lunar spacecraft", extract: "A spacecraft, rocket, astronaut and lunar orbit mission.", fullurl: "https://en.wikipedia.org/?curid=102", thumbnail: { source: image } },
    } },
  } }));

  await page.goto("/");
  await expect(page.locator(".article h2").first()).toHaveText("French cooking");
  await page.locator(".read-link").nth(1).evaluate((link) => {
    addEventListener("click", (event) => event.preventDefault(), { capture: true, once: true });
    link.click();
  });
  await page.locator(".article").nth(1).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.locator(".article").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  await page.reload();

  await expect(page.locator(".article h2").first()).toHaveText("Lunar spacecraft");
});

test("long constrained session keeps images present and frame gaps bounded", async ({ page }) => {
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
  await expect(page.locator(".article")).toHaveCount(10);
  await expect(page.locator("#likes-count")).toHaveText("30");
  const firstPageId = Number(await page.locator(".article").first().getAttribute("data-pageid"));

  for (let batch = 0; batch < 6; batch += 1) {
    const previousCalls = wikipedia.calls;
    await page.locator("#feed").evaluate((feed) => {
      feed.scrollTo({ top: feed.scrollHeight - feed.clientHeight, behavior: "instant" });
    });
    await expect.poll(() => wikipedia.calls).toBeGreaterThan(previousCalls);
    await page.waitForTimeout(350);
  }

  await page.waitForTimeout(500);
  expect(wikipedia.calls).toBeGreaterThanOrEqual(7);
  const articleCount = await page.locator(".article").count();
  expect(articleCount).toBeGreaterThanOrEqual(70);
  await expect(page.locator(".article-image[src]")).toHaveCount(articleCount);

  const timing = await sampleOneCardScroll(page);
  console.log(`iPhone constrained scroll: ${JSON.stringify(timing)}`);
  expect(timing.frames).toBeGreaterThan(15);
  expect(timing.p95).toBeLessThan(50);
  expect(timing.max).toBeLessThan(150);

  const viewBefore = await page.evaluate((pageid) => {
    const payload = JSON.parse(localStorage.getItem("big-scroll.engagement.v1") || "{\"engagements\":[]}");
    return payload.engagements.find(({ article }) => article.pageid === pageid)?.viewMs || 0;
  }, firstPageId);
  await page.locator(".article").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.locator(".article").nth(1).scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);
  const viewAfter = await page.evaluate((pageid) => {
    const payload = JSON.parse(localStorage.getItem("big-scroll.engagement.v1"));
    return payload.engagements.find(({ article }) => article.pageid === pageid)?.viewMs || 0;
  }, firstPageId);
  expect(viewAfter).toBeGreaterThan(viewBefore);
});

test("feed excludes articles without usable images", async ({ page }) => {
  const wikipedia = await mockWikipedia(page, {
    latency: 0,
    imageSource: ({ index }) => index % 2 === 0
      ? "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='390' height='844'%3E%3Crect width='390' height='844' fill='%23263548'/%3E%3C/svg%3E"
      : null,
  });

  await page.goto("/");
  await expect(page.locator(".article")).toHaveCount(5);

  const cards = page.locator(".article");
  await expect(cards.locator(".article-image")).toHaveCount(await cards.count());
  await expect(cards.locator(".no-image")).toHaveCount(0);
  expect(wikipedia.calls).toBe(1);
});

test("startup renders one small batch without pre-filling", async ({ page }) => {
  const wikipedia = await mockWikipedia(page, { latency: 0 });

  await page.goto("/");
  await expect(page.locator(".article")).toHaveCount(10);
  await page.waitForTimeout(100);

  expect(wikipedia.calls).toBe(1);
  const request = new URL(wikipedia.urls[0]);
  expect(request.searchParams.get("grnlimit")).toBe("10");
  expect(request.searchParams.get("prop")).toBe("extracts|info|pageimages");
});

test("pagination waits for active scrolling to settle", async ({ page }) => {
  const wikipedia = await mockWikipedia(page, { latency: 0 });

  await page.goto("/");
  await expect(page.locator(".article")).toHaveCount(10);
  await page.locator("#feed").evaluate(async (feed) => {
    const started = performance.now();
    await new Promise((resolve) => {
      function frame(now) {
        const progress = Math.min(1, (now - started) / 500);
        feed.scrollTop = (feed.scrollHeight - feed.clientHeight) * progress;
        if (progress < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  });

  expect(wikipedia.calls).toBe(1);
  await expect.poll(() => wikipedia.calls).toBeGreaterThan(1);
});
