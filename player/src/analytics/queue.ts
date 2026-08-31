import type { DemoEvent } from '@demo-platform/shared';
import type { AnalyticsTransport } from './transport.js';

/**
 * Offline event queue for kiosk builds (SPEC §8.2).
 *
 * Events are durable in IndexedDB across restarts — a tradeshow laptop gets closed,
 * reopened and closed again, and the drop-off data from those sessions is the point of
 * the exercise. A "sync" action flushes to the same events endpoint the web target uses.
 */

const DB_NAME = 'demo-platform-events';
const STORE = 'queue';
const DB_VERSION = 1;

export interface QueuedEvent {
  /** Auto-increment key, so replay order matches capture order. */
  id?: number;
  event: DemoEvent;
  queuedAt: string;
  attempts: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the event queue'));
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('event queue request failed'));
  });
}

export class EventQueue {
  private db: Promise<IDBDatabase> | null = null;

  private connect(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  async enqueue(event: DemoEvent): Promise<void> {
    const db = await this.connect();
    const tx = db.transaction(STORE, 'readwrite');
    const record: QueuedEvent = { event, queuedAt: new Date().toISOString(), attempts: 0 };
    await promisify(tx.objectStore(STORE).add(record));
  }

  async all(): Promise<QueuedEvent[]> {
    const db = await this.connect();
    const tx = db.transaction(STORE, 'readonly');
    return promisify(tx.objectStore(STORE).getAll() as IDBRequest<QueuedEvent[]>);
  }

  async count(): Promise<number> {
    const db = await this.connect();
    const tx = db.transaction(STORE, 'readonly');
    return promisify(tx.objectStore(STORE).count());
  }

  async remove(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.connect();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    await Promise.all(ids.map((id) => promisify(store.delete(id))));
  }

  async markAttempted(records: QueuedEvent[]): Promise<void> {
    const db = await this.connect();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    await Promise.all(
      records
        .filter((record) => record.id !== undefined)
        .map((record) => promisify(store.put({ ...record, attempts: record.attempts + 1 }))),
    );
  }
}

export interface SyncResult {
  sent: number;
  remaining: number;
  error?: string;
}

/**
 * Flush the queue to the events endpoint in batches. Events are only deleted once the
 * server has accepted them, so a failed sync loses nothing.
 */
export async function syncQueue(
  queue: EventQueue,
  endpoint: string,
  { batchSize = 50, fetchImpl = fetch }: { batchSize?: number; fetchImpl?: typeof fetch } = {},
): Promise<SyncResult> {
  const pending = await queue.all();
  if (pending.length === 0) return { sent: 0, remaining: 0 };

  let sent = 0;
  for (let index = 0; index < pending.length; index += batchSize) {
    const batch = pending.slice(index, index + batchSize);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch.map((record) => record.event) }),
      });
      if (!response.ok) {
        await queue.markAttempted(batch);
        return {
          sent,
          remaining: (await queue.count()),
          error: `events endpoint returned ${response.status}`,
        };
      }
      await queue.remove(batch.map((record) => record.id!).filter((id) => id !== undefined));
      sent += batch.length;
    } catch (error) {
      await queue.markAttempted(batch);
      return {
        sent,
        remaining: await queue.count(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { sent, remaining: await queue.count() };
}

/** Transport that writes to the offline queue instead of the network. */
export class QueueTransport implements AnalyticsTransport {
  constructor(private readonly queue: EventQueue = new EventQueue()) {}

  send(event: DemoEvent): void {
    // Fire-and-forget: a kiosk must never block the demo on storage.
    void this.queue.enqueue(event).catch(() => {
      /* storage unavailable (private mode, quota) — the demo still plays */
    });
  }

  async flush(_reason?: 'unload' | 'complete' | 'manual'): Promise<void> {
    /* already durable */
  }

  pending(): Promise<number> {
    return this.queue.count().catch(() => 0);
  }

  handle(): EventQueue {
    return this.queue;
  }
}
