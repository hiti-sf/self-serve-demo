import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DemoPlayer,
  ErrorScreen,
  EventQueue,
  QueueTransport,
  DemoLoadError,
  loadDemo,
  syncQueue,
  type DemoBundle,
} from '@demo-platform/player';
import '@demo-platform/player/styles.css';
import { DemoPicker } from './DemoPicker.js';
import { AdminPanel } from './AdminPanel.js';
import { DEFAULT_CONFIG, loadDemoIndex, loadKioskConfig, type DemoIndex, type KioskConfig } from './config.js';
import './kiosk.css';

/**
 * Kiosk shell (SPEC §8.2).
 *
 * Zero network calls at runtime: the manifest, snapshots and images all come from the
 * bundle, and analytics events go to an IndexedDB queue. Gating is not merely disabled
 * here — the gate component is not part of this bundle at all.
 */

const queue = new EventQueue();
const transport = new QueueTransport(queue);

function Kiosk(): React.ReactElement {
  const [config, setConfig] = useState<KioskConfig>(DEFAULT_CONFIG);
  const [index, setIndex] = useState<DemoIndex | null>(null);
  const [bundle, setBundle] = useState<DemoBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);

  useEffect(() => {
    void loadKioskConfig().then(setConfig);
    loadDemoIndex()
      .then(setIndex)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  // Auto-sync when the machine comes back online (§8.2). Nothing leaves the machine
  // before this, and nothing is deleted until the server accepts it.
  useEffect(() => {
    if (!config.autoSyncOnline || !config.eventsEndpoint) return;
    const onOnline = () => {
      void syncQueue(queue, config.eventsEndpoint).catch(() => {
        /* stay queued */
      });
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [config.autoSyncOnline, config.eventsEndpoint]);

  const openDemo = useCallback((path: string) => {
    setError(null);
    loadDemo(path)
      .then(setBundle)
      .catch((cause) =>
        setError(cause instanceof DemoLoadError ? [cause.message, ...cause.detail].join(' ') : String(cause)),
      );
  }, []);

  const backToPicker = useCallback(() => setBundle(null), []);

  // The manifest's own idleResetMs is authored for the web; the kiosk config wins here
  // because the attract loop is a property of the booth, not of the demo.
  const manifest = useMemo(() => {
    if (!bundle) return null;
    return {
      ...bundle.manifest,
      settings: { ...bundle.manifest.settings, gated: false, idleResetMs: config.idleResetMs },
    };
  }, [bundle, config.idleResetMs]);

  if (error && !bundle) {
    return <ErrorScreen title="This bundle has a problem" message={error} />;
  }

  if (bundle && manifest) {
    return (
      <DemoPlayer
        manifest={manifest}
        resolve={bundle.resolve}
        transport={transport}
        entrySource="kiosk"
        analyticsEnabled
        onIdleReset={backToPicker}
        onExit={backToPicker}
      />
    );
  }

  if (!index) {
    return <div className="dp-loading">Loading demos…</div>;
  }

  return (
    <>
      <DemoPicker
        index={index}
        kioskLabel={config.kioskLabel}
        onSelect={openDemo}
        onOpenAdmin={() => setAdminOpen(true)}
      />
      {adminOpen ? <AdminPanel queue={queue} config={config} onClose={() => setAdminOpen(false)} /> : null}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Kiosk />
  </StrictMode>,
);
