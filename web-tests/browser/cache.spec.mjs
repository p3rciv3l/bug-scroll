import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

test("service worker cache remains readable offline", async ({ context, page }) => {
  await page.goto("/");

  const cached = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    const assets = ["./", "./styles.css?v=8", "./app.js?v=8", "./recommender.mjs"];
    return Promise.all(
      assets.map(async (asset) => Boolean(await caches.match(new URL(asset, location.href)))),
    );
  });

  expect(cached).toEqual([true, true, true, true]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  await context.setOffline(true);
  const offlineResponses = await page.evaluate(async () => {
    const assets = ["./", "./styles.css?v=8", "./app.js?v=8", "./recommender.mjs"];
    return Promise.all(assets.map(async (asset) => {
      const response = await caches.match(new URL(asset, location.href));
      return { ok: response.ok, bytes: (await response.text()).length };
    }));
  });
  expect(offlineResponses.every(({ ok, bytes }) => ok && bytes > 0)).toBe(true);
  await context.setOffline(false);
});
