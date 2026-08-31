import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  newEventId,
  newSessionId,
  nowIso,
  type DemoEvent,
  type EntrySource,
  type EventName,
  type EventPayload,
} from '@demo-platform/shared';
import type { AnalyticsTransport } from './transport.js';
import { NullTransport } from './transport.js';

/**
 * Event emission, dwell timing and abandonment detection (SPEC §9).
 *
 * Drop-off analysis is the primary sales-intelligence output, so `session_abandoned`
 * gets three chances to fire: `pagehide` (the reliable one), `visibilitychange` to
 * hidden, and a client-side inactivity timeout. The server still derives abandonment
 * from session timeout as a backstop — a killed browser tab sends nothing at all.
 */

export interface UseAnalyticsOptions {
  demoId: string;
  transport: AnalyticsTransport;
  entrySource: EntrySource;
  /** False until consent is given on the web gate; no events fire before that (§11). */
  enabled: boolean;
  leadId?: string;
  sessionId?: string;
  referrer?: string;
  /** Idle time after which the session counts as abandoned. 0 disables. */
  inactivityMs?: number;
}

export interface Analytics {
  sessionId: string;
  track<N extends EventName>(name: N, payload: EventPayload<N>): void;
  stepEntered(stepId: string, chapterId: string): void;
  stepLeft(stepId: string): void;
  chapterCompleted(chapterId: string): void;
  demoCompleted(): void;
  ctaClicked(label: string, url: string): void;
  abandoned(derivedFrom: 'client-unload' | 'session-timeout' | 'kiosk-idle-reset'): void;
  flush(reason?: 'unload' | 'complete' | 'manual'): Promise<void>;
}

const DEFAULT_INACTIVITY_MS = 5 * 60 * 1000;

export function useAnalytics(options: UseAnalyticsOptions): Analytics {
  const {
    demoId,
    transport,
    entrySource,
    enabled,
    leadId,
    referrer = typeof document !== 'undefined' ? document.referrer : '',
    inactivityMs = DEFAULT_INACTIVITY_MS,
  } = options;

  const sessionIdRef = useRef(options.sessionId ?? newSessionId());
  const startedAtRef = useRef<number | null>(null);
  const stepEnteredAtRef = useRef<number | null>(null);
  const currentStepRef = useRef<string | null>(null);
  const completedRef = useRef(false);
  const abandonedRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The live transport is held in a ref so the emit callback is stable: an unstable
  // callback would re-fire step effects and double-count views.
  const transportRef = useRef<AnalyticsTransport>(transport);
  transportRef.current = enabled ? transport : new NullTransport();
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const leadIdRef = useRef(leadId);
  leadIdRef.current = leadId;

  const emit = useCallback(
    <N extends EventName>(name: N, payload: EventPayload<N>) => {
      if (!enabledRef.current) return;
      const event = {
        eventId: newEventId(),
        sessionId: sessionIdRef.current,
        demoId,
        ...(leadIdRef.current ? { leadId: leadIdRef.current } : {}),
        timestamp: nowIso(),
        name,
        payload,
      } as DemoEvent;
      transportRef.current.send(event);
    },
    [demoId],
  );

  const abandoned = useCallback(
    (derivedFrom: 'client-unload' | 'session-timeout' | 'kiosk-idle-reset') => {
      if (completedRef.current || abandonedRef.current) return;
      abandonedRef.current = true;
      const dwellMs = stepEnteredAtRef.current ? Math.round(performance.now() - stepEnteredAtRef.current) : 0;
      emit('session_abandoned', {
        lastStepId: currentStepRef.current ?? '',
        dwellMs,
        derivedFrom,
      });
      void transportRef.current.flush('unload');
    },
    [emit],
  );

  const resetIdleTimer = useCallback(() => {
    if (inactivityMs <= 0) return;
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => abandoned('session-timeout'), inactivityMs);
  }, [abandoned, inactivityMs]);

  // demo_started, once, as soon as events are permitted.
  useEffect(() => {
    if (!enabled || startedAtRef.current !== null) return;
    startedAtRef.current = performance.now();
    emit('demo_started', { entrySource, referrer });
    resetIdleTimer();
  }, [emit, enabled, entrySource, referrer, resetIdleTimer]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const onHide = () => abandoned('client-unload');
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') abandoned('client-unload');
    };

    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    };
  }, [abandoned, enabled]);

  return useMemo<Analytics>(
    () => ({
      sessionId: sessionIdRef.current,
      track: emit,
      stepEntered(stepId, chapterId) {
        currentStepRef.current = stepId;
        stepEnteredAtRef.current = performance.now();
        emit('step_viewed', { stepId, chapterId });
        resetIdleTimer();
      },
      stepLeft(stepId) {
        const enteredAt = stepEnteredAtRef.current;
        emit('step_completed', {
          stepId,
          dwellMs: enteredAt ? Math.round(performance.now() - enteredAt) : 0,
        });
      },
      chapterCompleted(chapterId) {
        emit('chapter_completed', { chapterId });
      },
      demoCompleted() {
        if (completedRef.current) return;
        completedRef.current = true;
        const startedAt = startedAtRef.current;
        emit('demo_completed', {
          totalMs: startedAt ? Math.round(performance.now() - startedAt) : 0,
        });
        void transportRef.current.flush('complete');
      },
      ctaClicked(label, url) {
        emit('cta_clicked', { ctaLabel: label, url });
        void transportRef.current.flush('complete');
      },
      abandoned,
      flush: (reason) => transportRef.current.flush(reason),
    }),
    [abandoned, emit, resetIdleTimer],
  );
}
