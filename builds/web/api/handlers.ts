import {
  DEFAULT_FREEMAIL_DOMAINS,
  EVENT_NAMES,
  safeParseDemoEvent,
  validateLeadInput,
  type DemoEvent,
} from '@demo-platform/shared';
import type { CrmAdapter } from '@demo-platform/crm-adapter';

/**
 * Server-side API for the gated web target (SPEC §8.1, §11).
 *
 * Written against the Web `Request`/`Response` pair so the same handlers run as a
 * serverless function, on a Node server, or on an edge runtime — the spec asks for "a
 * minimal API route (single serverless function is fine)" and this is that, without
 * binding the platform to one host.
 *
 * The CRM credential lives here and only here. It is never sent to the browser.
 */

export interface ApiConfig {
  crm: CrmAdapter;
  /** Configurable per deployment (§8.1). */
  freemailDomains?: readonly string[];
  /** Comma-separated allowed origins. Defaults to same-origin only. */
  allowedOrigins?: string[];
  /** Max events accepted in one request. */
  maxBatch?: number;
  log?: (message: string, payload?: unknown) => void;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function corsHeaders(request: Request, allowedOrigins: string[] | undefined): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins || allowedOrigins.length === 0) return {};
  if (!allowedOrigins.includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
}

async function readJson(request: Request, limitBytes = 512 * 1024): Promise<unknown> {
  const text = await request.text();
  if (text.length > limitBytes) throw new Error('payload too large');
  if (text.trim().length === 0) return null;
  return JSON.parse(text) as unknown;
}

/**
 * POST /api/lead — the gate (§8.1).
 * Validates, creates the CRM lead, returns the leadId the player then attaches to
 * every event. No event is recorded before consent, which the schema requires.
 */
export async function handleLead(request: Request, config: ApiConfig): Promise<Response> {
  const cors = corsHeaders(request, config.allowedOrigins);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);

  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'invalid JSON' }, 400, cors);
  }

  const validated = validateLeadInput(body, config.freemailDomains ?? DEFAULT_FREEMAIL_DOMAINS);
  if (!validated.ok) {
    return json({ error: 'validation failed', fieldErrors: validated.fieldErrors }, 422, cors);
  }

  try {
    const { leadId } = await config.crm.createLead(validated.lead);

    // gate_submitted is recorded server-side: it is the one event the client cannot be
    // trusted to have fired, and it is the anchor for the whole session (§9).
    const gateEvent: DemoEvent = {
      eventId: `evt_gate_${leadId}`,
      sessionId: validated.lead.sessionId,
      demoId: validated.lead.demoId,
      leadId,
      timestamp: new Date().toISOString(),
      name: 'gate_submitted',
      payload: { leadId },
    };
    await config.crm.recordEvent(gateEvent);

    config.log?.('[api] lead created', { leadId, demoId: validated.lead.demoId });
    return json({ leadId }, 201, cors);
  } catch (error) {
    config.log?.('[api] lead creation failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    // Deliberately vague to the client, specific in the log: the visitor cannot act on
    // a CRM error, and the response must not leak the CRM's shape.
    return json({ error: 'Could not start the demo. Please try again.' }, 502, cors);
  }
}

export interface EventsResult {
  accepted: number;
  rejected: { index: number; issues: string[] }[];
}

/**
 * POST /api/events — analytics ingest for both targets (§8.2 kiosk sync posts here too).
 *
 * Accepts only whitelisted event names and validates every payload against the shared
 * schema (§11). A rejected event does not fail the batch: a kiosk syncing 400 queued
 * events after a tradeshow must not lose 399 of them to one malformed record.
 */
export async function handleEvents(request: Request, config: ApiConfig): Promise<Response> {
  const cors = corsHeaders(request, config.allowedOrigins);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors);

  let body: unknown;
  try {
    body = await readJson(request, 2 * 1024 * 1024);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'invalid JSON' }, 400, cors);
  }

  const raw = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(raw)) {
    return json({ error: 'expected { events: [...] }' }, 400, cors);
  }
  const maxBatch = config.maxBatch ?? 500;
  if (raw.length === 0) return json({ accepted: 0, rejected: [] }, 200, cors);
  if (raw.length > maxBatch) {
    return json({ error: `batch too large; send at most ${maxBatch} events` }, 413, cors);
  }

  const result: EventsResult = { accepted: 0, rejected: [] };

  for (const [index, candidate] of raw.entries()) {
    const parsed = safeParseDemoEvent(candidate);
    if (!parsed.ok) {
      result.rejected.push({ index, issues: parsed.issues });
      continue;
    }
    try {
      await config.crm.recordEvent(parsed.event);
      result.accepted += 1;
    } catch (error) {
      result.rejected.push({
        index,
        issues: [error instanceof Error ? error.message : 'CRM rejected the event'],
      });
    }
  }

  // Flush now rather than on the next timer tick: a kiosk sync is a one-shot
  // connection and the operator is watching for the confirmation.
  await config.crm.flush?.();

  if (result.rejected.length > 0) {
    config.log?.('[api] some events rejected', { rejected: result.rejected.length });
  }
  return json(result, 200, cors);
}

/** GET /api/health — which adapter is live, and the event names it will accept. */
export async function handleHealth(_request: Request, config: ApiConfig): Promise<Response> {
  return json({
    ok: true,
    crm: config.crm.name,
    acceptedEvents: EVENT_NAMES,
  });
}

/** Route a request to the right handler. Returns null when the path is not an API path. */
export function routeApi(request: Request, config: ApiConfig): Promise<Response> | null {
  const { pathname } = new URL(request.url);
  switch (pathname) {
    case '/api/lead':
      return handleLead(request, config);
    case '/api/events':
      return handleEvents(request, config);
    case '/api/health':
      return handleHealth(request, config);
    default:
      return null;
  }
}
