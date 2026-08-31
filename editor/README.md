# Editor (internal)

The tool that makes this platform sustainable without engineering in the loop (SPEC §7).
Import captures, place hotspots by clicking, write the copy, fix the captured text, group
and reorder, preview in the real player, publish.

```bash
EDITOR_TOKEN=letmein pnpm dev:editor:server    # publish server on :8788
pnpm --filter @demo-platform/editor dev        # editor on :5176, proxies /api
pnpm smoke:editor                              # drives the whole authoring flow in a browser
```

## The authoring loop

1. **Import a capture.** Drop the folder the extension wrote — `snapshot.html`,
   `fallback.png`, `capture-meta.json`. The snapshot is re-checked for scripts on the way
   in rather than trusted, and the capture's warnings (closed shadow roots, cross-origin
   frames, skipped PII review) surface as notices.
2. **Place a hotspot.** Click the element in the rendered screen. The editor records the
   **CSS selector and the normalised coordinates together** — selector for anchoring,
   coordinates for the fallback-image path (§4). Recording one without the other is the
   bug this is built to prevent. If the best available selector is a positional path, the
   editor says so, because that is the anchor that will drift.
3. **Write the tooltip.** Title, body, position, trigger, and where the hotspot advances to.
   The anchor and its fallback coordinates are shown, not hidden: an author who can see a
   fragile anchor re-anchors it before a prospect does.
4. **Fix the text.** Edit mode makes the captured DOM's leaf text editable in place —
   rename a customer, fix a typo, adjust a number, without going back to the product.
   Enter is disabled and pasted markup is stripped, so captured layout cannot break.
5. **Group and reorder.** Drag steps; move them between chapters with the per-step select.
6. **Preview.** The real `DemoPlayer` component, fed from the in-memory project, so unsaved
   edits play exactly as they will ship. Never a re-implementation (§7).
7. **Publish.** One click writes the demo folder into `demos/`. Export downloads the same
   folder as a zip — the same builder produces both, so there is no export format to drift.

## Model

Chapter membership lives **on the step**, and step order is the list order. The manifest
stores chapters as ordered lists of step ids, which makes reordering a two-place update
that can go out of sync — and an orphaned or double-claimed step is a demo that silently
never plays. `toManifest` is the single place the two shapes meet, and it validates against
the shared schema on the way out. The editor runs it on every render, so problems appear
while authoring rather than at publish time.

Drafts are kept in `localStorage`, so a refresh mid-authoring does not cost the afternoon.

## Publish server

`server/publish-server.mts` is the only part of the editor that writes anything, so it is
the only part that needs auth: a shared password (`EDITOR_TOKEN`) or a trusted SSO header
(`SSO_HEADER`, set by whatever proxy fronts the tool). §7 is explicit that user management
is out of scope.

It re-validates everything the editor already checked, because it is the thing that touches
the repo: the manifest against the shared schema, every snapshot for scripts, every path
against directory traversal, and every file extension against an allowlist. It replaces the
demo folder wholesale, so a republish cannot leave an orphaned snapshot behind. Set
`DEMOS_ROOT` to publish somewhere other than the repo.

| Variable | Meaning |
|---|---|
| `EDITOR_TOKEN` | shared password; sent as `x-editor-token` |
| `SSO_HEADER` | trusted header name, e.g. `x-forwarded-email` |
| `DEMOS_ROOT` | where demo folders are written (default `demos/`) |
| `PORT` | default 8788 |

## Acceptance

`pnpm smoke:editor` is M3's gate, driven through the UI an author uses: it imports ten
capture folders through the file picker, places hotspots by clicking elements inside the
rendered snapshots, types the tooltip copy, edits captured text and checks the edit
survives a step change, creates and titles three chapters, regroups the steps, reorders by
drag, sets the demo metadata and end screen, previews in the real player, is refused with a
wrong password, and publishes. It then asserts the published folder: ten steps, three
chapters, guidance on every step, the text edit present in exactly one snapshot, no editor
artefacts anywhere, every snapshot still script-free — and the repo validator passing.
35 checks, no JSON edited by hand.
