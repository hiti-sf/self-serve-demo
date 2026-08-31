import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  chapterForStep,
  nextStepId,
  orderedStepIds,
  previousStepId,
  stepById,
  stepViewport,
  type EntrySource,
  type Hotspot,
  type Manifest,
} from '@demo-platform/shared';
import { computeFit, isBelowDesktopFloor } from './geometry.js';
import { useElementSize } from './hooks/useElementSize.js';
import { useKeyboardNav } from './hooks/useKeyboardNav.js';
import { useIdleReset } from './hooks/useIdleReset.js';
import { useAnalytics } from './analytics/useAnalytics.js';
import type { AnalyticsTransport } from './analytics/transport.js';
import { SnapshotFrame } from './components/SnapshotFrame.js';
import { HotspotLayer } from './components/HotspotLayer.js';
import { ProgressBar } from './components/ProgressBar.js';
import { ChapterMenu } from './components/ChapterMenu.js';
import { EndScreen } from './components/EndScreen.js';
import { MobileInterstitial } from './components/MobileInterstitial.js';
import { loadSnapshotHtml } from './loader/loadDemo.js';

/**
 * The player (SPEC §6). One engine, many manifests: everything on screen comes from the
 * manifest, and nothing here knows which product or demo it is rendering.
 */

export interface DemoPlayerProps {
  manifest: Manifest;
  /** Resolves manifest-relative paths (snapshots, images, logo). */
  resolve: (relativePath: string) => string;
  transport: AnalyticsTransport;
  entrySource: EntrySource;
  /** False until consent; the player renders but fires no events (§8.1, §11). */
  analyticsEnabled?: boolean;
  leadId?: string;
  sessionId?: string;
  /** Kiosk: called when the attract loop times out. */
  onIdleReset?: () => void;
  /** Kiosk: called when the visitor leaves the demo. */
  onExit?: () => void;
  /** Editor preview: start on a given step. */
  initialStepId?: string;
  /** Editor preview: notify the host as the visitor moves. */
  onStepChange?: (stepId: string) => void;
  fetchImpl?: typeof fetch;
}

type SnapshotState =
  | { status: 'loading' }
  | { status: 'ready'; html: string }
  | { status: 'fallback'; reason: string };

