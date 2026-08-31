import { describe, expect, it, vi } from 'vitest';
import type { DemoEvent, LeadInput } from '@demo-platform/shared';
import { BatchingCrmAdapter, ConsoleCrmAdapter, type CrmAdapter } from '@demo-platform/crm-adapter';
import { handleEvents, handleHealth, handleLead, routeApi } from '../api/handlers.js';

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://demo.pivotpath.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const validLead = {
  name: 'Priya Raman',
  workEmail: 'priya.raman@strides.example',
  company: 'Strides',
  role: 'Procurement / Sourcing',
  productInterest: 'InLumin',
  consent: true,
  demoId: 'inlumin-flow-01',
  sessionId: 'ses_abc',
};

function event(overrides: Partial<DemoEvent> = {}): unknown {
  return {
    eventId: 'evt_1',
    sessionId: 'ses_abc',
    demoId: 'inlumin-flow-01',
    timestamp: '2026-08-21T10:00:00.000Z',
    name: 'step_viewed',
    payload: { stepId: 'step-01', chapterId: 'ch-01' },
    ...overrides,
  };
}

describe('POST /api/lead', () => {
  it('creates the lead and returns its id', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleLead(post('/api/lead', validLead), { crm });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { leadId: string };
    expect(body.leadId).toMatch(/^lead_/);
    expect(crm.recordedLeads()).toHaveLength(1);
  });

  it('records gate_submitted server-side, with the leadId attached', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    await handleLead(post('/api/lead', validLead), { crm });

    const gate = crm.recordedEvents().find((e) => e.name === 'gate_submitted');
    expect(gate).toBeDefined();
    expect(gate?.leadId).toBe(crm.recordedLeads()[0]?.leadId);
    expect(gate?.sessionId).toBe('ses_abc');
  });

  it('rejects a submission without consent and records nothing', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleLead(post('/api/lead', { ...validLead, consent: false }), { crm });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { fieldErrors: Record<string, string> };
    expect(body.fieldErrors.consent).toBeTruthy();
    expect(crm.recordedLeads()).toHaveLength(0);
    expect(crm.recordedEvents()).toHaveLength(0);
  });

  it('rejects a free-mail address with a per-field error', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleLead(post('/api/lead', { ...validLead, workEmail: 'x@gmail.com' }), { crm });
    expect(response.status).toBe(422);
    expect((await response.json()).fieldErrors.workEmail).toContain('work email');
  });

  it('honours a deployment-specific free-mail list', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleLead(post('/api/lead', { ...validLead, workEmail: 'a@partner.test' }), {
      crm,
      freemailDomains: ['partner.test'],
    });
    expect(response.status).toBe(422);
  });

  it('does not leak CRM internals when the CRM fails', async () => {
    const crm: CrmAdapter = {
      name: 'broken',
      createLead: async () => {
        throw new Error('CRM 500: token xyz rejected by tenant 88');
      },
      recordEvent: async () => {},
    };
    const log = vi.fn();
    const response = await handleLead(post('/api/lead', validLead), { crm, log });

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain('token xyz');
    expect(text).toContain('Could not start the demo');
    // …but the operator can see it.
    expect(log).toHaveBeenCalledWith('[api] lead creation failed', expect.anything());
  });

  it('rejects a non-POST', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleLead(new Request('https://x/api/lead'), { crm });
    expect(response.status).toBe(405);
  });

  it('rejects malformed JSON', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const request = new Request('https://x/api/lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect((await handleLead(request, { crm })).status).toBe(400);
  });

  it('rejects unexpected fields, so the gate cannot be used to write arbitrary CRM data', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleLead(post('/api/lead', { ...validLead, owner: 'someone-else' }), { crm });
    expect(response.status).toBe(422);
  });
});

