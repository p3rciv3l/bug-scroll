import { EngagementRecommender } from "./recommender.mjs";
import { EngagementStore } from "./engagement-store.mjs";
import { loadLikes, saveLikes } from "./likes-store.mjs";

const API_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const BATCH_SIZE = 10;
const PAGINATION_SETTLE_MS = 200;
const HEART_OUTLINE_PATH = "M480 840 422 788Q321 697 255 631T150 512.5Q111 460 95.5 416T80 326Q80 232 143 169T300 106Q352 106 399 128T480 190Q514 150 561 128T660 106Q754 106 817 169T880 326Q880 372 864.5 416T810 512.5Q771 565 705 631T538 788L480 840ZM480 732Q576 646 638 584.5T736 477.5Q772 432 786 396.5T800 326Q800 266 760 226T660 186Q613 186 573 212.5T518 280H442Q427 239 387 212.5T300 186Q240 186 200 226T160 326Q160 361 174 396.5T224 477.5Q260 523 322 584.5T480 732Z";
const HEART_FILL_PATH = "M480 840 422 788Q321 697 255 631T150 512.5Q111 460 95.5 416T80 326Q80 232 143 169T300 106Q352 106 399 128T480 190Q514 150 561 128T660 106Q754 106 817 169T880 326Q880 372 864.5 416T810 512.5Q771 565 705 631T538 788L480 840Z";
const feed = document.querySelector("#feed");
const status = document.querySelector("#status");
const openLikes = document.querySelector("#open-likes");
const closeLikes = document.querySelector("#close-likes");
const likesPanel = document.querySelector("#likes-panel");
const likedArticles = document.querySelector("#liked-articles");
const likesCount = document.querySelector("#likes-count");
const seen = new Set();
let likes = loadLikes();
const engagementStore = new EngagementStore();
const recommender = new EngagementRecommender({
  likedArticles: [...likes.values()],
  engagements: engagementStore.values(),
});
let loading = false;
let requestSequence = 0;
let loadTrigger = null;
let loadTimer = 0;
const trackedArticles = new Map();

function recordClick(article) {
  recommender.setEngagement(engagementStore.recordClick(article));
}

function recordView(article, elapsedMs) {
  if (elapsedMs <= 0) return;
  recommender.setEngagement(engagementStore.recordView(article, elapsedMs));
}

function trackingEnabled() {
  return !document.hidden && !likesPanel.classList.contains("open");
}

function startView(item, now = performance.now()) {
  if (item.eligible && item.startedAt === null && trackingEnabled()) item.startedAt = now;
}

function finishView(item, now = performance.now()) {
  if (item.startedAt === null) return;
  recordView(item.article, now - item.startedAt);
  item.startedAt = null;
}

function pauseViews() {
  const now = performance.now();
  for (const item of trackedArticles.values()) finishView(item, now);
}

function resumeViews() {
  const now = performance.now();
  for (const item of trackedArticles.values()) startView(item, now);
}

const dwellObserver = new IntersectionObserver((entries) => {
  const now = performance.now();
  for (const entry of entries) {
    const item = trackedArticles.get(entry.target);
    if (!item) continue;
    item.eligible = entry.isIntersecting && entry.intersectionRatio >= 0.6;
    if (item.eligible) startView(item, now);
    else finishView(item, now);
  }
}, { root: feed, threshold: [0, 0.6] });

function stopTracking(section) {
  const item = trackedArticles.get(section);
  if (item) finishView(item);
  trackedArticles.delete(section);
  dwellObserver.unobserve(section);
}

function persistLikes() {
  if (!saveLikes(likes)) {
    setStatus("Likes could not be saved on this device.");
  }
  likesCount.textContent = String(likes.size);
}

function setStatus(message, visible = true) {
  status.textContent = message;
  status.classList.toggle("visible", visible);
}

function articleImage(article) {
  return article.thumbnail?.source || "";
}

function createActionIcon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 960 960");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function setHeartState(button, article, liked) {
  button.replaceChildren(createActionIcon(liked ? HEART_FILL_PATH : HEART_OUTLINE_PATH));
  button.setAttribute("aria-label", `${liked ? "Unlike" : "Like"} ${article.title}`);
  button.setAttribute("aria-pressed", String(liked));
}

function prepareImage(image, source) {
  image.alt = "";
  image.decoding = "async";
  image.loading = "lazy";
  image.src = source;
}

function normalizeArticle(page) {
  return {
    pageid: page.pageid,
    title: page.title,
    extract: page.extract || "Open this article on Wikipedia to learn more.",
    url: page.fullurl || `https://en.wikipedia.org/?curid=${page.pageid}`,
    image: articleImage(page),
  };
}

