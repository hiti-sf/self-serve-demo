import type { DemoEvent } from '@demo-platform/shared';

/**
 * Pluggable analytics transport (SPEC §6): the player fires events, the build target
 * decides where they go. Web posts them to the events endpoint; kiosk queues them in
 * IndexedDB and syncs later; the editor preview logs them.
 */
export interface AnalyticsTransport {
  send(event: DemoEvent): void;
  /** Best-effort flush. Called on pagehide and when the demo completes. */
  flush(reason?: 'unload' | 'complete' | 'manual'): Promise<void>;
  /** Pending event count, for the kiosk admin panel. */
  pending?(): Promise<number> | number;
}

export class ConsoleTransport implements AnalyticsTransport {
  private readonly events: DemoEvent[] = [];

  send(event: DemoEvent): void {
    this.events.push(event);
    // eslint-disable-next-line no-console -- this transport exists to print
    console.info(`[demo-analytics] ${event.name}`, event);
  }

  async flush(_reason?: 'unload' | 'complete' | 'manual'): Promise<void> {
    /* nothing buffered */
  }

  pending(): number {
    return 0;
  }

  /** Test/inspection helper. */
  all(): readonly DemoEvent[] {
    return this.events;
  }
}

export interface HttpTransportOptions {
  endpoint: string;
  /** Flush when this many events are buffered (§10). */
  batchSize?: number;
  /** …or when this long has passed since the first buffered event (§10). */
  flushIntervalMs?: number;
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to navigator.sendBeacon when available. */
  sendBeacon?: (url: string, body: string) => boolean;
  onError?: (error: unknown, dropped: DemoEvent[]) => void;
}

/**
 * Batching HTTP transport. Batching is a rate-limit requirement from §10, and it also
 * means a demo with 40 step events does not make 40 round trips on a booth's tethered
 * connection.
 */
export class HttpTransport implements AnalyticsTransport {
  private buffer: DemoEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.batchSize = options.batchSize ?? 10;
    this.flushIntervalMs = options.flushIntervalMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  send(event: DemoEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      void this.flush('manual');
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => void this.flush('manual'), this.flushIntervalMs);
    }
  }

  async flush(reason: 'unload' | 'complete' | 'manual' = 'manual'): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];
    const body = JSON.stringify({ events: batch });

    // On unload, fetch is unreliable even with keepalive; sendBeacon survives navigation.
    if (reason === 'unload') {
      const beacon =
        this.options.sendBeacon ??
        (typeof navigator !== 'undefined' && 'sendBeacon' in navigator
          ? (url: string, payload: string) => navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }))
          : undefined);
      if (beacon?.(this.options.endpoint, body)) return;
    }

    try {
      await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: reason === 'unload',
      });
    } catch (error) {
      this.options.onError?.(error, batch);
    }
  }

  pending(): number {
    return this.buffer.length;
  }
}

/** Fan out to several transports — used by kiosk (queue + console) and for debugging. */
export class MultiTransport implements AnalyticsTransport {
  constructor(private readonly transports: AnalyticsTransport[]) {}

  send(event: DemoEvent): void {
    for (const transport of this.transports) transport.send(event);
  }

  async flush(reason?: 'unload' | 'complete' | 'manual'): Promise<void> {
    await Promise.all(this.transports.map((transport) => transport.flush(reason)));
  }

  async pending(): Promise<number> {
    const counts = await Promise.all(this.transports.map((t) => t.pending?.() ?? 0));
    return counts.reduce((sum, count) => sum + count, 0);
  }
}

/** Drops everything. Used before consent is given (§8.1, §11). */
export class NullTransport implements AnalyticsTransport {
  send(_event: DemoEvent): void {
    /* intentionally nothing */
  }

  async flush(_reason?: 'unload' | 'complete' | 'manual'): Promise<void> {
    /* intentionally nothing */
  }

  pending(): number {
    return 0;
  }
}
