import type { CrmAdapter, DemoEvent, LeadInput } from './types.js';

/**
 * Batching decorator (SPEC §10): flush every 10 events or every 15 seconds, whichever
 * comes first, so a CRM's rate limit is not the thing that decides whether drop-off data
 * survives.
 *
 * Wraps any adapter. If the wrapped adapter exposes `recordEvents`, the whole batch goes
 * in one request; otherwise the decorator still bounds concurrency by sending the batch
 * sequentially.
 */

export interface BatchingOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  /** Called when a batch could not be delivered, so the caller can log or re-queue. */
  onError?: (error: unknown, dropped: DemoEvent[]) => void;
  /** Injected in tests. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

interface BatchCapable {
  recordEvents(events: DemoEvent[]): Promise<void>;
}

function supportsBatch(adapter: CrmAdapter): adapter is CrmAdapter & BatchCapable {
  return typeof (adapter as CrmAdapter & Partial<BatchCapable>).recordEvents === 'function';
}

export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_FLUSH_INTERVAL_MS = 15_000;

export class BatchingCrmAdapter implements CrmAdapter {
  readonly name: string;

  private buffer: DemoEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;

  constructor(
    private readonly inner: CrmAdapter,
    private readonly options: BatchingOptions = {},
  ) {
    this.name = `batching(${inner.name})`;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  /** Leads are never batched: the visitor is waiting on the leadId to unlock the demo. */
  createLead(lead: LeadInput): Promise<{ leadId: string }> {
    return this.inner.createLead(lead);
  }

  async recordEvent(event: DemoEvent): Promise<void> {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = this.setTimeoutImpl(() => {
        void this.flush();
      }, this.flushIntervalMs);
    }
  }

  async recordEvents(events: DemoEvent[]): Promise<void> {
    for (const event of events) {
      this.buffer.push(event);
      if (this.buffer.length >= this.batchSize) await this.flush();
    }
    if (this.buffer.length > 0 && this.timer === null) {
      this.timer = this.setTimeoutImpl(() => {
        void this.flush();
      }, this.flushIntervalMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    try {
      if (supportsBatch(this.inner)) {
        await this.inner.recordEvents(batch);
      } else {
        for (const event of batch) await this.inner.recordEvent(event);
      }
      await this.inner.flush?.();
    } catch (error) {
      // Never throw into the events route: a CRM outage must not turn into 500s that
      // make the player retry and multiply the load.
      this.options.onError?.(error, batch);
    }
  }

  pending(): number {
    return this.buffer.length;
  }
}
