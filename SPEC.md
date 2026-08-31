# Interactive Demo Platform — Build Specification (v1)

**Handoff document for Claude Code. Read fully before generating any code.**

> Committed verbatim as handed over. Implementation notes, deviations and open questions
> are tracked in [IMPLEMENTATION.md](./IMPLEMENTATION.md) rather than edited into this
> document, so the spec stays the record of what was asked for.

## 1. Purpose

Build an in-house interactive product demo platform (Storylane-class) for Pivot Path SaaS products. V1 ships with InLumin only (2–3 flows) — the pilot product was chosen for live platform access, which the capture extension (M1) requires. NoteIQ is the designated fast-follow. Every architectural decision must generalise to six product lines.

Two deployment targets from one codebase and one content format:

1. **Web (gated):** hosted on the company website. A lead-capture form unlocks the demo; form data and engagement events flow to the CRM.

2. **Kiosk (offline):** a fully self-contained bundle for in-person pitches and tradeshows. Zero network dependency at runtime. Analytics queue locally and sync on reconnect.

## 2. Core architectural principle

**One engine, many manifests.** Demos are data, not code. Each demo is a JSON manifest plus captured DOM snapshots, rendered by a single reusable player. The engine is built once; new demos and new products are content operations performed by non-engineers in the editor.

## 3. Monorepo structure

```
demo-platform/
├── packages/
│   └── shared/            # Manifest schema (zod), types, event taxonomy, utils
├── capture-extension/     # Chrome MV3 extension — DOM capture tool
├── player/                # React demo player (renders any manifest)
├── editor/                # React authoring app (internal, team-facing)
├── adapters/
│   └── crm/               # CRM adapter interface + concrete implementation
├── demos/
│   └── inlumin/
│       ├── flow-01-<name>/   # manifest.json + snapshots/ + assets/
│       ├── flow-02-<name>/
│       └── flow-03-<name>/
├── builds/
│   ├── web/               # Gated web target config + gate form
│   └── kiosk/             # Offline packaging scripts + local runner
└── SPEC.md                # This document
```

Use pnpm workspaces. TypeScript throughout. Vite for player and editor.

## 4. Manifest schema

Single source of truth in `packages/shared`. Validate with zod at load time in both player and editor.

```jsonc
{
  "schemaVersion": "1.0",
  "demoId": "inlumin-flow-01",
  "product": "InLumin",
  "title": "…",
  "description": "…",
  "theme": { "primaryColor": "…", "logo": "assets/logo.svg" },
  "settings": {
    "gated": true,              // ignored in kiosk builds
    "showProgress": true,
    "showChapterMenu": true,
    "keyboardNav": true
  },
  "chapters": [
    {
      "chapterId": "ch-01",
      "title": "…",
      "steps": ["step-01", "step-02"]
    }
  ],
  "steps": [
    {
      "stepId": "step-01",
      "snapshot": "snapshots/step-01.html",   // self-contained DOM capture
      "fallbackImage": "snapshots/step-01.png", // per-element or full-page fallback
      "hotspots": [
        {
          "hotspotId": "hs-01",
          "anchor": { "selector": "#save-btn", "strategy": "css" },
          "anchorFallback": { "x": 0.72, "y": 0.31 },  // normalised coords if selector fails
          "trigger": "click",                  // click | hover | auto
          "tooltip": {
            "title": "…",
            "body": "…",
            "position": "auto"                 // auto | top | bottom | left | right
          },
          "advancesTo": "step-02"
        }
      ]
    }
  ],
  "endScreen": {
    "headline": "…",
    "cta": { "label": "Book a walkthrough", "url": "…" },
    "secondaryCta": { "label": "Explore another product", "url": "…" }
  }
}
```

Rules:

- Hotspots anchor to **CSS selectors first**, normalised coordinates as fallback. Selector anchoring is the entire point of DOM capture — hotspots survive window resizing and minor layout shifts.

- `fallbackImage` is mandatory per step. If a snapshot fails to render (canvas, WebGL, blocked iframe), the player silently swaps to the image and hotspots use `anchorFallback` coordinates.

- Schema is versioned. The player must refuse manifests with a higher major version than it supports, with a clear error.

- Design the schema now with reserved (unused) fields for v2: `branches`, `tokens` (personalisation), `variant` (A/B). Do not implement them.

## 5. Capture extension (Chrome MV3)

The riskiest component. Build and validate this first (Milestone 1).