async function fetchCandidates() {
  requestSequence += 1;
  const params = new URLSearchParams({
    action: "query",
    generator: "random",
    grnnamespace: "0",
    grnlimit: String(BATCH_SIZE),
    prop: "extracts|info|pageimages",
    exintro: "1",
    exlimit: "max",
    explaintext: "1",
    exsentences: "5",
    piprop: "thumbnail",
    pithumbsize: "800",
    inprop: "url",
    format: "json",
    origin: "*",
    _: String(requestSequence),
  });
  const response = await fetch(`${API_ENDPOINT}?${params}`, { cache: "default" });
  if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`);
  const payload = await response.json();
  return Object.values(payload.query?.pages || {})
    .map(normalizeArticle)
    .filter((article) => (
      article.pageid
      && article.image
      && article.extract.length > 15
      && !seen.has(String(article.pageid))
    ));
}

function createHeartButton(article) {
  const button = document.createElement("button");
  button.className = "heart-button";
  button.type = "button";
  const liked = likes.has(String(article.pageid));
  setHeartState(button, article, liked);
  button.addEventListener("click", () => toggleLike(article, button));
  return button;
}

function createArticle(article) {
  const section = document.createElement("article");
  section.className = "article";
  section.dataset.pageid = String(article.pageid);

  const image = document.createElement("img");
  image.className = "article-image";
  prepareImage(image, article.image);
  image.addEventListener("load", () => image.classList.add("is-loaded"));
  image.addEventListener("error", () => {
    stopTracking(section);
    observer.unobserve(section);
    section.remove();
    void loadMore();
  });
  section.append(image);

  const shade = document.createElement("div");
  shade.className = "article-shade";
  const content = document.createElement("div");
  content.className = "article-content";
  const heading = document.createElement("h2");
  heading.textContent = article.title;
  const extract = document.createElement("p");
  extract.textContent = article.extract;

  const actions = document.createElement("div");
  actions.className = "article-actions";
  actions.append(createHeartButton(article));
  const header = document.createElement("div");
  header.className = "article-header";
  header.append(heading, actions);
  const readLink = document.createElement("a");
  readLink.className = "read-link";
  readLink.href = article.url;
  readLink.target = "_blank";
  readLink.rel = "noopener noreferrer";
  readLink.textContent = "Read article →";
  readLink.addEventListener("click", () => recordClick(article));
  content.append(header, extract, readLink);
  section.append(shade, content);
  trackedArticles.set(section, { article, eligible: false, startedAt: null });
  dwellObserver.observe(section);
  return section;
}

function toggleLike(article, button) {
  const key = String(article.pageid);
  if (likes.has(key)) {
    likes.delete(key);
    recommender.unlike(article);
    if (button) setHeartState(button, article, false);
  } else {
    likes.set(key, article);
    recommender.like(article);
    if (button) setHeartState(button, article, true);
  }
  persistLikes();
  renderLikes();
}

function renderLikes() {
  likedArticles.replaceChildren();
  if (likes.size === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Tap a heart and the article will stay here—even after you close the tab.";
    likedArticles.append(empty);
    return;
  }

  for (const article of [...likes.values()].reverse()) {
    const card = document.createElement("article");
    card.className = "liked-card";
    const copy = document.createElement("div");
    copy.className = "liked-card-copy";
    const link = document.createElement("a");
    link.href = article.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = article.title;
    link.addEventListener("click", () => recordClick(article));
    const extract = document.createElement("p");
    extract.textContent = article.extract;
    copy.append(link, extract);
    const remove = document.createElement("button");
    remove.className = "remove-like";
    remove.type = "button";
    remove.textContent = "♥";
    remove.setAttribute("aria-label", `Unlike ${article.title}`);
    remove.addEventListener("click", () => {
      toggleLike(article, feed.querySelector(`[data-pageid="${article.pageid}"] .heart-button`));
    });
    if (article.image) {
      const image = document.createElement("img");
      image.className = "liked-card-image";
      prepareImage(image, article.image);
      card.append(image);
    }
    card.append(copy, remove);
    likedArticles.append(card);
  }
}

function scheduleLoadMore() {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    loadTimer = 0;
    void loadMore();
  }, PAGINATION_SETTLE_MS);
}

const observer = new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) scheduleLoadMore();
}, { root: feed, rootMargin: "100% 0px" });

feed.addEventListener("scroll", () => {
  if (loadTimer) scheduleLoadMore();
}, { passive: true });

async function loadMore(attempt = 0) {
  if (loading) return;
  loading = true;
  if (feed.children.length === 0) setStatus("Finding articles…");
  try {
    const candidates = await fetchCandidates();
    const ranked = recommender.rerank(candidates);
    const fragment = document.createDocumentFragment();
    for (const article of ranked) {
      seen.add(String(article.pageid));
      const element = createArticle(article);
      fragment.append(element);
    }
    feed.append(fragment);
    if (loadTrigger) observer.unobserve(loadTrigger);
    loadTrigger = feed.lastElementChild;
    if (loadTrigger) observer.observe(loadTrigger);
    setStatus("", false);
    if (ranked.length === 0) setTimeout(() => void loadMore(), 250);
  } catch (error) {
    const delay = Math.min(8000, 500 * (2 ** attempt));
    setStatus("Wikipedia is taking a moment…");
    setTimeout(() => void loadMore(attempt + 1), delay);
  } finally {
    loading = false;
  }
}

function showLikes() {
  pauseViews();
  renderLikes();
  feed.inert = true;
  openLikes.inert = true;
  likesPanel.inert = false;
  likesPanel.classList.add("open");
  likesPanel.setAttribute("aria-hidden", "false");
  closeLikes.focus();
}

function hideLikes() {
  likesPanel.inert = true;
  feed.inert = false;
  openLikes.inert = false;
  likesPanel.classList.remove("open");
  likesPanel.setAttribute("aria-hidden", "true");
  openLikes.focus();
  resumeViews();
}

openLikes.addEventListener("click", showLikes);
closeLikes.addEventListener("click", hideLikes);
likesPanel.inert = true;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) pauseViews();
  else resumeViews();
});
addEventListener("pagehide", pauseViews);
document.addEventListener("keydown", (event) => {
  if (!likesPanel.classList.contains("open")) return;
  if (event.key === "Escape") hideLikes();
  if (event.key === "Tab") {
    const focusable = [...likesPanel.querySelectorAll("button, a[href]")].filter((element) => !element.inert);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

persistLikes();
renderLikes();
void loadMore();

if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(() => {}), { once: true });
}
