import test from "node:test";
import assert from "node:assert/strict";
import {
  articleVector,
  dwellLevel,
  MultiFeedbackBprRecommender,
  RECOMMENDER_DIMENSIONS,
} from "../site/recommender.mjs";

const space = { pageid: 1, title: "Moon mission", extract: "A spacecraft, rocket, astronaut and lunar orbit.", categories: ["Spaceflight"] };
const cooking = { pageid: 2, title: "French cuisine", extract: "Recipes, restaurants, bread, sauce and pastry.", categories: ["Cooking"] };
const music = { pageid: 3, title: "String quartet", extract: "Violin, viola, cello, chamber music and composition.", categories: ["Music"] };

test("article vectors are normalized and bounded", () => {
  const vector = articleVector(space);
  const magnitude = Math.sqrt([...vector].reduce((total, value) => total + value * value, 0));
  assert.equal(vector.length, RECOMMENDER_DIMENSIONS);
  assert.ok(Math.abs(magnitude - 1) < 0.0001);
});

test("a like raises similar content above unrelated content", () => {
  const model = new MultiFeedbackBprRecommender({ likedArticles: [space] });
  model.rerank([cooking, { ...space, pageid: 7 }], () => 0.5);
  assert.ok(model.score({ ...space, title: "Lunar spacecraft" }) > model.score(cooking));
});

test("a lone click learns from real unobserved candidates", () => {
  const model = new MultiFeedbackBprRecommender({ engagements: [{ article: space, clicked: true }] });
  const ranked = model.rerank([cooking, { ...space, pageid: 7 }], () => 0.5);
  assert.equal(ranked[0].title, space.title);
});

test("MF-BPR assigns click, like, and contextual dwell to ordered feedback levels", () => {
  const longSpace = { ...space, pageid: 3 };
  const likedSpace = { ...space, pageid: 4 };
  const clickedSpace = { ...space, pageid: 5 };
  const combinedSpace = { ...space, pageid: 6 };
  const model = new MultiFeedbackBprRecommender({
    likedArticles: [likedSpace, combinedSpace],
    engagements: [
      { article: longSpace, viewMs: 45_000 },
      { article: clickedSpace, clicked: true },
      { article: combinedSpace, clicked: true },
    ],
  });

  const context = [5_000, 45_000];
  assert.equal(model.evidenceLevel(combinedSpace, context), 1);
  assert.equal(model.evidenceLevel(clickedSpace, context), 2);
  assert.equal(model.evidenceLevel(likedSpace, context), 3);
  assert.equal(model.evidenceLevel(longSpace, context), 4);
  assert.equal(dwellLevel(5_000, context), 5);
  assert.equal(dwellLevel(500, context), 6);
  assert.equal(dwellLevel(0, context), 0);
});

test("MF-BPR learns a stronger channel preference over weaker viewed content", () => {
  const model = new MultiFeedbackBprRecommender({
    likedArticles: [space],
    engagements: [
      { article: space, clicked: true },
      { article: cooking, viewMs: 5_000 },
    ],
  });

  assert.ok(model.score(space) > model.score(cooking));
});

test("every positive feedback level remains above unobserved content", () => {
  const model = new MultiFeedbackBprRecommender({
    likedArticles: [cooking],
    engagements: [{ article: space, clicked: true }],
  });
  model.rerank([music], () => 0.5);

  assert.ok(model.score(space) > model.score(cooking));
  assert.ok(model.score(cooking) > model.score(music));
});

test("the learned profile reconstructs from persisted multi-channel feedback", () => {
  const restored = new MultiFeedbackBprRecommender({
    likedArticles: JSON.parse(JSON.stringify([space])),
    engagements: [{ article: cooking, viewMs: 500 }],
  });
  assert.equal(restored.feedbackCount, 2);
  assert.ok(restored.score(space) > restored.score(cooking));
});

test("like then unlike restores the empty profile", () => {
  const model = new MultiFeedbackBprRecommender();
  model.like(space);
  model.unlike(space);
  assert.equal(model.feedbackCount, 0);
  assert.equal(model.score(space), 0);
});

test("unlike preserves a short-view level across reconstruction", () => {
  const model = new MultiFeedbackBprRecommender({
    likedArticles: [space],
    engagements: [{ article: space, viewMs: 500 }],
  });
  model.unlike(space);
  const restored = new MultiFeedbackBprRecommender({ engagements: [{ article: space, viewMs: 500 }] });
  assert.equal(model.evidenceLevel(space), 6);
  assert.equal(model.feedbackCount, restored.feedbackCount);
});

test("repeating the same like is idempotent", () => {
  const model = new MultiFeedbackBprRecommender();
  model.like(space);
  const firstProfile = [...model.profile];
  model.like(space);
  assert.equal(model.feedbackCount, 1);
  assert.deepEqual([...model.profile], firstProfile);
});

test("the MF-BPR profile reconstruction is independent of storage order", () => {
  const left = new MultiFeedbackBprRecommender({ likedArticles: [space, cooking] });
  const right = new MultiFeedbackBprRecommender({ likedArticles: [cooking, space] });
  assert.deepEqual([...left.profile], [...right.profile]);
});

test("reranking is deterministic when exploration randomness is controlled", () => {
  const model = new MultiFeedbackBprRecommender({
    likedArticles: [space],
    engagements: [{ article: cooking, viewMs: 500 }],
  });
  const ranked = model.rerank([cooking, space], () => 0.99);
  assert.equal(ranked[0], space);
});

test("Gumbel sampling can explore an alternative without replacement", () => {
  const model = new MultiFeedbackBprRecommender({
    likedArticles: [space],
    engagements: [{ article: cooking, viewMs: 500 }],
  });
  const draws = [1 - Number.EPSILON, Number.EPSILON];
  const ranked = model.rerank([cooking, space], () => draws.shift());
  assert.deepEqual(ranked, [cooking, space]);
  assert.equal(new Set(ranked).size, ranked.length);
});

test("cold start shuffles instead of preserving API order", () => {
  const model = new MultiFeedbackBprRecommender();
  const ranked = model.rerank([space, cooking], () => 0);
  assert.deepEqual(ranked, [cooking, space]);
});
