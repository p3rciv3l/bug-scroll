# Mobile performance gate

On 2026-07-15, `compare-upstream.mjs` measured Big Scroll and untouched upstream commit
`552a5c1` in the same WebKit 26.5 process. Both used a 390 x 844 viewport, 3x scale, the
iPhone 13 user agent, 150 ms mocked Wikipedia latency, and a repeating 3 ms main-thread task
every 16 ms. Desktop input mode was used only for this comparison so WebKit could deliver
the same twelve wheel gestures to the native scroller and the upstream Compose canvas.
Screenshots/scroll offsets verified that both surfaces changed during the sample. Both are
warmed first, then run in alternating order for three measured trials; the table reports the
median trial so a one-off shared-runner scheduling stall cannot decide the deployment.

| Build | p95 frame gap | Frames over 50 ms | Maximum gap | Deployable size |
| --- | ---: | ---: | ---: | ---: |
| Big Scroll | 20 ms | 0 | 20 ms | 30,648 bytes |
| Upstream WikWok | 20 ms | 0 | 24 ms | 15,719,738 bytes |

Big Scroll therefore did not regress measured steady-state scroll latency in this constrained,
same-machine comparison. Reproduce it after building upstream with:

```sh
CURRENT_DIST=site \
UPSTREAM_DIST=/path/to/upstream/webApp/build/dist/wasmJs/productionExecutable \
node web-tests/compare-upstream.mjs
```

`browser/mobile.spec.mjs` is the deployment gate under Playwright's iPhone 13 emulation
(WebKit, viewport, scale, and user agent—not a physical phone). It starts with 30 persisted
likes, uses 180 ms mocked API latency plus the same main-thread pressure, scrolls through
more than 200 articles, checks the 48-card DOM and five-image bounds, records frame gaps,
verifies likes across reload, and asserts the absence of logo, About, and language controls.
`browser/cache.spec.mjs` separately allows the service worker, verifies its populated shell
cache remains readable while offline. CI builds untouched upstream `552a5c1`, runs this comparison,
on a macOS-hosted WebKit runner, and fails if Big Scroll exceeds upstream by more than 3 ms
at p95, one frame over 50 ms, or 10 ms at the maximum. The macOS runner is intentional:
Linux WebKit's headless native scroll-snap compositor is not the renderer used by iPhone Safari.
