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

Pipeline: **screenshot → pre-pass → snapshot → rebuild → sanitise → embed → paste crops
→ CSP → serialise → PII scan**. Screenshots are taken before the pre-pass so canvas and
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

## Known limits

- Closed shadow roots cannot be read by any serialiser. The capture warns; ask the
  product team for an open root, or accept the screenshot crop.
- Cross-origin iframes are pasted as a screenshot region, so they are images, not DOM.
  Hotspots inside them must use coordinate anchoring.
- Pages taller than 12 viewports are truncated in the fallback PNG.
- `<video>` becomes its poster frame. Video steps are out of scope for v1 (§13).
