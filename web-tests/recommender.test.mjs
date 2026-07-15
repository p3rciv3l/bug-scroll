import test from "node:test";
import assert from "node:assert/strict";
import {
  articleVector,
  dwellEvidence,
  EngagementRecommender,
  RECOMMENDER_DIMENSIONS,
} from "../site/recommender.mjs";

const space = { pageid: 1, title: "Moon mission", extract: "A spacecraft, rocket, astronaut and lunar orbit.", categories: ["Spaceflight"] };
const cooking = { pageid: 2, title: "French cuisine", extract: "Recipes, restaurants, bread, sauce and pastry.", categories: ["Cooking"] };

test("article vectors are normalized and bounded", () => {
  const vector = articleVector(space);
  const magnitude = Math.sqrt([...vector].reduce((total, value) => total + value * value, 0));
  assert.equal(vector.length, RECOMMENDER_DIMENSIONS);
  assert.ok(Math.abs(magnitude - 1) < 0.0001);
});

test("a like raises similar content above unrelated content", () => {
  const model = new EngagementRecommender({ likedArticles: [space] });
  assert.ok(model.score({ ...space, title: "Lunar spacecraft" }) > model.score(cooking));
});

test("click, like, and dwell form graded implicit confidence", () => {
  const longSpace = { ...space, pageid: 3 };
  const likedSpace = { ...space, pageid: 4 };
  const clickedSpace = { ...space, pageid: 5 };
  const combinedSpace = { ...space, pageid: 6 };
  const model = new EngagementRecommender({
    likedArticles: [likedSpace, combinedSpace],
    engagements: [
      { article: longSpace, viewMs: 45_000 },
      { article: clickedSpace, clicked: true },
      { article: combinedSpace, clicked: true },
    ],
  });

  assert.ok(model.evidenceWeight(combinedSpace) > model.evidenceWeight(clickedSpace));
  assert.ok(model.evidenceWeight(clickedSpace) > model.evidenceWeight(likedSpace));
  assert.ok(model.evidenceWeight(likedSpace) > model.evidenceWeight(longSpace));
  assert.ok(dwellEvidence(longSpace, 45_000) > dwellEvidence(longSpace, 5_000));
  assert.equal(dwellEvidence(longSpace, 3_600_000), 1);
});

test("the learned profile reconstructs from persisted likes", () => {
  const restored = new EngagementRecommender({ likedArticles: JSON.parse(JSON.stringify([space])) });
  assert.equal(restored.feedbackCount, 1);
  assert.ok(restored.score(space) > restored.score(cooking));
});

test("like then unlike restores the empty profile", () => {
  const model = new EngagementRecommender();
  model.like(space);
  model.unlike(space);
  assert.equal(model.feedbackCount, 0);
  assert.equal(model.score(space), 0);
});

test("repeating the same like is idempotent", () => {
  const model = new EngagementRecommender();
  model.like(space);
  const firstProfile = [...model.profile];
  model.like(space);
  assert.equal(model.feedbackCount, 1);
  assert.deepEqual([...model.profile], firstProfile);
});

test("the Rocchio centroid is independent of like order", () => {
  const left = new EngagementRecommender({ likedArticles: [space, cooking] });
  const right = new EngagementRecommender({ likedArticles: [cooking, space] });
  assert.deepEqual([...left.profile], [...right.profile]);
});

test("reranking is deterministic when exploration randomness is controlled", () => {
  const model = new EngagementRecommender({ likedArticles: [space] });
  const ranked = model.rerank([cooking, space], () => 0.99);
  assert.equal(ranked[0], space);
});

test("Gumbel sampling can explore an alternative without replacement", () => {
  const model = new EngagementRecommender({ likedArticles: [space] });
  const draws = [1 - Number.EPSILON, Number.EPSILON];
  const ranked = model.rerank([cooking, space], () => draws.shift());
  assert.deepEqual(ranked, [cooking, space]);
  assert.equal(new Set(ranked).size, ranked.length);
});

test("cold start shuffles instead of preserving API order", () => {
  const model = new EngagementRecommender();
  const ranked = model.rerank([space, cooking], () => 0);
  assert.deepEqual(ranked, [cooking, space]);
});
