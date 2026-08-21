# Implementation notes

Where the build departs from [SPEC.md](./SPEC.md), what is still open, and how each
milestone's acceptance gate is verified. The spec is kept verbatim as the record of what
was asked for; this is the record of what was built.

## Deviations, and why

### `single-file-core` was evaluated and rejected on licence (§5)

§5 says to evaluate `rrweb`'s snapshot module and `single-file-core` and to wrap a proven
library. Both were evaluated at `rrweb-snapshot@2.1.1` and `single-file-core@1.5.88`.

`single-file-core` produces the best self-contained HTML available, and it is
**AGPL-3.0-or-later**. Kiosk bundles are distributed on USB sticks (AGPL §5) and the gated
web player is served over a network (AGPL §13), so using it would mean publishing this
platform's source or negotiating a commercial relicence. Neither is a decision this build
can make.

`rrweb-snapshot` is MIT and covers the traversal work that is a known time sink, so it is
what we wrap — but its artefact is a serialised node tree meant to be rehydrated by rrweb
at replay time, which would put a JS runtime inside every snapshot and break both the
`snapshot: "….html"` contract (§4) and the script-free guarantee (§11). So we use rrweb for
traversal, rebuild inside the extension's offscreen document, and serialise to static HTML
ourselves. The snapshot that ships contains no rrweb code and no scripts.

Full reasoning, and the gaps we still had to own: [capture-extension/EVALUATION.md](./capture-extension/EVALUATION.md).

### The kiosk URL lint judges by position, not by substring (§8.2)

§8.2 says the build must fail if any external URL survives into the bundle. A literal
substring search for `https://` fails that test in both directions: React embeds
documentation links in its error strings, zod emits JSON-Schema `$schema` identifiers, SVG
carries XML namespaces, and demo manifests carry the end-screen CTA the visitor is meant to
click — while a base64 payload containing `//` is not a URL at all.

So the lint fails on **loadable positions** (`src`, `srcset`, `poster`, `<link href>`, CSS
`url()`/`@import`, `fetch`, `import()`, `Worker`, `EventSource`, `WebSocket`,
`importScripts`, `XHR.open`) and on any other external URL whose host is not declared in
`builds/kiosk/allowed-hosts.json` with a written reason. Link targets and loopback pass.
That file is the review gate: adding a host is a deliberate, visible act.

One sanctioned exception: the operator-editable sync endpoint in `kiosk-config.json`. The
lint reports it rather than hiding it, and nothing is sent there until someone presses Sync.

### Chapter membership lives on the step, inside the editor (§7)

The manifest stores chapters as ordered lists of step ids (§4, unchanged). The editor's
working model instead puts the chapter id on the step and treats list order as step order,
because the manifest shape makes a drag-reorder a two-place update that can go out of sync
— and an orphaned or double-claimed step is a demo that silently never plays.
`toManifest()` is the single place the two shapes meet and it validates on the way out.

### `gate_submitted` is recorded server-side (§9)

It is the one event a client cannot be trusted to have fired, and it anchors the session, so
the `/api/lead` route records it after the CRM returns a `leadId`.

## Open items for the owner

| Item | Spec reference | Status |
|---|---|---|
| **Which CRM** | §10 — "confirm with owner before Milestone 4" | Unresolved. `ConsoleCrmAdapter` is the default so every environment works without credentials; `WebhookCrmAdapter` covers the authenticated-POST shape every candidate shares (configurable lead-id path, field mappers, retries on 429/5xx). Choosing the vendor means configuring or subclassing that adapter — nothing upstream changes. |
| **InLumin flow names** | §12 — "flow names TBD — owner to specify 2–3 core workflows" | Three placeholder flows exist, chosen to exercise the paths §12 calls out (a modal, a data table, a canvas-heavy view). Renaming means renaming the folder and the `demoId`; nothing in the engine depends on either. |
| **Real captures from the InLumin tenant** | §5, §12 (M1) | The committed snapshots are **hand-authored synthetic stand-ins**, written exactly as the extension writes them. Capture needs live platform access. See [demos/inlumin/README.md](./demos/inlumin/README.md). |
| **Privacy notice URL** | §8.1 | `VITE_PRIVACY_URL`, currently `/privacy`. |
| **Server-side abandonment sweep** | §9 — "derived server-side or on sync from session timeout" | Not built, deliberately. The client fires `session_abandoned` three ways (pagehide, visibilitychange, inactivity timeout) and the kiosk fires it on idle reset, all of which are verified. A server-side sweeper needs somewhere to hold open sessions, and v1 has no event store — events are forwarded straight to the CRM. Whether a sweeper is needed at all depends on whether the chosen CRM can derive "last event, then silence"; that call belongs with the CRM decision. |

## What is verified, and how

Everything below runs in this repo. `pnpm verify` covers the non-browser gates; the four
`smoke:*` scripts drive a real headless Chromium.

| Gate | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | 243 tests |
| Demo content | `pnpm validate:demos` | 3 demos, 10 snapshots, 16 selectors |
| Credentials (§11) | `pnpm lint:no-secrets` | fails on a planted secret, and flags bundle inclusion specifically |
| Kiosk offline guarantee (§8.2) | `pnpm build:kiosk --all` | build fails on any external URL |
| **M2 — player** | `pnpm smoke:player` | 18/18 per flow |
| **M3 — editor** | `pnpm smoke:editor` | 35/35 |
| **M4 — gated web** | `pnpm smoke:web` | 26/26 |
| **M5 — kiosk** | `pnpm smoke:kiosk` | 23/23 |

### M1 is the gate that cannot be closed here

M1's acceptance is five real InLumin screens captured from the live product, rendering
pixel-faithful offline, including a canvas-heavy view. Everything downstream of
`rrweb.snapshot()` is unit-tested against jsdom — sanitisation, resource embedding, CSS
rewriting, serialisation, crop geometry, PII detection — and the synthetic snapshots are
verified to render with networking disabled in headless Chromium. But the extension itself
needs a real Chrome and a real product page, so **M1 stays open until someone runs it
against the InLumin tenant with a human looking at the output.** That is the one milestone
where a green test here would be a false signal.

### Bugs the browser found that unit tests could not

Worth recording, because they are the argument for keeping the smoke tests:

1. **Cross-realm `instanceof Element`** in the editor's element picker. A snapshot lives in
   an iframe with its own realm, so its nodes are not instances of the parent realm's
   `Element` — every click was silently discarded. Invisible in jsdom, where the parsed
   document shares the test's realm.
2. **Iframe document latching.** `iframe.contentDocument` can still be the *previous*
   step's document just after `srcDoc` changes, so hotspots resolved against the wrong DOM.
   Both the player and the editor now key the iframe per step.
3. **Reload-per-keystroke** while text editing, which took the caret with it.
4. **Font URLs resolved against the document** instead of the stylesheet that referenced
   them, so a CDN stylesheet's fonts were fetched from the wrong origin (caught by a unit
   test, but only because the test asserted the fetched URL rather than the outcome).

## Post-v1 validation gate

§12 asks for one NoteIQ flow authored end-to-end with **zero engine changes**. The checks
that would show a leak:

- [ ] Capture NoteIQ screens with the unmodified extension.
- [ ] Author the flow in the unmodified editor and publish.
- [ ] `pnpm validate:demos && pnpm smoke:player demos/noteiq/<flow>` green.
- [ ] `pnpm build:kiosk --demo noteiq-flow-01` green, including the URL lint.
- [ ] Diff `packages/shared`, `player`, `editor`, `capture-extension`: **no changes.**

Anything that required code is a leak in "one engine, many manifests" and should be fixed
before the remaining four products.