**Function:** the author navigates the live product, clicks "Capture step," and the extension serialises the current page into a single self-contained HTML snapshot.

Requirements:

- Inline all computed styles or capture stylesheets; embed fonts and images (base64 or emitted to `assets/` with rewritten URLs). The snapshot must render identically with **zero network access**.

- **Strip all `<script>` tags and inline event handlers.** Snapshots are static documents. This is both a security requirement and what makes offline rendering deterministic.

- Capture current DOM state (post-interaction), not page source — expanded menus, filled fields, open modals must persist.

- **Sanitisation pass before save:** flag and let the author redact text nodes matching PII patterns (emails, phone numbers, patient/case identifiers). Life-sciences demo data must be synthetic; the tooling should still guard against slips.

- Known hard cases — handle explicitly, do not ignore:

  - `<canvas>` / WebGL → rasterise the element to an inline `<img>` at capture time.

  - Cross-origin iframes → rasterise or prompt the author to exclude.

  - `<video>` → capture poster frame as image.

  - Shadow DOM → serialise shadow roots inline (declarative shadow DOM).

- Output: `snapshot.html` + full-page `fallback.png` + `capture-meta.json` (viewport size, URL, timestamp). The editor imports this trio.

**Evaluate `rrweb`'s snapshot module and `single-file-core` before writing serialisation from scratch.** Wrap a proven library; hand-rolled DOM serialisation is a known time sink.

## 6. Player

React app. Loads a manifest, renders the guided experience.

- Render snapshots in a **sandboxed iframe** (`sandbox="allow-same-origin"`, no scripts) via `srcdoc`. Scale the iframe to fit the viewport while preserving the captured aspect ratio; letterbox rather than reflow.

- Overlay layer sits above the iframe. Hotspot positions resolve by querying the selector inside the iframe document, translated to overlay coordinates; re-resolve on resize.

- Tooltip engine: pulse beacon on the active hotspot, tooltip with title/body, next/back controls, "position: auto" collision handling.

- Chapter menu (if enabled), progress bar, keyboard navigation (arrows, Esc to chapter menu).

- Fires analytics events per §9 through a pluggable transport (web: HTTP; kiosk: local queue).

- Responsive floor: usable at 1024px width. Below that, show a "best viewed on desktop" interstitial with a mobile-friendly image walkthrough as graceful degradation — do not attempt full mobile interaction in v1.

- No third-party runtime dependencies that phone home. No CDN loads. Everything bundled.

## 7. Editor (team-facing, internal)

The tool that makes this platform sustainable without engineering in the loop. Ship in Milestone 3, but design the manifest workflow around it from day one.

Capabilities:

- Import a capture (snapshot + fallback + meta) as a new step.

- Visual hotspot placement: author clicks an element in the rendered snapshot → editor records the CSS selector (compute a robust selector: prefer stable ids/data attributes, fall back to structural path) and normalised coordinates simultaneously.

- Tooltip authoring: title, body, position, trigger.

- **Inline text editing of captured DOM** — rename customers, fix typos, adjust numbers without re-capturing. This is the payoff of DOM capture; make it first-class.

- Step reordering (drag), chapter grouping, end-screen configuration.

- Live preview using the actual player component (import it — never a re-implementation).

- Export: validated manifest + snapshots + assets as a demo folder, and one-click "publish" that drops it into `demos/`.

- Auth: this is an internal tool. Simple password or SSO header check is sufficient; do not build user management.

## 8. Build targets

### 8.1 Web (gated)

- Demo pages embed the player. If `settings.gated` is true, a lead form blocks the demo behind a blurred first-frame preview (show enough to motivate the fill).

- Form fields: name, work email, company, role, product interest (pre-filled from demo context). Validate work email (reject free-mail domains, configurable).

- On submit: call CRM adapter `createLead()` → receive `leadId` → store in sessionStorage → unlock demo → all subsequent events carry `leadId`.

- Consent checkbox + privacy link on the form. No analytics events fire pre-consent.

- Server side: a minimal API route (single serverless function is fine) that proxies form submissions and events to the CRM adapter — never expose CRM credentials client-side.

### 8.2 Kiosk (offline)

- `pnpm build:kiosk --demo inlumin-flow-01` (or `--all`) produces a self-contained folder: player bundle + selected demos + a tiny cross-platform launcher.

- **Zero network calls at runtime.** Build must fail if any external URL survives into the bundle (add a lint step that scans the output).