describe('POST /api/events', () => {
  it('accepts a valid batch', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleEvents(post('/api/events', { events: [event(), event({ eventId: 'evt_2' })] }), {
      crm,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 2, rejected: [] });
    expect(crm.recordedEvents()).toHaveLength(2);
  });

  it('rejects an event name outside the whitelist but keeps the rest of the batch', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleEvents(
      post('/api/events', {
        events: [event(), { ...(event() as object), name: 'exfiltrate', eventId: 'evt_x' }, event({ eventId: 'evt_3' })],
      }),
      { crm },
    );

    const body = (await response.json()) as { accepted: number; rejected: { index: number; issues: string[] }[] };
    expect(body.accepted).toBe(2);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]?.index).toBe(1);
    expect(body.rejected[0]?.issues[0]).toContain('unknown event name');
  });

  it('rejects a payload that does not match its event name', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleEvents(
      post('/api/events', { events: [event({ name: 'demo_completed', payload: { stepId: 'x' } } as never)] }),
      { crm },
    );
    expect(((await response.json()) as { accepted: number }).accepted).toBe(0);
  });

  it('requires the { events: [...] } envelope', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    expect((await handleEvents(post('/api/events', [event()]), { crm })).status).toBe(400);
  });

  it('caps the batch size', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const events = Array.from({ length: 12 }, (_, i) => event({ eventId: `evt_${i}` }));
    const response = await handleEvents(post('/api/events', { events }), { crm, maxBatch: 10 });
    expect(response.status).toBe(413);
  });

  it('accepts an empty batch without touching the CRM', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleEvents(post('/api/events', { events: [] }), { crm });
    expect(response.status).toBe(200);
    expect(crm.recordedEvents()).toHaveLength(0);
  });

  it('flushes the batching adapter so a kiosk sync is durable before it disconnects', async () => {
    const inner = new ConsoleCrmAdapter(() => {});
    const crm = new BatchingCrmAdapter(inner, { batchSize: 50, flushIntervalMs: 60_000 });
    await handleEvents(post('/api/events', { events: [event(), event({ eventId: 'evt_2' })] }), { crm });
    // Without the explicit flush these would sit in the buffer for a minute.
    expect(inner.recordedEvents()).toHaveLength(2);
  });

  it('carries leadId through to the CRM', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    await handleEvents(post('/api/events', { events: [event({ leadId: 'lead_7' })] }), { crm });
    expect(crm.recordedEvents()[0]?.leadId).toBe('lead_7');
  });

  it('accepts a session_abandoned event synced days later from a kiosk', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const response = await handleEvents(
      post('/api/events', {
        events: [
          event({
            name: 'session_abandoned',
            timestamp: '2026-08-10T08:00:00.000Z',
            payload: { lastStepId: 'step-02', dwellMs: 41000, derivedFrom: 'kiosk-idle-reset' },
          } as never),
        ],
      }),
      { crm },
    );
    expect(((await response.json()) as { accepted: number }).accepted).toBe(1);
  });
});

describe('CORS', () => {
  it('echoes only an allow-listed origin', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const config = { crm, allowedOrigins: ['https://www.pivotpath.example'] };

    const allowed = await handleEvents(
      post('/api/events', { events: [event()] }, { origin: 'https://www.pivotpath.example' }),
      config,
    );
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://www.pivotpath.example');

    const denied = await handleEvents(post('/api/events', { events: [event()] }, { origin: 'https://evil.test' }), config);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a preflight', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const request = new Request('https://x/api/lead', { method: 'OPTIONS', headers: { origin: 'https://ok.test' } });
    const response = await handleLead(request, { crm, allowedOrigins: ['https://ok.test'] });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('routing', () => {
  it('routes the three API paths and nothing else', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    expect(routeApi(post('/api/lead', validLead), { crm })).not.toBeNull();
    expect(routeApi(post('/api/events', { events: [] }), { crm })).not.toBeNull();
    expect(routeApi(new Request('https://x/api/health'), { crm })).not.toBeNull();
    expect(routeApi(new Request('https://x/api/secrets'), { crm })).toBeNull();
  });

  it('health reports the adapter and the accepted event names', async () => {
    const crm = new ConsoleCrmAdapter(() => {});
    const body = (await (await handleHealth(new Request('https://x/api/health'), { crm })).json()) as {
      crm: string;
      acceptedEvents: string[];
    };
    expect(body.crm).toBe('console');
    expect(body.acceptedEvents).toContain('session_abandoned');
  });
});

describe('lead payload shape', () => {
  it('normalises the email before it reaches the CRM', async () => {
    const captured: LeadInput[] = [];
    const crm: CrmAdapter = {
      name: 'capture',
      createLead: async (lead) => {
        captured.push(lead);
        return { leadId: 'lead_1' };
      },
      recordEvent: async () => {},
    };
    await handleLead(post('/api/lead', { ...validLead, workEmail: 'Priya.Raman@Strides.Example ' }), { crm });
    expect(captured[0]?.workEmail).toBe('priya.raman@strides.example');
  });
});
