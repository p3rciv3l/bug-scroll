import { RocchioRecommender } from "./recommender.mjs";
import { loadLikes, saveLikes } from "./likes-store.mjs";

const API_ENDPOINT = "https://en.wikipedia.org/w/api.php";
const BATCH_SIZE = 12;
const MAX_FEED_CARDS = 48;
const TARGET_FEED_CARDS = 36;
const KEEP_BEHIND = 12;
const IMAGE_RETRY_LIMIT = 2;
const HEART_OUTLINE_PATH = "M480 840 422 788Q321 697 255 631T150 512.5Q111 460 95.5 416T80 326Q80 232 143 169T300 106Q352 106 399 128T480 190Q514 150 561 128T660 106Q754 106 817 169T880 326Q880 372 864.5 416T810 512.5Q771 565 705 631T538 788L480 840ZM480 732Q576 646 638 584.5T736 477.5Q772 432 786 396.5T800 326Q800 266 760 226T660 186Q613 186 573 212.5T518 280H442Q427 239 387 212.5T300 186Q240 186 200 226T160 326Q160 361 174 396.5T224 477.5Q260 523 322 584.5T480 732Z";
const HEART_FILL_PATH = "M480 840 422 788Q321 697 255 631T150 512.5Q111 460 95.5 416T80 326Q80 232 143 169T300 106Q352 106 399 128T480 190Q514 150 561 128T660 106Q754 106 817 169T880 326Q880 372 864.5 416T810 512.5Q771 565 705 631T538 788L480 840Z";
const SHARE_PATH = "M680 880Q630 880 595 845T560 760Q560 754 563 732L282 568Q266 583 245 591.5T200 600Q150 600 115 565T80 480Q80 430 115 395T200 360Q224 360 245 368.5T282 392L563 228Q560 217 560 200Q560 150 595 115T680 80Q730 80 765 115T800 200Q800 250 765 285T680 320Q656 320 635 311.5T598 288L317 452Q320 463 320 480T317 508L598 672Q614 657 635 648.5T680 640Q730 640 765 675T800 760Q800 810 765 845T680 880ZM680 800Q697 800 708.5 788.5T720 760Q720 743 708.5 731.5T680 720Q663 720 651.5 731.5T640 760Q640 777 651.5 788.5T680 800ZM200 520Q217 520 228.5 508.5T240 480Q240 463 228.5 451.5T200 440Q183 440 171.5 451.5T160 480Q160 497 171.5 508.5T200 520ZM680 240Q697 240 708.5 228.5T720 200Q720 183 708.5 171.5T680 160Q663 160 651.5 171.5T640 200Q640 217 651.5 228.5T680 240Z";
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
const imageRetryTimers = new WeakMap();

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

function clearImageRetry(image) {
  const timer = imageRetryTimers.get(image);
  if (timer) clearTimeout(timer);
  imageRetryTimers.delete(image);
}

function retryImage(image) {
  if (image.dataset.hydrated !== "true") return;
  const retry = Number(image.dataset.retryCount || 0) + 1;
  if (retry > IMAGE_RETRY_LIMIT) {
    image.closest(".article")?.classList.add("image-failed");
    return;
  }
  image.dataset.retryCount = String(retry);
  clearImageRetry(image);
  const timer = setTimeout(() => {
    if (!image.isConnected || image.dataset.hydrated !== "true") return;
    const url = new URL(image.dataset.src, location.href);
    url.searchParams.set("big_scroll_retry", String(retry));
    image.removeAttribute("src");
    requestAnimationFrame(() => {
      if (image.isConnected && image.dataset.hydrated === "true") image.src = url.href;
    });
  }, 160 * (2 ** (retry - 1)));
  imageRetryTimers.set(image, timer);
}

function prepareRetriableImage(image, source, { manualHydration = true } = {}) {
  image.alt = "";
  image.decoding = "async";
  image.loading = manualHydration ? "eager" : "lazy";
  image.dataset.src = source;
  image.dataset.hydrated = manualHydration ? "false" : "true";
  image.dataset.retryCount = "0";
  image.addEventListener("load", () => {
    clearImageRetry(image);
    image.classList.add("is-loaded");
    image.closest(".article")?.classList.remove("image-failed");
  });
  image.addEventListener("error", () => {
    image.classList.remove("is-loaded");
    retryImage(image);
  });
  if (!manualHydration) image.src = source;
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
  const liked = likes.has(String(article.pageid));
  setHeartState(button, article, liked);
  button.addEventListener("click", () => toggleLike(article, button));
  return button;
}

async function shareArticle(article) {
  try {
    if (navigator.share) {
      await navigator.share({ title: article.title, url: article.url });
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(article.url);
      setStatus("Link copied.");
      setTimeout(() => setStatus("", false), 1400);
      return;
    }
    window.open(article.url, "_blank", "noopener,noreferrer");
  } catch (error) {
    if (error?.name !== "AbortError") window.open(article.url, "_blank", "noopener,noreferrer");
  }
}

function createShareButton(article) {
  const button = document.createElement("button");
  button.className = "share-button";
  button.type = "button";
  button.setAttribute("aria-label", `Share ${article.title}`);
  button.append(createActionIcon(SHARE_PATH));
  button.addEventListener("click", () => void shareArticle(article));
  return button;
}

function createArticle(article) {
  const section = document.createElement("article");
  section.className = `article${article.image ? "" : " no-image"}`;
  section.dataset.pageid = String(article.pageid);

  if (article.image) {
    const image = document.createElement("img");
    image.className = "article-image";
    prepareRetriableImage(image, article.image);
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

  const actions = document.createElement("div");
  actions.className = "article-actions";
  actions.append(createHeartButton(article), createShareButton(article));
  const header = document.createElement("div");
  header.className = "article-header";
  header.append(heading, actions);
  const readLink = document.createElement("a");
  readLink.className = "read-link";
  readLink.href = article.url;
  readLink.target = "_blank";
  readLink.rel = "noopener noreferrer";
  readLink.textContent = "Read article →";
  content.append(header, extract, readLink);
  section.append(shade, content);
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
      prepareRetriableImage(image, article.image, { manualHydration: false });
      card.append(image);
    }
    card.append(copy, remove);
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
      image.dataset.hydrated = "true";
      image.dataset.retryCount = "0";
      image.src = image.dataset.src;
    } else if (Math.abs(index - activeIndex) > 2) {
      image.dataset.hydrated = "false";
      image.dataset.retryCount = "0";
      clearImageRetry(image);
      image.classList.remove("is-loaded");
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
