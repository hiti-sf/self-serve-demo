# Web target (gated)

The player plus the lead gate (SPEC §8.1). Same engine, same manifests — the gate and the
HTTP analytics transport are the only additions.

```bash
pnpm dev:web                      # API on :8787 (holds the CRM adapter)
pnpm --filter @demo-platform/web dev   # app on :5174, proxies /api to :8787
pnpm build:web                    # static bundle + the demos it should serve
pnpm serve:web                    # serve the built bundle and the API from one process
pnpm smoke:web                    # build, then drive the whole gated flow in a browser
```

Embed a demo with `?demo=/demos/<product>/<flow>`; `dist/demos/index.json` lists what a
given build contains.

## The gate

`settings.gated` in the manifest decides whether the gate appears — kiosk builds strip it
entirely (§8.2). The first frame renders blurred behind the form: enough to motivate the
fill without giving the demo away.

Fields: name, work email, company, role, product interest (pre-filled from the manifest).
Free-mail and disposable domains are rejected; the list is configurable per deployment via
`FREEMAIL_DOMAINS`.

**No analytics event fires before consent.** The consent checkbox is on the form, the
schema requires it to be `true`, and the player runs with a null transport until a
`leadId` exists. `gate_submitted` is recorded *server-side* — it is the one event a client
cannot be trusted to have fired, and it anchors the session.

## API

Handlers are written against the Web `Request`/`Response` pair (`api/handlers.ts`), so the
same code runs as a serverless function, on Node, or on an edge runtime.

| Route | Does |
|---|---|
| `POST /api/lead` | validate → `crm.createLead()` → return `leadId` → record `gate_submitted` |
| `POST /api/events` | whitelist the event name, validate the payload, forward to the CRM |
| `GET /api/health` | which adapter is live, and the event names it accepts |

`server/dev-server.mts` wires them into a Node server for local use and self-hosting.

**The CRM credential lives server-side only** (§8.1, §11). It is read from the environment
in the server process and never reaches the browser bundle. A CRM failure returns a vague
message to the visitor and the specifics to the log — the visitor cannot act on a CRM
error and the response must not leak the CRM's shape.

A rejected event never fails the batch: a kiosk syncing 400 queued events after a
tradeshow must not lose 399 of them to one malformed record.

## Configuration

| Variable | Meaning |
|---|---|
| `CRM_ADAPTER` | `console` (default) or `webhook` |
| `CRM_LEAD_ENDPOINT`, `CRM_EVENT_ENDPOINT` | required for `webhook` |
| `CRM_TOKEN`, `CRM_AUTH_SCHEME`, `CRM_LEAD_ID_PATH` | webhook auth and response shape |
| `CRM_BATCH_SIZE`, `CRM_FLUSH_INTERVAL_MS` | batching, defaults 10 / 15000 (§10) |
| `FREEMAIL_DOMAINS` | comma-separated override of the rejection list |
| `ALLOWED_ORIGINS` | comma-separated; omit for same-origin only |
| `VITE_PRIVACY_URL` | privacy notice linked from the consent line |

> **The concrete CRM is still TBD** (§10). `ConsoleCrmAdapter` is the default so every
> environment works without credentials, and `WebhookCrmAdapter` covers the
> authenticated-POST shape every candidate shares. Choosing the vendor means configuring
> or subclassing that adapter; nothing upstream changes.
