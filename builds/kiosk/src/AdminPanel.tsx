import { useEffect, useState } from 'react';
import { syncQueue, type EventQueue, type SyncResult } from '@demo-platform/player';
import type { KioskConfig } from './config.js';

export interface AdminPanelProps {
  queue: EventQueue;
  config: KioskConfig;
  onClose: () => void;
}

/**
 * Kiosk admin panel (SPEC §8.2).
 *
 * Reached from the unlabelled corner on the picker. Shows how many events are waiting
 * and flushes them to the same endpoint the web target uses. Events are only deleted
 * once the server has accepted them, so a failed sync loses nothing.
 */
export function AdminPanel({ queue, config, onClose }: AdminPanelProps): React.ReactElement {
  const [pending, setPending] = useState<number | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    void queue.count().then(setPending).catch(() => setPending(null));
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [queue]);

  async function sync(): Promise<void> {
    if (!config.eventsEndpoint) {
      setResult({ sent: 0, remaining: pending ?? 0, error: 'No events endpoint configured in kiosk-config.json.' });
      return;
    }
    setSyncing(true);
    try {
      const outcome = await syncQueue(queue, config.eventsEndpoint);
      setResult(outcome);
      setPending(outcome.remaining);
    } catch (error) {
      setResult({
        sent: 0,
        remaining: pending ?? 0,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="admin" role="dialog" aria-modal="true" aria-label="Kiosk admin">
      <div className="admin-panel">
        <header>
          <h2>Kiosk admin</h2>
          <button type="button" className="admin-close" onClick={onClose}>
            Close
          </button>
        </header>

        <dl>
          <dt>Queued events</dt>
          <dd data-testid="admin-pending">{pending === null ? 'unavailable' : pending}</dd>
          <dt>Connectivity</dt>
          <dd>{online ? 'online' : 'offline'}</dd>
          <dt>Endpoint</dt>
          <dd className="admin-endpoint">{config.eventsEndpoint || 'not configured (queue only)'}</dd>
          <dt>Attract loop</dt>
          <dd>{config.idleResetMs > 0 ? `${Math.round(config.idleResetMs / 1000)} s idle` : 'off'}</dd>
          <dt>Build</dt>
          <dd>{config.buildId || 'unknown'}</dd>
        </dl>

        <button type="button" className="admin-sync" onClick={sync} disabled={syncing || pending === 0}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>

        {result ? (
          <p className={`admin-result${result.error ? ' is-error' : ''}`} role="status">
            {result.error
              ? `${result.sent} sent, ${result.remaining} still queued — ${result.error}`
              : `${result.sent} event(s) synced. ${result.remaining} remaining.`}
          </p>
        ) : null}

        <p className="admin-note">
          Events stay on this machine until the server accepts them. A failed sync loses
          nothing — try again when there is a connection.
        </p>
      </div>
    </div>
  );
}