export function DemoPlayer({
  manifest,
  resolve,
  transport,
  entrySource,
  analyticsEnabled = true,
  leadId,
  sessionId,
  onIdleReset,
  onExit,
  initialStepId,
  onStepChange,
  fetchImpl,
}: DemoPlayerProps): React.ReactElement {
  const order = useMemo(() => orderedStepIds(manifest), [manifest]);
  const [currentStepId, setCurrentStepId] = useState(initialStepId ?? order[0]!);
  const [hotspotIndex, setHotspotIndex] = useState(0);
  const [finished, setFinished] = useState(false);
  const [chapterMenuOpen, setChapterMenuOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<SnapshotState>({ status: 'loading' });
  const [snapshotDoc, setSnapshotDoc] = useState<Document | null>(null);
  const [overrideMobile, setOverrideMobile] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const container = useElementSize(stageRef);

  const analytics = useAnalytics({
    demoId: manifest.demoId,
    transport,
    entrySource,
    enabled: analyticsEnabled,
    leadId,
    sessionId,
  });

  const step = stepById(manifest, currentStepId) ?? manifest.steps[0]!;
  const chapter = chapterForStep(manifest, step.stepId);
  const captured = stepViewport(step);
  const fit = useMemo(() => computeFit(container, captured), [captured, container]);
  const stepNumber = order.indexOf(step.stepId);
  const isLastStep = stepNumber === order.length - 1;

  // Load the snapshot for the current step. A failure is not an error: the step falls
  // back to its image and the demo keeps playing (§4).
  useEffect(() => {
    let cancelled = false;
    setSnapshot({ status: 'loading' });
    setSnapshotDoc(null);

    void loadSnapshotHtml(resolve(step.snapshot), fetchImpl ? { fetchImpl } : {}).then((html) => {
      if (cancelled) return;
      setSnapshot(
        html === null
          ? { status: 'fallback', reason: `could not load ${step.snapshot}` }
          : { status: 'ready', html },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [fetchImpl, resolve, step.snapshot]);

  // step_viewed on arrival; step_completed when leaving.
  const previousStepRef = useRef<string | null>(null);
  useEffect(() => {
    if (finished) return;
    const previous = previousStepRef.current;
    if (previous && previous !== step.stepId) analytics.stepLeft(previous);
    if (previous !== step.stepId) {
      analytics.stepEntered(step.stepId, chapter?.chapterId ?? '');
      onStepChange?.(step.stepId);
    }
    previousStepRef.current = step.stepId;
  }, [analytics, chapter?.chapterId, finished, onStepChange, step.stepId]);

  const goToStep = useCallback(
    (stepId: string) => {
      setChapterMenuOpen(false);
      setHotspotIndex(0);
      setCurrentStepId(stepId);
    },
    [],
  );

  const finish = useCallback(() => {
    analytics.stepLeft(step.stepId);
    if (chapter) analytics.chapterCompleted(chapter.chapterId);
    analytics.demoCompleted();
    setFinished(true);
  }, [analytics, chapter, step.stepId]);

  const advance = useCallback(
    (hotspot?: Hotspot) => {
      // Within a step, hotspots are sequential guidance; only the last one (or one with
      // an explicit advancesTo) moves the demo on.
      const explicit = hotspot?.advancesTo;
      if (!explicit && hotspotIndex < step.hotspots.length - 1) {
        setHotspotIndex(hotspotIndex + 1);
        return;
      }

      const target = explicit ?? nextStepId(manifest, step.stepId, hotspot?.hotspotId);
      if (!target) {
        finish();
        return;
      }

      const leavingChapter = chapter && !chapter.steps.includes(target);
      if (leavingChapter && chapter) analytics.chapterCompleted(chapter.chapterId);
      goToStep(target);
    },
    [analytics, chapter, finish, goToStep, hotspotIndex, manifest, step.hotspots.length, step.stepId],
  );

  const back = useCallback(() => {
    if (hotspotIndex > 0) {
      setHotspotIndex(hotspotIndex - 1);
      return;
    }
    const target = previousStepId(manifest, step.stepId);
    if (target) goToStep(target);
  }, [goToStep, hotspotIndex, manifest, step.stepId]);

  const replay = useCallback(() => {
    setFinished(false);
    previousStepRef.current = null;
    goToStep(order[0]!);
  }, [goToStep, order]);

  useKeyboardNav({
    enabled: manifest.settings.keyboardNav && !finished,
    onNext: () => advance(step.hotspots[hotspotIndex]),
    onBack: back,
    onToggleChapterMenu: () =>
      manifest.settings.showChapterMenu ? setChapterMenuOpen((open) => !open) : undefined,
    onEscape: chapterMenuOpen ? () => setChapterMenuOpen(false) : undefined,
  });

  useIdleReset(manifest.settings.idleResetMs, () => {
    analytics.abandoned('kiosk-idle-reset');
    void analytics.flush('unload');
    if (onIdleReset) onIdleReset();
    else replay();
  });

  const belowFloor = isBelowDesktopFloor(
    typeof window !== 'undefined' ? window.innerWidth : Number.POSITIVE_INFINITY,
  );

  if (belowFloor && !overrideMobile) {
    return (
      <MobileInterstitial
        manifest={manifest}
        resolve={resolve}
        onContinueAnyway={() => setOverrideMobile(true)}
      />
    );
  }

  if (finished) {
    return (
      <EndScreen
        endScreen={manifest.endScreen}
        theme={manifest.theme}
        logoUrl={manifest.theme.logo ? resolve(manifest.theme.logo) : undefined}
        onCtaClick={(label, url) => analytics.ctaClicked(label, url)}
        onReplay={replay}
      />
    );
  }

  return (
    <div
      className="dp-root"
      style={{
        ['--dp-primary' as string]: manifest.theme.primaryColor,
        ['--dp-accent' as string]: manifest.theme.accentColor ?? manifest.theme.primaryColor,
        ['--dp-backdrop' as string]: manifest.theme.backgroundColor ?? '#0e1113',
      }}
      data-demo-id={manifest.demoId}
      data-step-id={step.stepId}
    >
      <div className="dp-stage-wrap" ref={stageRef}>
        {snapshot.status === 'loading' ? (
          <div className="dp-loading" role="status">
            Loading…
          </div>
        ) : (
          <>
            <SnapshotFrame
              // A fresh iframe per step: without it, contentDocument can briefly still be
              // the previous step's document and hotspots would resolve against it.
              key={step.stepId}
              html={snapshot.status === 'ready' ? snapshot.html : null}
              fallbackImageUrl={resolve(step.fallbackImage)}
              fit={fit}
              title={`${manifest.title} — step ${stepNumber + 1}`}
              onDocumentReady={setSnapshotDoc}
              onFallback={(reason) => setSnapshot({ status: 'fallback', reason })}
            />
            <HotspotLayer
              hotspots={step.hotspots}
              activeIndex={Math.min(hotspotIndex, Math.max(0, step.hotspots.length - 1))}
              snapshotDoc={snapshotDoc}
              fit={fit}
              container={container}
              stepLabel={chapter?.title ?? manifest.title}
              canGoBack={hotspotIndex > 0 || stepNumber > 0}
              isLastStep={isLastStep}
              onAdvance={advance}
              onBack={back}
            />
          </>
        )}
      </div>

      <footer className="dp-chrome">
        {manifest.settings.showProgress ? (
          <ProgressBar
            currentIndex={stepNumber}
            total={order.length}
            chapterTitle={chapter?.title ?? manifest.title}
            onOpenChapters={
              manifest.settings.showChapterMenu ? () => setChapterMenuOpen(true) : undefined
            }
          />
        ) : (
          <span />
        )}
        {onExit ? (
          <button type="button" className="dp-button dp-button--ghost" onClick={onExit}>
            Exit demo
          </button>
        ) : null}
      </footer>

      {chapterMenuOpen ? (
        <ChapterMenu
          chapters={manifest.chapters}
          currentStepId={step.stepId}
          onSelect={goToStep}
          onClose={() => setChapterMenuOpen(false)}
        />
      ) : null}

      {snapshot.status === 'fallback' ? (
        <p className="dp-notice" role="status">
          Showing a static image for this step.
        </p>
      ) : null}
    </div>
  );
}
