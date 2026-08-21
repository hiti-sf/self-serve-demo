# Player

Renders any manifest. One engine, many manifests (SPEC §2) — nothing here knows which
product or demo it is playing.

```bash
pnpm dev:player          # http://localhost:5173/?demo=/demos/inlumin/flow-01-…
pnpm build:player
```

The dev harness (`src/main.tsx`) is ungated and logs events to the console. The gated web
target and the kiosk target are separate entries under `builds/` that import the same
`DemoPlayer` component.

## How a step renders

1. `loadSnapshotHtml` fetches the step's snapshot. **A failure is not an error** — the step
   switches to `fallbackImage` and the demo keeps playing (§4).
2. `SnapshotFrame` renders the HTML into an iframe with `sandbox="allow-same-origin"` and
   no `allow-scripts`. Snapshots are already script-free; this is the second layer (§11).
3. The iframe is laid out at its captured size and scaled with a transform, so the
   snapshot **letterboxes rather than reflows**. A reflowed snapshot would move every
   hotspot and misrepresent the product.
4. `HotspotLayer` resolves each hotspot's selector *inside the snapshot document*, converts
   the rect into overlay coordinates, and re-resolves whenever the container resizes.
   Selector first, normalised coordinates as fallback (§4).

## Analytics

Events (§9) go through a pluggable `AnalyticsTransport`:

| Transport | Used by |
|---|---|
| `HttpTransport` | web — batches 10 events / 15 s, `sendBeacon` on unload |
| `QueueTransport` | kiosk — IndexedDB queue, synced later |
| `ConsoleTransport` | dev harness and editor preview |
| `NullTransport` | before consent — nothing is recorded (§8.1, §11) |

`session_abandoned` gets three chances to fire: `pagehide`, `visibilitychange`, and a
client-side inactivity timeout. The server still derives abandonment from session
timeout, because a killed tab sends nothing.

## Responsive floor

Below 1024px the player shows an image walkthrough of the same flow instead of a broken
interaction (§6). Full mobile interaction is out of scope for v1 (§13).

## Tests

`test/geometry.test.ts` covers the letterbox and tooltip-collision maths;
`test/hotspot-layer.test.tsx` covers selector-vs-coordinate anchoring across a resize;
`test/demo-player.test.tsx` plays a three-step demo end to end, **including a
deliberately broken snapshot** to verify the fallback path, and asserts the event
sequence, chapter boundaries, keyboard nav and the pre-consent silence.
