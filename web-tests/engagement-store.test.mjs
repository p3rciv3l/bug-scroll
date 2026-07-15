import test from "node:test";
import assert from "node:assert/strict";
import { EngagementStore, ENGAGEMENT_KEY } from "../site/engagement-store.mjs";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const article = { pageid: 42, title: "Moon", url: "https://en.wikipedia.org/wiki/Moon", extract: "Earth's moon" };

test("clicks and completed view segments persist as one engagement record", () => {
  const storage = new MemoryStorage();
  let now = 0;
  const store = new EngagementStore(storage, { now: () => ++now });
  store.recordView(article, 2_000);
  store.recordView(article, 3_000);
  store.recordClick(article);
  store.recordClick(article);

  assert.deepEqual(new EngagementStore(storage).get(article), {
    article,
    clicked: true,
    viewMs: 5_000,
    updatedAt: 4,
  });
  assert.match(storage.getItem(ENGAGEMENT_KEY), /"version":1/);
});

test("engagement storage is bounded to recent records", () => {
  const storage = new MemoryStorage();
  const store = new EngagementStore(storage, { limit: 2 });
  store.recordClick({ ...article, pageid: 1 });
  store.recordClick({ ...article, pageid: 2 });
  store.recordClick({ ...article, pageid: 3 });

  assert.deepEqual(store.values().map(({ article: item }) => item.pageid), [2, 3]);
});
