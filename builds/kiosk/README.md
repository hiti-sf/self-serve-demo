# Kiosk target (offline)

A self-contained bundle for in-person pitches and tradeshows (SPEC §8.2). Zero network
calls at runtime, gating stripped, analytics queued locally and synced later.

```bash
pnpm build:kiosk --all                       # every demo
pnpm build:kiosk --demo inlumin-flow-01      # one demo
pnpm build:kiosk --all --all-platforms       # launcher binaries for Windows/macOS/Linux
pnpm build:kiosk --all --events-endpoint https://demo.pivotpath.example/api/events \
                       --label "Booth 12" --idle-reset-ms 120000
pnpm lint:no-external-urls builds/kiosk/dist-kiosk
pnpm smoke:kiosk                             # build, then run the bundle with DNS dead
```

Output lands in `builds/kiosk/dist-kiosk/`. Copy the whole folder to a USB stick.

## Running it

| Platform | Action |
|---|---|
| Windows | double-click `launch.cmd` |
| macOS | double-click `launch.command` |
| Linux | `./launch.sh` |

Each script prefers the bundled single-file launcher (a Go binary that needs nothing
installed), then falls back to Node (`serve.mjs`, dependency-free), then to `npx serve`.
A server is required rather than optional: `file://` breaks iframes and ES module
loading, which is the whole rendering path.

The launcher binds `127.0.0.1` only, serves the directory it sits in, picks a free port
and opens the default browser. A tradeshow network is not somewhere to expose a server.

`READ-ME-FIRST.txt` is written into every bundle so whoever finds the stick knows what to
do, including the macOS quarantine workaround.

## The offline guarantee

`build:kiosk` **fails** if any external URL survives into the output. The lint
distinguishes positions, because a substring search for `https://` is both too strict and
too loose:

| Verdict | What |
|---|---|
| **fail** | loadable positions — `src`, `srcset`, `poster`, `<link href>`, CSS `url()`/`@import`, `fetch`, `import()`, `Worker`, `EventSource`, `WebSocket`, `importScripts`, `XHR.open` |
| **fail** | any other external URL whose host is not declared in `allowed-hosts.json` |
| pass | link targets a visitor clicks (an end-screen CTA opens their browser — that is the point) |
| pass | loopback, which is how the launcher serves the bundle |
| pass | declared hosts, each with a written reason |

`allowed-hosts.json` is the review gate: adding a host is a deliberate, visible act, and
each entry has to say why the URL is never fetched. The first run of this lint on a real
bundle produced three false positives (a `//` inside a base64 payload, a `//` after a
regex literal, and loopback) — those cases are now covered by tests, because a lint that
cries wolf gets switched off and then the guarantee is gone.

The one sanctioned external URL is the sync endpoint in `kiosk-config.json`. The lint
reports it rather than hiding it, and nothing is sent there until an operator presses Sync
or the machine comes back online.

## Configuration without a rebuild

`kiosk-config.json` sits next to `index.html` and a sales engineer can edit it on the
stick:

```json
{
  "eventsEndpoint": "https://demo.pivotpath.example/api/events",
  "idleResetMs": 120000,
  "autoSyncOnline": true,
  "kioskLabel": "Booth 12",
  "buildId": "202608211318"
}
```

`idleResetMs` is the attract loop: after that much idle time the demo returns to the
picker, ready for the next visitor. The kiosk config wins over the manifest's own value,
because the attract loop is a property of the booth, not of the demo.

## Analytics

Events go to an IndexedDB queue with their original timestamps — durable across restarts,
because a booth laptop gets closed and reopened all day and the drop-off data from those
sessions is the point of the exercise.

Sync from the unlabelled square at the bottom-right of the picker: it shows the queue
depth, connectivity and the configured endpoint. **Events are only deleted once the server
has accepted them**, so a failed sync loses nothing. The bundle also syncs automatically
when the browser reports it is back online.

The endpoint is the same `/api/events` route the web target uses, so kiosk sessions land
in the same event stream and the same drop-off analysis.

## Acceptance

`pnpm smoke:kiosk` copies the bundle to a fresh directory, starts it with the bundled
launcher binary, and drives a browser whose DNS resolves nothing except loopback — what
"wifi disabled" looks like to a page. It asserts 23 checks: the demos render with no
network, snapshot images are embedded rather than fetched, hotspots still anchor by
selector, the demo plays to the end screen, events queue locally with nothing reaching the
server, and after pointing the config at a reachable endpoint the queue drains and the
server receives every event with its original timestamp.