- Gating stripped entirely. Optional "kiosk attract loop": idle timeout returns to demo selection screen (tradeshow booth behaviour).

- Analytics events queue to IndexedDB with session ids. A "sync" action (button in a hidden admin corner, or automatic on connectivity detection) flushes the queue to the same events endpoint used by web.

- Launcher: bundle a single-binary static server (e.g. a small Go/Bun binary or `npx serve` fallback) because `file://` breaks iframes and module loading. Requirement: a sales engineer double-clicks one file on Windows or macOS and the demo opens in the default browser. Test this exact flow.

- Bundle must run from a USB stick and from a laptop with wifi disabled. These are acceptance tests, not aspirations.

## 9. Analytics event taxonomy

Defined once in `packages/shared`. Every event: `{ eventId, sessionId, demoId, leadId?, timestamp, payload }`.

| Event | Payload |
|---|---|
| `demo_started` | entry source (web/kiosk), referrer |
| `step_viewed` | stepId, chapterId |
| `step_completed` | stepId, dwellMs |
| `chapter_completed` | chapterId |
| `demo_completed` | totalMs |
| `cta_clicked` | ctaLabel, url |
| `gate_submitted` | (web only) leadId |
| `session_abandoned` | lastStepId, dwellMs — derived server-side or on sync from session timeout |

Drop-off analysis (last step before abandonment) is the primary sales-intelligence output; make sure `session_abandoned` is reliable.

## 10. CRM adapter

Interface in `adapters/crm`:

```ts
interface CrmAdapter {
  createLead(lead: LeadInput): Promise<{ leadId: string }>;
  recordEvent(event: DemoEvent): Promise<void>;   // may batch internally
}
```

- Concrete implementation: **[CRM TBD — confirm with owner before Milestone 4]**. Implement as webhook/REST calls server-side only.

- Provide a `ConsoleCrmAdapter` (logs to stdout) so everything upstream of Milestone 4 is testable without CRM credentials.

- Batch `recordEvent` calls (flush every 10 events or 15s) to avoid rate limits.

## 11. Security and compliance requirements

- Snapshots are script-free by construction; the player additionally sandboxes them. Defence in depth — both layers required.

- Kiosk bundles make no network calls, load no remote fonts, no CDN assets. Enforced by the build lint in §8.2.

- All demo data must be synthetic. Capture-time PII sanitisation per §5.

- Web target: cookie/consent handling before any event fires; events endpoint accepts only whitelisted event names and validates payloads against the shared schema.

- No secrets in client bundles. CI check for accidental credential inclusion.

## 12. Milestones and acceptance criteria

Build in this order. Each milestone has a demo-able acceptance gate.

**M1 — Capture extension + schema.**

Accept: capture 5 representative InLumin screens (including at least one modal and one data table); snapshots render pixel-faithful offline in a bare browser; scripts stripped; fallback PNGs generated. If InLumin uses canvas-heavy visualisations, include at least one in the capture set — that is the failure mode to surface now, not in M3.

**M2 — Player.**

Accept: hand-written manifest over M1 captures plays end-to-end — hotspots anchor correctly on resize, chapters and progress work, keyboard nav works, fallback-image path verified by deliberately breaking one snapshot.

**M3 — Editor.**

Accept: a non-engineer builds a complete 8+ step flow from raw captures — hotspots, tooltips, inline text edits, reorder, chapters — and publishes a manifest the player runs without hand-editing JSON.

**M4 — Web gating + analytics.**

Accept: gate form creates a CRM lead (or ConsoleCrmAdapter record), demo unlocks, full event stream lands with leadId attached, abandonment derivable.

**M5 — Kiosk packaging.**

Accept: bundle built, copied to USB, run on a wifi-disabled laptop by double-click; events queue locally and sync successfully after reconnect; build lint blocks any external URL.

Content acceptance (parallel from M3): InLumin flows **[flow names TBD — owner to specify 2–3 core workflows]** authored in the editor.

**Post-v1 validation gate:** author one NoteIQ flow end-to-end with zero engine changes. If it requires code, the "one engine, many manifests" principle has leaked — fix before scaling to remaining products.

## 13. Explicitly out of scope for v1 (v2 backlog)

Branching/choose-your-path logic; personalisation tokens; A/B variants; video steps; additional CRM adapters; multi-language; full mobile interaction; demo-level access analytics dashboard (raw events land in CRM; dashboards later); auto-recapture diffing against product releases.

Do not implement any of these, but do not make schema or architecture choices that preclude them.
