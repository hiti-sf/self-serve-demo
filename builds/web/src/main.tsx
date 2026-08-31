import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { newSessionId } from '@demo-platform/shared';
import {
  DemoPlayer,
  ErrorScreen,
  HttpTransport,
  DemoLoadError,
  loadDemo,
  type DemoBundle,
} from '@demo-platform/player';
import '@demo-platform/player/styles.css';
import { GateForm } from './GateForm.js';
import { readGateState, writeGateState } from './gate-state.js';
import './web.css';

/**
 * Gated web target (SPEC §8.1).
 *
 * The demo is chosen by `?demo=`; the gate is chosen by the manifest's
 * `settings.gated`. Events go to the same-origin `/api/events` route, so no CRM
 * credential is ever in this bundle.
 */

const EVENTS_ENDPOINT = '/api/events';
const PRIVACY_URL = import.meta.env.VITE_PRIVACY_URL ?? '/privacy';
const DEFAULT_DEMO = '/demos/inlumin/flow-01-requisition-to-po';

function App(): React.ReactElement {
  const demoPath = new URLSearchParams(window.location.search).get('demo') ?? DEFAULT_DEMO;
  const [bundle, setBundle] = useState<DemoBundle | null>(null);
  const [error, setError] = useState<DemoLoadError | null>(null);
  const [leadId, setLeadId] = useState<string | undefined>(undefined);
  const [sessionId, setSessionId] = useState(() => newSessionId());

  const transport = useMemo(
    () =>
      new HttpTransport({
        endpoint: EVENTS_ENDPOINT,
        batchSize: 10,
        flushIntervalMs: 15_000,
        onError: (cause) => console.warn('[demo] events not delivered', cause),
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    loadDemo(demoPath)
      .then((loaded) => {
        if (cancelled) return;
        setBundle(loaded);
        // A visitor who already filled the gate this session must not see it twice.
        const saved = readGateState(loaded.manifest.demoId);
        if (saved) {
          setLeadId(saved.leadId);
          setSessionId(saved.sessionId);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof DemoLoadError ? cause : new DemoLoadError(String(cause?.message ?? cause)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [demoPath]);

  if (error) {
    return <ErrorScreen title="This demo is unavailable" message={error.message} detail={error.detail} />;
  }
  if (!bundle) {
    return <div className="dp-loading">Loading demo…</div>;
  }

  const gated = bundle.manifest.settings.gated && !leadId;

  if (gated) {
    const firstStepId = bundle.manifest.chapters[0]?.steps[0];
    const firstStep = bundle.manifest.steps.find((step) => step.stepId === firstStepId);
    return (
      <GateForm
        manifest={bundle.manifest}
        sessionId={sessionId}
        previewImageUrl={bundle.resolve(firstStep?.fallbackImage ?? '')}
        privacyUrl={PRIVACY_URL}
        onUnlocked={(newLeadId) => {
          writeGateState(bundle.manifest.demoId, { leadId: newLeadId, sessionId });
          setLeadId(newLeadId);
        }}
      />
    );
  }

  return (
    <DemoPlayer
      manifest={bundle.manifest}
      resolve={bundle.resolve}
      transport={transport}
      entrySource="web"
      // Consent is implied by a successful gate submission; an ungated demo has
      // nothing to consent to and fires no lead-identified events.
      analyticsEnabled={Boolean(leadId) || !bundle.manifest.settings.gated}
      leadId={leadId}
      sessionId={sessionId}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
