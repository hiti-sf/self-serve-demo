# InLumin demo content

Three flows, each a self-contained demo folder:

| Flow | What it shows | Steps |
|---|---|---|
| `flow-01-requisition-to-po` | Requisition → policy checks → approval → PO, including a **modal** and a **data table** | 4 |
| `flow-02-supplier-comparison` | Four RFQ bids scored on one model, awarded on total cost of risk | 3 |
| `flow-03-spend-analytics` | Spend dashboard with a **rasterised chart**, category drill-down, ranked savings | 3 |

## Status: synthetic stand-ins

> **The flow names are placeholders.** SPEC §12 leaves them for the owner to specify
> ("2–3 core workflows"). These three were chosen to exercise the capture and player
> paths the spec calls out — a modal, a data table and a canvas-heavy visualisation
> (§12, M1) — and to tell a credible procurement story. Renaming a flow means renaming
> its folder and its `demoId`; nothing in the engine depends on either.

The snapshots here were **hand-authored, not captured from the live product**, because
capture requires platform access to the InLumin tenant. They are written exactly the way
the capture extension writes them, so they are drop-in replaceable:

- one self-contained document per step, inline `<style>`, **no external URLs**
- **no scripts**, no inline event handlers, no `javascript:` URLs
- a snapshot-level CSP (`default-src 'none'`)
- `data-demo-capture-id` / `-source-url` / `-captured-at` / `-viewport` provenance
- stable `id` and `data-testid` anchors for every hotspot
- the chart on `flow-03/step-01` is an `<img data-demo-replaced="canvas">`, which is what
  the extension emits for a `<canvas>` element

All data is synthetic. Supplier names, requisition numbers, people and amounts are
invented; `pnpm validate:demos` fails the build if anything resembling personal data
appears in snapshot text (§11).

## Replacing these with real captures

1. Capture the equivalent screens from the live tenant with the capture extension.
2. Import the capture trio in the editor, place hotspots, write the tooltip copy.
3. Publish over the flow folder. The `demoId`, chapters and end screen carry over.
4. `pnpm validate:demos && pnpm smoke:player` — both must pass before the flow ships.

## Regenerating the fallback images

`fallbackImage` is mandatory per step (§4). Re-render after any snapshot edit:

```bash
pnpm render:fallbacks                                   # every demo
node scripts/render-fallbacks.mjs demos/inlumin/flow-01-requisition-to-po
```

The renderer runs headless Chromium with networking disabled, so a snapshot that needs
the network fails here rather than on a wifi-disabled laptop at a tradeshow.
