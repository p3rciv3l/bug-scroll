export const RECOMMENDER_DIMENSIONS = 256;
const DIMENSIONS = RECOMMENDER_DIMENSIONS;
const MIN_VIEW_MS = 1_500;
const LONG_DWELL_PRIOR_MS = 15_000;
const LEARNING_RATE = 0.08;
const REGULARIZATION = 0.002;
const MAX_PAIR_UPDATES = 512;
const MAX_UNOBSERVED_UPDATES = 256;
const MIN_UNOBSERVED_SAMPLES_PER_ITEM = 8;
// This is a content-based implementation of published Multi-Feedback BPR:
// stronger observed behavior forms pairwise preferences over weaker behavior,
// optimized with the standard BPR logistic update. Pair sampling is stratified
// across channel pairs; a same-level-only history samples real current candidates
// as BPR's unobserved items. Gumbel-top-k samples serving order without replacement:
// - https://repository.ubn.ru.nl/bitstream/handle/2066/161872/1/161872.pdf
// - https://www.ismll.uni-hildesheim.de/pub/pdfs/Rendle_et_al2009-Bayesian_Personalized_Ranking.pdf
// - https://hongliangjie.com/publications/recsys2014.pdf (log/context dwell bins)
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

function quantile(sorted, fraction) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const mix = position - lower;
  return sorted[lower] * (1 - mix) + sorted[upper] * mix;
}

export function dwellLevel(viewMs, contextViewMs = []) {
  const elapsed = Math.max(0, Number(viewMs) || 0);
  if (elapsed === 0) return 0;
  if (elapsed < MIN_VIEW_MS) return 6;
  const logContext = [LONG_DWELL_PRIOR_MS, ...contextViewMs]
    .filter((value) => Number(value) >= MIN_VIEW_MS)
    .map((value) => Math.log1p(Number(value)))
    .sort((left, right) => left - right);
  const longThreshold = Math.expm1(quantile(logContext, 0.75));
  return elapsed >= longThreshold ? 4 : 5;
}

export class MultiFeedbackBprRecommender {
  constructor({ likedArticles = [], engagements = [] } = {}) {
    this.profile = new Float32Array(DIMENSIONS);
    this.feedback = new Map();
    this.activeFeedbackCount = 0;
    this.hasPreference = false;
    this.rankedEvidence = [];
    for (const engagement of engagements) this.setEngagement(engagement, false);
    for (const article of likedArticles) this.mergeFeedback(article, { liked: true }, false);
    this.rebuild();
  }

  get feedbackCount() {
    return this.activeFeedbackCount;
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
    if (!current.clicked && current.viewMs === 0) this.feedback.delete(key);
    else this.feedback.set(key, { ...current, liked: false });
    this.rebuild();
  }

  evidenceLevel(article, contextViewMs = this.contextViewMs()) {
    const item = this.feedback.get(this.keyFor(article));
    if (!item) return 0;
    if (item.clicked && item.liked) return 1;
    if (item.clicked) return 2;
    if (item.liked) return 3;
    return dwellLevel(item.viewMs, contextViewMs);
  }

  contextViewMs() {
    return [...this.feedback.values()].map((item) => item.viewMs).filter((value) => value >= MIN_VIEW_MS);
  }

  rankedFeedback() {
    const context = this.contextViewMs();
    return [...this.feedback.entries()]
      .map(([key, item]) => ({ key, item, level: this.evidenceLevel(item.article, context) }))
      .filter(({ level }) => level > 0)
      .sort((left, right) => left.level - right.level || left.key.localeCompare(right.key));
  }

  updatePair(positive, negative, rate = LEARNING_RATE) {
    let margin = 0;
    for (let index = 0; index < DIMENSIONS; index += 1) {
      margin += this.profile[index] * (positive[index] - negative[index]);
    }
    const gain = 1 / (1 + Math.exp(Math.max(-30, Math.min(30, margin))));
    for (let index = 0; index < DIMENSIONS; index += 1) {
      const delta = positive[index] - negative[index];
      this.profile[index] += rate * (gain * delta - 2 * REGULARIZATION * this.profile[index]);
    }
  }

  rebuild() {
    this.profile.fill(0);
    const ranked = this.rankedFeedback().map((entry) => ({ ...entry, vector: articleVector(entry.item.article) }));
    this.rankedEvidence = ranked;
    this.activeFeedbackCount = ranked.length;
    this.hasPreference = false;
    if (ranked.length === 0) return;

    const groups = new Map();
    for (const entry of ranked) {
      if (!groups.has(entry.level)) groups.set(entry.level, []);
      groups.get(entry.level).push(entry);
    }
    const levelPairs = [];
    for (const [strongerLevel, stronger] of groups) {
      for (const [weakerLevel, weaker] of groups) {
        if (strongerLevel < weakerLevel) levelPairs.push({ stronger, weaker });
      }
    }
    if (levelPairs.length === 0) return;

    const pairBudget = Math.max(1, Math.floor(MAX_PAIR_UPDATES / levelPairs.length));
    for (const { stronger, weaker } of levelPairs) {
      const totalPairs = stronger.length * weaker.length;
      const samples = Math.min(pairBudget, totalPairs);
      for (let sample = 0; sample < samples; sample += 1) {
        const flatIndex = Math.min(totalPairs - 1, Math.floor(((sample + 0.5) * totalPairs) / samples));
        const positive = stronger[Math.floor(flatIndex / weaker.length)];
        const negative = weaker[flatIndex % weaker.length];
        this.updatePair(positive.vector, negative.vector);
      }
    }
    this.hasPreference = true;
    normalizeInPlace(this.profile);
  }

  trainAgainstUnobserved(articles) {
    const candidates = articles
      .filter((article) => !this.feedback.has(this.keyFor(article)))
      .sort((left, right) => this.keyFor(left).localeCompare(this.keyFor(right)))
      .map((article) => ({ article, vector: articleVector(article) }));
    if (this.rankedEvidence.length === 0 || candidates.length === 0) return;
    const groups = new Map();
    for (const entry of this.rankedEvidence) {
      if (!groups.has(entry.level)) groups.set(entry.level, []);
      groups.get(entry.level).push(entry);
    }
    const levelBudget = Math.max(1, Math.floor(MAX_UNOBSERVED_UPDATES / groups.size));
    for (const positives of groups.values()) {
      const totalPairs = positives.length * candidates.length;
      const samples = Math.min(
        levelBudget,
        Math.max(totalPairs, positives.length * MIN_UNOBSERVED_SAMPLES_PER_ITEM),
      );
      for (let sample = 0; sample < samples; sample += 1) {
        const flatIndex = Math.min(totalPairs - 1, Math.floor(((sample + 0.5) * totalPairs) / samples));
        const positive = positives[Math.floor(flatIndex / candidates.length)];
        const negative = candidates[flatIndex % candidates.length];
        this.updatePair(positive.vector, negative.vector);
      }
    }
    this.hasPreference = true;
    normalizeInPlace(this.profile);
  }

  score(article) {
    if (!this.hasPreference) return 0;
    return cosine(this.profile, articleVector(article));
  }

  rerank(articles, random = Math.random) {
    if (this.feedbackCount > 0) this.trainAgainstUnobserved(articles);
    if (!this.hasPreference) {
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
