export const RECOMMENDER_DIMENSIONS = 256;
const DIMENSIONS = RECOMMENDER_DIMENSIONS;
const MIN_VIEW_MS = 1_500;
const CLICK_WEIGHT = 1;
const LIKE_WEIGHT = 0.8;
const DWELL_WEIGHT = 0.55;
const CLICK_LIKE_INTERACTION = 0.35;
const CONFIDENCE_EPSILON = 0.1;
// The profile keeps the published positive-only Rocchio centroid, but weights
// each article with logarithmic implicit-feedback confidence and samples the
// final order without replacement using Gumbel-top-k:
// - https://nlp.stanford.edu/IR-book/html/htmledition/the-rocchio71-algorithm-1.html
// - https://yifanhu.net/PUB/cf.pdf (log-scaled implicit confidence)
// - https://hongliangjie.com/publications/recsys2014.pdf (graded dwell feedback)
// - https://arxiv.org/abs/1903.06059 (Gumbel-top-k sampling)
// - https://www.ietf.org/archive/id/draft-eastlake-fnv-25.html (FNV-1a)
// The 256 dimensions are an implementation memory bound, not a new ranking method.

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function articleVector(article) {
  const vector = new Float32Array(DIMENSIONS);
  const categories = (article.categories || []).map((category) => category.title || category).join(" ");
  const text = `${article.title || ""} ${categories} ${article.extract || ""}`.toLowerCase();
  const tokens = text.match(/[\p{L}\p{N}]{3,}/gu) || [];

  for (const token of tokens) {
    const hash = hashToken(token);
    const bucket = hash % DIMENSIONS;
    const sign = (hash & 256) === 0 ? 1 : -1;
    vector[bucket] += sign;
  }

  normalizeInPlace(vector);
  return vector;
}

function cosine(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function normalizeInPlace(vector) {
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  magnitude = Math.sqrt(magnitude) || 1;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude;
}

function wordCount(article) {
  return (`${article.title || ""} ${article.extract || ""}`.match(/[\p{L}\p{N}]+/gu) || []).length;
}

export function dwellEvidence(article, viewMs) {
  const expectedMs = Math.min(90_000, Math.max(12_000, (wordCount(article) / 3.5) * 1_000));
  const meaningfulMs = Math.max(0, Number(viewMs) - MIN_VIEW_MS);
  const expectedMeaningfulMs = expectedMs - MIN_VIEW_MS;
  return Math.min(1, Math.log1p((4 * meaningfulMs) / expectedMeaningfulMs) / Math.log(5));
}

export class EngagementRecommender {
  constructor({ likedArticles = [], engagements = [] } = {}) {
    this.profile = new Float32Array(DIMENSIONS);
    this.feedback = new Map();
    for (const engagement of engagements) this.setEngagement(engagement, false);
    for (const article of likedArticles) this.mergeFeedback(article, { liked: true }, false);
    this.rebuild();
  }

  get feedbackCount() {
    let count = 0;
    for (const item of this.feedback.values()) {
      if (this.evidenceWeight(item.article) > 0) count += 1;
    }
    return count;
  }

  keyFor(article) {
    return String(article.pageid ?? article.title);
  }

  mergeFeedback(article, changes, rebuild = true) {
    const key = this.keyFor(article);
    const current = this.feedback.get(key) || { article, clicked: false, liked: false, viewMs: 0 };
    this.feedback.set(key, { ...current, ...changes, article });
    if (rebuild) this.rebuild();
  }

  setEngagement(engagement, rebuild = true) {
    if (!engagement?.article) return;
    this.mergeFeedback(engagement.article, {
      clicked: Boolean(engagement.clicked),
      viewMs: Math.max(0, Number(engagement.viewMs) || 0),
    }, rebuild);
  }

  like(article) {
    this.mergeFeedback(article, { liked: true });
  }

  unlike(article) {
    const key = this.keyFor(article);
    const current = this.feedback.get(key);
    if (!current) return;
    if (!current.clicked && current.viewMs <= MIN_VIEW_MS) this.feedback.delete(key);
    else this.feedback.set(key, { ...current, liked: false });
    this.rebuild();
  }

  evidenceWeight(article) {
    const item = this.feedback.get(this.keyFor(article));
    if (!item) return 0;
    const clicked = item.clicked ? 1 : 0;
    const liked = item.liked ? 1 : 0;
    const rawEvidence = CLICK_WEIGHT * clicked
      + LIKE_WEIGHT * liked
      + DWELL_WEIGHT * dwellEvidence(item.article, item.viewMs)
      + CLICK_LIKE_INTERACTION * clicked * liked;
    return rawEvidence > 0 ? Math.log1p(rawEvidence / CONFIDENCE_EPSILON) : 0;
  }

  rebuild() {
    this.profile.fill(0);
    if (this.feedback.size === 0) return;
    const items = [...this.feedback.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, item]) => item);
    for (const item of items) {
      const weight = this.evidenceWeight(item.article);
      if (weight === 0) continue;
      const vector = articleVector(item.article);
      for (let index = 0; index < DIMENSIONS; index += 1) this.profile[index] += vector[index] * weight;
    }
    normalizeInPlace(this.profile);
  }

  score(article) {
    if (this.feedbackCount === 0) return 0;
    return cosine(this.profile, articleVector(article));
  }

  rerank(articles, random = Math.random) {
    if (this.feedbackCount === 0) {
      const shuffled = [...articles];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapWith = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swapWith]] = [shuffled[swapWith], shuffled[index]];
      }
      return shuffled;
    }
    const temperature = Math.max(0.14, 0.34 / Math.sqrt(this.feedbackCount));
    return articles
      .map((article) => {
        const uniform = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, random()));
        const gumbel = -Math.log(-Math.log(uniform));
        return { article, key: this.score(article) / temperature + gumbel };
      })
      .sort((left, right) => right.key - left.key)
      .map(({ article }) => article);
  }
}
