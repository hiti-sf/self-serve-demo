import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoEvent, LeadInput } from '@demo-platform/shared';
import { BatchingCrmAdapter } from '../src/batching.js';
import { ConsoleCrmAdapter } from '../src/console.js';
import { WebhookCrmAdapter } from '../src/webhook.js';
import { createCrmAdapter } from '../src/factory.js';
import { CrmError, type CrmAdapter } from '../src/types.js';

const lead: LeadInput = {
  name: 'Priya Raman',
  workEmail: 'priya.raman@strides.example',
  company: 'Strides',
  role: 'Head of Procurement',
  productInterest: 'InLumin',
  consent: true,
  demoId: 'inlumin-flow-01',
  sessionId: 'ses_1',
};

function event(index: number, leadId?: string): DemoEvent {
  return {
    eventId: `evt_${index}`,
    sessionId: 'ses_1',
    demoId: 'inlumin-flow-01',
    ...(leadId ? { leadId } : {}),
    timestamp: '2026-08-21T10:00:00.000Z',
    name: 'step_viewed',
    payload: { stepId: `step-0${index}`, chapterId: 'ch-01' },
  };
}

describe('ConsoleCrmAdapter', () => {
  it('mints a lead id and records it', async () => {
    const log = vi.fn();
    const adapter = new ConsoleCrmAdapter(log);
    const { leadId } = await adapter.createLead(lead);

    expect(leadId).toMatch(/^lead_/);
    expect(adapter.recordedLeads()[0]).toMatchObject({ leadId, company: 'Strides' });
    expect(log).toHaveBeenCalled();
  });

  it('records events without needing credentials', async () => {
    const adapter = new ConsoleCrmAdapter(() => {});
    await adapter.recordEvent(event(1));
    await adapter.recordEvent(event(2));
    expect(adapter.recordedEvents()).toHaveLength(2);
  });
});

describe('WebhookCrmAdapter', () => {
  it('posts the lead and reads the id from the response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { id: 'crm-991' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const adapter = new WebhookCrmAdapter({
      leadEndpoint: 'https://crm.example/leads',
      eventEndpoint: 'https://crm.example/events',
      token: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const { leadId } = await adapter.createLead(lead);
    expect(leadId).toBe('crm-991');

    const [, init] = fetchImpl.mock.calls[0]!;
    const request = init as RequestInit;
    expect((request.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({ email: 'priya.raman@strides.example', source: 'interactive-demo' });
  });

  it('honours an explicit leadIdPath and a field mapper', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ result: { contact: { ref: 'C-77' } } }), { status: 200 }),
    );
    const adapter = new WebhookCrmAdapter({
      leadEndpoint: 'https://crm.example/leads',
      eventEndpoint: 'https://crm.example/events',
      leadIdPath: 'result.contact.ref',
      mapLead: (input) => ({ emailAddress: input.workEmail, org: input.company }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await adapter.createLead(lead)).toEqual({ leadId: 'C-77' });
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body))).toEqual({
      emailAddress: 'priya.raman@strides.example',
      org: 'Strides',
    });
  });

  it('fails clearly when the response carries no id', async () => {
    const adapter = new WebhookCrmAdapter({
      leadEndpoint: 'https://crm.example/leads',
      eventEndpoint: 'https://crm.example/events',
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
    });
    await expect(adapter.createLead(lead)).rejects.toThrow(/no id was found/);
  });

  it('does not retry a 4xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad request', { status: 400 }));
    const adapter = new WebhookCrmAdapter({
      leadEndpoint: 'https://crm.example/leads',
      eventEndpoint: 'https://crm.example/events',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(adapter.createLead(lead)).rejects.toThrow(CrmError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and succeeds', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('slow down', { status: 429 });
      return new Response(JSON.stringify({ leadId: 'L-1' }), { status: 200 });
    });
    const adapter = new WebhookCrmAdapter({
      leadEndpoint: 'https://crm.example/leads',
      eventEndpoint: 'https://crm.example/events',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await adapter.createLead(lead)).toEqual({ leadId: 'L-1' });
    expect(calls).toBe(2);
  });

  it('sends a whole batch in one request', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    const adapter = new WebhookCrmAdapter({
      leadEndpoint: 'https://crm.example/leads',
      eventEndpoint: 'https://crm.example/events',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await adapter.recordEvents([event(1), event(2), event(3)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body)).events).toHaveLength(3);
  });
});

