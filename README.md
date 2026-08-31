# Demo platform

Interactive product demos for Pivot Path. One engine, many manifests: a demo is a JSON
manifest plus captured DOM snapshots, rendered by a single player. New demos and new
products are content operations in the editor, not engineering work.

Two deployment targets from one codebase and one content format:

- **Web (gated)** — hosted on the site, behind a lead form, events to the CRM.
- **Kiosk (offline)** — a self-contained folder that runs from a USB stick on a
  wifi-disabled laptop, queueing analytics until someone syncs.

Built to [SPEC.md](./SPEC.md). Deviations, open questions and how each acceptance gate is
verified: [IMPLEMENTATION.md](./IMPLEMENTATION.md).

## Getting started

```bash
pnpm install

pnpm dev:player       # play a demo: /?demo=/demos/inlumin/flow-01-requisition-to-po
pnpm dev:web          # gated web API on :8787 (holds the CRM adapter)
pnpm dev:editor       # authoring app on :5176
pnpm verify           # typecheck, unit tests, demo validation, credential check
```

Requires Node 20.11+ and pnpm 10. Go is optional — without it the kiosk bundle falls back
to its Node launcher.

## The pieces

| Package | What it is |
|---|---|
| [`packages/shared`](./packages/shared) | Manifest schema (zod), event taxonomy, selector computation, PII patterns, the script-free guarantee. Everything else depends on this and nothing else depends on everything else. |
| [`capture-extension`](./capture-extension) | Chrome MV3 extension. Turns a live product screen into a self-contained, script-free snapshot. |
| [`player`](./player) | Renders any manifest. Sandboxed snapshot, selector-anchored hotspots, pluggable analytics. |
| [`editor`](./editor) | Internal authoring app. Import captures, place hotspots by clicking, edit captured text, publish. |
| [`adapters/crm`](./adapters/crm) | Two-method CRM boundary, a console adapter, a generic webhook adapter, batching. |
| [`builds/web`](./builds/web) | Gated web target: lead form, consent, server-side API routes. |
| [`builds/kiosk`](./builds/kiosk) | Offline bundle: demo picker, attract loop, IndexedDB queue, single-binary launcher. |
| [`demos/inlumin`](./demos/inlumin) | The demo content itself. Three flows. |

## How a demo gets made

```
capture extension          →  snapshot.html + fallback.png + capture-meta.json
editor: import, place hotspots, write copy, fix text, group, preview
editor: publish            →  demos/<product>/<flow>/  (manifest + snapshots + assets)
build:web / build:kiosk    →  the two targets, from the same folder
```

Nobody edits JSON by hand at any point. `pnpm validate:demos` enforces that what lands in
`demos/` is playable.

## The guarantees, and what enforces them

These are the properties the platform is built around, each with the thing that stops it
regressing:

| Guarantee | Enforced by |
|---|---|
| Snapshots never execute code | rrweb's `slimDOM`, our sanitiser, a snapshot-level CSP, the player's iframe sandbox — and `assertScriptFree` at capture, import, export, publish and validation |
| A kiosk bundle makes no network calls | `build:kiosk` fails on any external URL in a loadable position or any undeclared host |
| A failed snapshot never breaks a demo | every step has a mandatory fallback image; the player swaps to it and switches hotspots to coordinates |
| Hotspots stay on their element | selector-first anchoring, re-resolved on resize; coordinates recorded at the same time as the selector |
| No credential reaches a client | CRM calls are server-side only; `lint:no-secrets` fails the build, and names the bundle if one gets in |
| Demo data stays synthetic | PII review at capture time, re-scan on edit, and `validate:demos` fails on PII in snapshot text |
| Nothing is recorded before consent | the player runs a null transport until a `leadId` exists |

## Verification

`pnpm verify` is the non-browser gate. The acceptance gates from §12 each have a script that
drives a real headless Chromium:

```bash
pnpm smoke:player     # M2 — 18 checks, incl. a deliberately broken snapshot
pnpm smoke:editor     # M3 — 35 checks, a 10-step flow authored and published via the UI
pnpm smoke:web        # M4 — 26 checks, gate → lead → event stream → abandonment
pnpm smoke:kiosk      # M5 — 23 checks, run from a copied folder with DNS dead
```

M1 (the capture extension against the live InLumin tenant) is the one gate that cannot be
closed in CI — see [IMPLEMENTATION.md](./IMPLEMENTATION.md).

## Scripts

| Command | Does |
|---|---|
| `pnpm build` | player, editor, web target, capture extension |
| `pnpm build:kiosk --all` | offline bundle (add `--all-platforms` for every launcher binary) |
| `pnpm validate:demos` | schema, files, script-free, no external URLs, no PII, selectors resolve |
| `pnpm render:fallbacks` | re-render step fallback images with networking disabled |
| `pnpm lint:no-external-urls` | run the kiosk URL lint against a built bundle |
| `pnpm lint:no-secrets` | credential check over the repo and the built bundles |
| `pnpm typecheck` / `pnpm test` | every package |
