export const ENGAGEMENT_KEY = "big-scroll.engagement.v1";
const DEFAULT_LIMIT = 250;
const MAX_VIEW_MS = 15 * 60 * 1_000;

function isArticle(article) {
  return article
    && (typeof article.pageid === "number" || typeof article.pageid === "string")
    && typeof article.title === "string"
    && typeof article.url === "string";
}

function isEngagement(item) {
  return item
    && isArticle(item.article)
    && typeof item.clicked === "boolean"
    && Number.isFinite(item.viewMs)
    && Number.isFinite(item.updatedAt);
}

export class EngagementStore {
  constructor(storage = globalThis.localStorage, { limit = DEFAULT_LIMIT, now = Date.now } = {}) {
    this.storage = storage;
    this.limit = limit;
    this.now = now;
    this.records = new Map();
    try {
      const parsed = JSON.parse(storage?.getItem(ENGAGEMENT_KEY));
      if (parsed?.version === 1 && Array.isArray(parsed.engagements)) {
        for (const item of parsed.engagements.filter(isEngagement)) {
          this.records.set(String(item.article.pageid), item);
        }
        this.trim();
      }
    } catch {
      this.records.clear();
    }
  }

  keyFor(article) {
    return String(article.pageid);
  }

  values() {
    return [...this.records.values()].sort((left, right) => left.updatedAt - right.updatedAt);
  }

  get(article) {
    return this.records.get(this.keyFor(article));
  }

  update(article, changes) {
    const key = this.keyFor(article);
    const current = this.records.get(key) || { article, clicked: false, viewMs: 0, updatedAt: 0 };
    const next = { ...current, ...changes, article, updatedAt: this.now() };
    this.records.set(key, next);
    this.trim();
    this.persist();
    return next;
  }

  recordClick(article) {
    return this.update(article, { clicked: true });
  }

  recordView(article, elapsedMs) {
    const current = this.get(article);
    const viewMs = Math.min(MAX_VIEW_MS, (current?.viewMs || 0) + Math.max(0, Number(elapsedMs) || 0));
    return this.update(article, { viewMs });
  }

  trim() {
    const excess = this.records.size - this.limit;
    if (excess <= 0) return;
    for (const item of this.values().slice(0, excess)) this.records.delete(this.keyFor(item.article));
  }

  persist() {
    try {
      this.storage?.setItem(ENGAGEMENT_KEY, JSON.stringify({ version: 1, engagements: this.values() }));
      return Boolean(this.storage);
    } catch {
      return false;
    }
  }
}