describe('BatchingCrmAdapter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function spyAdapter(): CrmAdapter & { batches: DemoEvent[][]; recordEvents: (e: DemoEvent[]) => Promise<void> } {
    const batches: DemoEvent[][] = [];
    return {
      name: 'spy',
      batches,
      createLead: async () => ({ leadId: 'lead_1' }),
      recordEvent: async (single) => {
        batches.push([single]);
      },
      recordEvents: async (many) => {
        batches.push(many);
      },
    };
  }

  it('flushes at the batch size in a single request', async () => {
    const inner = spyAdapter();
    const adapter = new BatchingCrmAdapter(inner, { batchSize: 10 });

    for (let i = 0; i < 9; i += 1) await adapter.recordEvent(event(i));
    expect(inner.batches).toHaveLength(0);

    await adapter.recordEvent(event(9));
    expect(inner.batches).toHaveLength(1);
    expect(inner.batches[0]).toHaveLength(10);
  });

  it('flushes on the interval when the batch never fills', async () => {
    const inner = spyAdapter();
    const adapter = new BatchingCrmAdapter(inner, { batchSize: 10, flushIntervalMs: 15_000 });

    await adapter.recordEvent(event(1));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(inner.batches).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(inner.batches).toHaveLength(1);
  });

  it('never batches a lead — the visitor is waiting on the id', async () => {
    const inner = spyAdapter();
    const createLead = vi.spyOn(inner, 'createLead');
    const adapter = new BatchingCrmAdapter(inner);
    expect(await adapter.createLead(lead)).toEqual({ leadId: 'lead_1' });
    expect(createLead).toHaveBeenCalledTimes(1);
  });

  it('swallows a CRM outage and reports it instead of failing the request', async () => {
    const onError = vi.fn((_error: unknown, _dropped: DemoEvent[]) => {});
    const failing: CrmAdapter = {
      name: 'failing',
      createLead: async () => ({ leadId: 'x' }),
      recordEvent: async () => {
        throw new CrmError('CRM down', { retryable: true });
      },
    };
    const adapter = new BatchingCrmAdapter(failing, { batchSize: 1, onError });

    await expect(adapter.recordEvent(event(1))).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toHaveLength(1);
  });

  it('falls back to one-by-one for an adapter with no batch entry point', async () => {
    const calls: DemoEvent[] = [];
    const single: CrmAdapter = {
      name: 'single',
      createLead: async () => ({ leadId: 'x' }),
      recordEvent: async (e) => {
        calls.push(e);
      },
    };
    const adapter = new BatchingCrmAdapter(single, { batchSize: 3 });
    await adapter.recordEvents([event(1), event(2), event(3)]);
    expect(calls).toHaveLength(3);
  });
});

describe('createCrmAdapter', () => {
  it('defaults to the console adapter, wrapped in batching', () => {
    const adapter = createCrmAdapter({});
    expect(adapter.name).toBe('batching(console)');
  });

  it('builds a webhook adapter from the environment', () => {
    const adapter = createCrmAdapter({
      CRM_ADAPTER: 'webhook',
      CRM_LEAD_ENDPOINT: 'https://crm.example/leads',
      CRM_EVENT_ENDPOINT: 'https://crm.example/events',
      CRM_TOKEN: 't',
    });
    expect(adapter.name).toBe('batching(webhook)');
  });

  it('refuses a webhook adapter with no endpoints', () => {
    expect(() => createCrmAdapter({ CRM_ADAPTER: 'webhook' })).toThrow(/requires CRM_LEAD_ENDPOINT/);
  });

  it('refuses an unknown adapter name rather than dropping leads silently', () => {
    expect(() => createCrmAdapter({ CRM_ADAPTER: 'salesfarce' })).toThrow(/Unknown CRM_ADAPTER/);
  });
});
