import { RocchioRecommender } from "./recommender.mjs";
import { loadLikes, saveLikes } from "./likes-store.mjs";

const API_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const BATCH_SIZE = 12;
const MAX_FEED_CARDS = 48;
const TARGET_FEED_CARDS = 36;
const KEEP_BEHIND = 12;
const feed = document.querySelector("#feed");
const status = document.querySelector("#status");
const openLikes = document.querySelector("#open-likes");
const closeLikes = document.querySelector("#close-likes");
const likesPanel = document.querySelector("#likes-panel");
const likedArticles = document.querySelector("#liked-articles");
const likesCount = document.querySelector("#likes-count");
const seen = new Set();
let likes = loadLikes();
const recommender = new RocchioRecommender([...likes.values()]);
let loading = false;
let requestSequence = 0;
let activeArticleId = null;
let pruneTimer = 0;

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

function whenIdle() {
  return new Promise((resolve) => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(resolve, { timeout: 300 });
    else setTimeout(resolve, 0);
  });
}

function articleImage(article) {
  return article.thumbnail?.source || "";
}

function normalizeArticle(page) {
  return {
    pageid: page.pageid,
    title: page.title,
    extract: page.extract || "Open this article on Wikipedia to learn more.",
    url: page.fullurl || `https://en.wikipedia.org/?curid=${page.pageid}`,
    image: articleImage(page),
    categories: (page.categories || []).filter(({ title }) => !title.includes("hidden categories")),
  };
}

