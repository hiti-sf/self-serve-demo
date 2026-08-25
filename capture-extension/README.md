# Capture extension (Chrome MV3)

Turns a live product screen into the capture trio the editor imports:

```
snapshot.html      self-contained, script-free DOM capture
fallback.png       full-page screenshot (the player's fallback path, SPEC §4)
capture-meta.json  viewport, URL, timestamp, warnings, anchor hints
```

## Install (development)

```bash
pnpm --filter @demo-platform/capture-extension build
# chrome://extensions → Developer mode → Load unpacked → capture-extension/dist
```

Grant host access when prompted: the extension asks for `<all_urls>` as an *optional*
permission and uses it only to fetch page resources (fonts, images, cross-origin
stylesheets) so they can be embedded as data URIs.

## Capturing

1. Navigate the product to the state you want — expand the menu, open the modal, filter
   the table. The capture records the DOM as it is *now*, not the page source.
2. Click the extension icon → **Capture this screen**.
3. Review the capture notes. Anything rasterised, dropped or left as an external
   reference is listed there.
4. Review possible personal data. Demo data must be synthetic (§11); tick anything to
   replace with `[redacted]`.
5. Name the folder and **Save capture trio**.

## How it works

Four contexts, because each owns a capability the others lack:

| Context | Responsibility |
|---|---|
| content script | live DOM access: pre-pass + `rrweb-snapshot` traversal |
| service worker | page screenshots, privileged `fetch`, file writes |
| offscreen document | a DOM to rebuild into, `OffscreenCanvas` for stitching/cropping |
| popup | the author's review and redaction decisions |

Pipeline: **screenshot → pre-pass → snapshot → rebuild → flatten shadow roots → sanitise →
embed → paste crops → CSP → serialise → PII scan**. Screenshots are taken before the pre-pass so canvas and
cross-origin-iframe regions can be cropped from the untouched page.

See [EVALUATION.md](./EVALUATION.md) for why `rrweb-snapshot` is wrapped and
`single-file-core` is not.

## Guarantees

- **No scripts.** Removed by rrweb's `slimDOM`, then by our sanitiser, then blocked by
  the snapshot's own CSP, then sandboxed again by the player. Four layers.
- **No network at render time.** Every external reference is embedded or dropped; the
  converter reports any that survive. The kiosk build lint fails the build if one does.
- **The product page is left as found.** Every DOM mutation is journalled and undone,
  including the scroll position.
- **Shadow DOM survives.** Open shadow roots are rewritten as declarative
  `<template shadowrootmode="open">`, which the HTML parser reinstates without script.

## Known limits

- Closed shadow roots cannot be read by any serialiser — open ones survive intact, but a
  closed root is opaque even to the page. The capture warns; ask the product team for an
  open root, or accept the screenshot crop.
- Cross-origin iframes are pasted as a screenshot region, so they are images, not DOM.
  Hotspots inside them must use coordinate anchoring.
- Pages taller than 12 viewports are truncated in the fallback PNG.
- `<video>` becomes its poster frame. Video steps are out of scope for v1 (§13).

## Verifying a build

```bash
pnpm smoke:capture
```

Loads the built extension into a real headless Chrome and drives a genuine capture
against [`test-fixture/app.html`](./test-fixture/app.html), served from two ports so the
"CDN" is genuinely cross-origin with no CORS header. The fixture applies all of its
interesting state *after* load — typed values, a chosen option, an open menu, an open
modal, a scrolled container — so a serialiser reading page source instead of live DOM
fails immediately.

It then renders the snapshot with `--host-resolver-rules=MAP * ~NOTFOUND` and reads the
DOM back, and leaves two images in `.smoke/capture/` to compare by eye:

```
live-page.png                    the fixture as Chrome rendered it
snapshot-rendered-offline.png    the snapshot, with nothing resolving
```

## Capturing against the real InLumin tenant (M1 sign-off)

The fixture proves the machinery. It cannot prove that *InLumin's* markup serialises
faithfully — that needs the tenant, a logged-in session, and a person looking at the
result. Whoever has access should work through this once:

1. **Build and load.**
   ```bash
   pnpm build:extension
   # chrome://extensions → Developer mode → Load unpacked → capture-extension/dist
   ```
2. **Sign in** to `https://app.in-lumin.com` in that Chrome profile, as a user whose data
   is safe to show. §11 requires demo data to be synthetic: prefer a seeded demo tenant
   over a real customer account, and do not capture a screen you would not screenshot
   into a slide deck.
3. **Grant host access when the popup asks.** The extension holds `<all_urls>` as an
   optional permission and only requests it on the first capture. Without it, cross-origin
   fonts, images and stylesheets cannot be embedded and the worker refuses to capture
   rather than writing a snapshot that would need the network.
4. **Capture five screens**, per §12's M1 gate, including at least one canvas-heavy view
   (spend analytics) and one modal. Drive the product into the exact state first.
5. **Read the capture notes.** Anything listed as rasterised, cropped or dropped is a
   fidelity decision you are accepting. `cross-origin-iframe` and `shadow-root-closed`
   are the two worth pushing back to the product team about.
6. **Redact.** Tick every real name, address, email or identifier the PII pass flags. It
   is a detector, not a guarantee — read the screen yourself too.
7. **Verify offline**, which is the actual acceptance criterion:
   ```bash
   pnpm validate:demos
   pnpm build:kiosk --demo inlumin-flow-01     # fails on any surviving external URL
   pnpm smoke:player demos/inlumin/flow-01-requisition-to-po
   ```
8. **Look at it.** Open the snapshot next to the live screen. Fonts, spacing, chart,
   avatars, icons. A green build with a snapshot that looks wrong is still a failure.

If a screen captures badly, the capture notes name the element and the reason. File it
with the reason — every limit in **Known limits** above is a real constraint of static
capture, not a bug.
