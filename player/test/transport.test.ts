import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoEvent } from '@demo-platform/shared';
import { ConsoleTransport, HttpTransport, MultiTransport, NullTransport } from '../src/analytics/transport.js';

function event(index: number): DemoEvent {
  return {
    eventId: `evt_${index}`,
    sessionId: 'ses_1',
    demoId: 'inlumin-flow-01',
    timestamp: '2026-08-21T10:00:00.000Z',
    name: 'step_viewed',
    payload: { stepId: `step-${index}`, chapterId: 'ch-01' },
  };
}

describe('HttpTransport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('batches up to the batch size before posting', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
    );
    const transport = new HttpTransport({ endpoint: '/api/events', batchSize: 10, fetchImpl });

    for (let i = 0; i < 9; i += 1) transport.send(event(i));
    expect(fetchImpl).not.toHaveBeenCalled();

    transport.send(event(9));
    await vi.runAllTimersAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
    expect(body.events).toHaveLength(10);
  });

  it('flushes on the interval when the batch never fills', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
    );
    const transport = new HttpTransport({
      endpoint: '/api/events',
      batchSize: 10,
      flushIntervalMs: 15_000,
      fetchImpl,
    });

    transport.send(event(0));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses sendBeacon on unload so the abandonment event survives navigation', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
    );
    const sendBeacon = vi.fn(() => true);
    const transport = new HttpTransport({ endpoint: '/api/events', fetchImpl, sendBeacon });

    transport.send(event(0));
    await transport.flush('unload');

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to keepalive fetch when sendBeacon refuses', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
    );
    const transport = new HttpTransport({
      endpoint: '/api/events',
      fetchImpl,
      sendBeacon: () => false,
    });

    transport.send(event(0));
    await transport.flush('unload');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).keepalive).toBe(true);
  });

  it('reports errors instead of throwing into the demo', async () => {
    const onError = vi.fn((_error: unknown, _dropped: DemoEvent[]) => {});
    const transport = new HttpTransport({
      endpoint: '/api/events',
      fetchImpl: async () => {
        throw new Error('offline');
      },
      onError,
    });

    transport.send(event(0));
    await transport.flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toHaveLength(1);
  });

  it('does not post an empty batch', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
    );
    await new HttpTransport({ endpoint: '/api/events', fetchImpl }).flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('NullTransport', () => {
  it('drops everything, which is what pre-consent means', async () => {
    const transport = new NullTransport();
    transport.send(event(0));
    await transport.flush();
    expect(transport.pending()).toBe(0);
  });
});

describe('MultiTransport', () => {
  it('fans out and sums pending counts', async () => {
    const console_ = new ConsoleTransport();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 202 }),
    );
    const http = new HttpTransport({ endpoint: '/api/events', batchSize: 99, fetchImpl });
    const multi = new MultiTransport([console_, http]);

    multi.send(event(0));
    expect(console_.all()).toHaveLength(1);
    expect(await multi.pending()).toBe(1);

    await multi.flush('complete');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
