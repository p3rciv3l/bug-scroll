export async function mockWikipedia(page, {
  latency = 120,
  pattern = "https://en.wikipedia.org/w/api.php**",
  titlePrefix = "Test article",
  imageSource = () => "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='390' height='844'%3E%3Crect width='100%25' height='100%25' fill='%23263548'/%3E%3C/svg%3E",
} = {}) {
  const state = { calls: 0, urls: [] };
  await page.route(pattern, async (route) => {
    state.calls += 1;
    state.urls.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, latency));
    const pages = {};
    const requestedLimit = Number(new URL(route.request().url()).searchParams.get("grnlimit")) || 12;
    for (let index = 0; index < requestedLimit; index += 1) {
      const pageid = state.calls * 100 + index;
      pages[pageid] = {
        pageid,
        title: `${titlePrefix} ${pageid}`,
        extract: "Science, history, culture, technology, medicine, and art in a compact summary.",
        fullurl: `https://en.wikipedia.org/?curid=${pageid}`,
        thumbnail: imageSource ? { source: imageSource({ pageid, index }) } : undefined,
        categories: [{ title: `Category:Topic ${index % 4}` }],
      };
    }
    await route.fulfill({ json: { query: { pages } } });
  });
  return state;
}

export async function addConstrainedCpuLoad(page) {
  await page.addInitScript(() => {
    setInterval(() => {
      const finish = performance.now() + 3;
      while (performance.now() < finish) { /* approximate a slower phone main thread */ }
    }, 16);
  });
}
