import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DemoPlayer } from './DemoPlayer.js';
import { ErrorScreen } from './components/ErrorScreen.js';
import { DemoLoadError, loadDemo, type DemoBundle } from './loader/loadDemo.js';
import { ConsoleTransport } from './analytics/transport.js';
import './styles.css';

/**
 * Development harness for the player.
 *
 * Deliberately ungated and console-only: this is the surface used to verify M2 (a
 * hand-written manifest plays end to end). The gated web target and the kiosk target
 * are separate entries under builds/ that import the same DemoPlayer.
 *
 *   /?demo=/demos/inlumin/flow-01-requisition-to-po
 */

const DEFAULT_DEMO = '/demos/inlumin/flow-01-requisition-to-po';
const transport = new ConsoleTransport();

function Harness(): React.ReactElement {
  const [bundle, setBundle] = useState<DemoBundle | null>(null);
  const [error, setError] = useState<DemoLoadError | null>(null);
  const demoPath = new URLSearchParams(window.location.search).get('demo') ?? DEFAULT_DEMO;

  useEffect(() => {
    let cancelled = false;
    setBundle(null);
    setError(null);
    loadDemo(demoPath)
      .then((loaded) => {
        if (!cancelled) setBundle(loaded);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof DemoLoadError ? cause : new DemoLoadError(String(cause?.message ?? cause)),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [demoPath]);

  if (error) {
    return <ErrorScreen title="This demo could not be loaded" message={error.message} detail={error.detail} />;
  }
  if (!bundle) {
    return <div className="dp-loading">Loading demo…</div>;
  }

  return (
    <DemoPlayer
      manifest={bundle.manifest}
      resolve={bundle.resolve}
      transport={transport}
      entrySource="web"
      analyticsEnabled
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