async function fetchCandidates() {
  requestSequence += 1;
  const params = new URLSearchParams({
    action: "query",
    generator: "random",
    grnnamespace: "0",
    grnlimit: String(BATCH_SIZE),
    prop: "extracts|pageimages|info|categories",
    exintro: "1",
    explaintext: "1",
    piprop: "thumbnail",
    pithumbsize: "1000",
    inprop: "url",
    cllimit: "20",
    clshow: "!hidden",
    exchars: "900",
    format: "json",
    origin: "*",
    _: String(requestSequence),
  });
  const response = await fetch(`${API_ENDPOINT}?${params}`, { cache: "default" });
  if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`);
  const payload = await response.json();
  return Object.values(payload.query?.pages || {})
    .map(normalizeArticle)
    .filter((article) => article.pageid && !seen.has(String(article.pageid)));
}

function createHeartButton(article) {
  const button = document.createElement("button");
  button.className = "heart-button";
  button.type = "button";
  button.textContent = "♥";
  const liked = likes.has(String(article.pageid));
  button.setAttribute("aria-label", `${liked ? "Unlike" : "Like"} ${article.title}`);
  button.setAttribute("aria-pressed", String(liked));
  button.addEventListener("click", () => toggleLike(article, button));
  return button;
}

function createArticle(article) {
  const section = document.createElement("article");
  section.className = `article${article.image ? "" : " no-image"}`;
  section.dataset.pageid = String(article.pageid);

  if (article.image) {
    const image = document.createElement("img");
    image.className = "article-image";
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.dataset.src = article.image;
    section.append(image);
  }

  const shade = document.createElement("div");
  shade.className = "article-shade";
  const content = document.createElement("div");
  content.className = "article-content";
  const heading = document.createElement("h2");
  heading.textContent = article.title;
  const extract = document.createElement("p");
  extract.textContent = article.extract;
  content.append(heading, extract);

  const actions = document.createElement("div");
  actions.className = "article-actions";
  const readLink = document.createElement("a");
  readLink.className = "read-link";
  readLink.href = article.url;
  readLink.target = "_blank";
  readLink.rel = "noopener noreferrer";
  readLink.textContent = "Read";
  actions.append(createHeartButton(article), readLink);
  section.append(shade, content, actions);
  return section;
}

function toggleLike(article, button) {
  const key = String(article.pageid);
  if (likes.has(key)) {
    likes.delete(key);
    recommender.unlike(article);
    button?.setAttribute("aria-pressed", "false");
    button?.setAttribute("aria-label", `Like ${article.title}`);
  } else {
    likes.set(key, article);
    recommender.like(article);
    button?.setAttribute("aria-pressed", "true");
    button?.setAttribute("aria-label", `Unlike ${article.title}`);
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
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    if (article.image) image.src = article.image;
    const copy = document.createElement("div");
    copy.className = "liked-card-copy";
    const link = document.createElement("a");
    link.href = article.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = article.title;
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
    card.append(image, copy, remove);
    likedArticles.append(card);
  }
}

function hydrateNearbyImages() {
  const cards = [...feed.children];
  const activeIndex = cards.findIndex((card) => card.dataset.pageid === activeArticleId);
  for (let index = 0; index < cards.length; index += 1) {
    const image = cards[index].querySelector("img");
    if (!image) continue;
    if (Math.abs(index - activeIndex) <= 2 && !image.getAttribute("src")) {
      image.src = image.dataset.src;
    } else if (Math.abs(index - activeIndex) > 2) {
      image.removeAttribute("src");
    }
  }
}

function pruneFeed() {
  const cards = [...feed.children];
  if (cards.length <= MAX_FEED_CARDS) return;
  const activeIndex = cards.findIndex((card) => card.dataset.pageid === activeArticleId);
  const removeCount = Math.min(activeIndex - KEEP_BEHIND, cards.length - TARGET_FEED_CARDS);
  if (removeCount <= 0) return;
  let removedHeight = 0;
  for (const card of cards.slice(0, removeCount)) {
    removedHeight += card.getBoundingClientRect().height;
    observer.unobserve(card);
    card.remove();
  }
  feed.scrollTop = Math.max(0, feed.scrollTop - removedHeight);
}

function schedulePrune() {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(pruneFeed, 220);
}

function ensureFeedBuffer() {
  if (!activeArticleId || loading) return;
  const cards = [...feed.children];
  const activeIndex = cards.findIndex((card) => card.dataset.pageid === activeArticleId);
  if (activeIndex >= 0 && cards.length - activeIndex - 1 <= 5) void loadMore();
}

const observer = new IntersectionObserver((entries) => {
  const active = entries
    .filter((entry) => entry.isIntersecting)
    .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
  if (!active || active.intersectionRatio < 0.55) return;
  activeArticleId = active.target.dataset.pageid;
  hydrateNearbyImages();
  schedulePrune();
  ensureFeedBuffer();
}, { root: feed, threshold: [0.55, 0.85] });

async function loadMore(attempt = 0) {
  if (loading) return;
  loading = true;
  let appended = false;
  if (feed.children.length === 0) setStatus("Finding articles…");
  try {
    const candidates = await fetchCandidates();
    await whenIdle();
    const ranked = recommender.rerank(candidates);
    const fragment = document.createDocumentFragment();
    for (const article of ranked) {
      seen.add(String(article.pageid));
      const element = createArticle(article);
      fragment.append(element);
      observer.observe(element);
    }
    feed.append(fragment);
    appended = true;
    if (!activeArticleId && feed.firstElementChild) {
      activeArticleId = feed.firstElementChild.dataset.pageid;
      hydrateNearbyImages();
    }
    setStatus("", false);
    if (ranked.length < 4) setTimeout(() => void loadMore(), 250);
  } catch (error) {
    const delay = Math.min(8000, 500 * (2 ** attempt));
    setStatus("Wikipedia is taking a moment…");
    setTimeout(() => void loadMore(attempt + 1), delay);
  } finally {
    loading = false;
    // Fill the bounded working set before the reader reaches it. This keeps
    // network completion, ranking, and DOM insertion out of normal scrolling.
    if (appended && feed.children.length < TARGET_FEED_CARDS) {
      setTimeout(() => void loadMore(), 0);
      return;
    }
    // A very fast swipe can reach the end while the preceding request is still
    // completing. Recheck after releasing the lock so that gesture cannot stall.
    setTimeout(ensureFeedBuffer, 0);
  }
}

function showLikes() {
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
}

openLikes.addEventListener("click", showLikes);
closeLikes.addEventListener("click", hideLikes);
likesPanel.inert = true;
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
