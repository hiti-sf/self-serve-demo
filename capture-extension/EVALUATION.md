# Serialisation library evaluation

SPEC §5 requires evaluating `rrweb`'s snapshot module and `single-file-core` before
writing DOM serialisation by hand. This is the outcome and the decision it drove.

Evaluated at versions `rrweb-snapshot@2.1.1` and `single-file-core@1.5.88`.

## single-file-core — rejected on licence

`single-file-core` produces the best self-contained HTML of anything available: it is the
engine behind the SingleFile extension, and it handles stylesheet inlining, font
embedding, lazy-loaded images and frame trees more thoroughly than we would.

It is licensed **AGPL-3.0-or-later**, with an additional permission only for
distributing *unmodified* files:

```
single-file-core@1.5.88/package.json → "license": "AGPL-3.0-or-later"
```

That is disqualifying for this platform, on two counts:

1. **Kiosk bundles are distributed.** A sales engineer copies the bundle to a USB stick
   and hands it around. Distribution of a combined work under AGPL §5 would require
   offering the corresponding source of the whole player.
2. **The gated web player is served over a network.** AGPL §13 extends the source-offer
   obligation to users interacting with the software remotely.

Using it would mean either publishing the demo platform's source or negotiating a
commercial relicence with the author. Neither is a decision this build can make, so the
library is out. If Legal later clears it, `single-file-core` is the drop-in upgrade path
for `src/offscreen/convert.ts` — the pipeline boundary is deliberately narrow.

## rrweb-snapshot — adopted for DOM traversal

`rrweb-snapshot` is **MIT**, and its `snapshot()` covers exactly the traversal work that
is a known time sink to hand-roll:

| Requirement (§5) | rrweb-snapshot |
|---|---|
| Inline stylesheets | `inlineStylesheet: true` — walks `cssRules`, including `@import`ed rules |
| Embed images | `inlineImages: true` (page-context; CORS-blocked ones are handled by us) |
| Post-interaction state | serialises live input/checkbox/select/textarea state |
| Shadow DOM | serialises open shadow roots, rebuilt as declarative shadow DOM |
| Same-origin iframes | descends into child documents |
| `<canvas>` | `recordCanvas: true` |
| Strip scripts | `slimDOM.script: true` at serialise time; survivors rebuild as `<noscript>` |

Two properties made it a good fit beyond the feature list:

- **`rebuild()` refuses an unprotected document.** The library throws unless you target a
  `sandbox="allow-same-origin"` iframe (`rebuildIntoSandboxedIframe`). We rebuild inside
  the extension's offscreen document, so untrusted product markup is never rebuilt into a
  privileged page.
- **Its output is data, not HTML.** rrweb's artefact is a serialised node tree meant to be
  rehydrated by rrweb at replay time. That is the wrong artefact for us — it would put a
  JS runtime dependency inside every snapshot and break both `snapshot: "…html"` in the
  manifest (§4) and the script-free guarantee (§11).

## Decision: wrap rrweb, convert to static HTML at capture time

```
content script      rrweb-snapshot snapshot()          → serialised tree
   ↑ our pre-pass:  freeze state, canvas/WebGL, cross-origin frames, video, anchor hints
offscreen document  rrweb rebuildIntoSandboxedIframe() → live DOM in a sandbox
   ↓ our post-pass: sanitise → embed resources → paste screenshot crops → CSP → serialise
artefact            snapshot.html + fallback.png + capture-meta.json
```

We use rrweb for traversal and rehydration, then serialise to static HTML ourselves. The
snapshot that ships contains no rrweb code and no scripts at all.

## What we still had to own

rrweb is built for session replay, not for offline-faithful archival, so these gaps are
ours (each has unit tests):

- **`src/lib/embed.ts`** — rrweb inlines what the *page* can read. Cross-origin
  stylesheets, fonts and images are fetched through the service worker's privileged
  `fetch` and rewritten to data URIs, including `url()` references resolved against the
  *stylesheet's* href rather than the document's (a bug the tests caught).
- **`src/lib/sanitise.ts`** — removes scripts, real inline event handlers (matched by
  handler name, so a legitimate `once=` attribute survives), `javascript:` URLs, meta
  refresh, and scripts hidden inside declarative shadow DOM templates.
- **`src/content/prepare.ts`** — the hard cases §5 names, handled rather than ignored:
  canvas/WebGL rasterisation with a screenshot-crop fallback when the pixels are
  unreadable, cross-origin iframes cropped from the page screenshot, video poster frames,
  frozen scroll offsets, closed-shadow-root warnings. Every mutation to the live product
  page is journalled and undone.
- **`src/lib/serialise.ts`** — a snapshot-level CSP (`default-src 'none'`) as the third
  defence layer, plus the PII review pass.

## Risk still open

The rrweb wrapper itself is the only part of this milestone that cannot be unit-tested
here: it needs a real Chrome and a real product page. Everything downstream of
`snapshot()` is covered by tests against jsdom. **M1's acceptance gate — five real
InLumin screens, one modal, one data table, one canvas visualisation — is the test that
matters, and it has to be run against the live product with a human looking at the
output.**
