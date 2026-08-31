import { StrictMode, useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@demo-platform/player/styles.css';
import { Canvas, type CanvasMode } from './components/Canvas.js';
import { ImportDialog } from './components/ImportDialog.js';
import { Inspector } from './components/Inspector.js';
import { PreviewModal } from './components/PreviewModal.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { StepList } from './components/StepList.js';
import { hotspotFromPick, type PickedAnchor } from './lib/anchor-picker.js';
import { clearDraft, downloadDemoZip, loadDraft, publishDemo, saveDraft } from './lib/export.js';
import {
  DEFAULT_CHAPTER_ID,
  emptyProject,
  nextHotspotId,
  nextStepId,
  projectReducer,
  toManifest,
  type EditorStep,
} from './state/project.js';
import './editor.css';

/**
 * Internal authoring app (SPEC §7).
 *
 * The tool that makes this platform sustainable without engineering in the loop: import
 * captures, place hotspots by clicking, write the copy, fix the captured text, group and
 * reorder, preview in the real player, publish.
 *
 * Auth is a shared password checked by the publish server (§7: "simple password or SSO
 * header check is sufficient; do not build user management"). It gates publishing, which
 * is the only action that writes anything.
 */

const TOKEN_KEY = 'demo-editor:token';

function App(): React.ReactElement {
  const [project, dispatch] = useReducer(projectReducer, undefined, () => loadDraft() ?? emptyProject());
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);
  const [mode, setMode] = useState<CanvasMode>('inspect');
  const [panel, setPanel] = useState<'inspector' | 'settings'>('inspector');
  const [importing, setImporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [publishState, setPublishState] = useState<string | null>(null);

  const step = project.steps.find((candidate) => candidate.stepId === selectedStepId) ?? project.steps[0] ?? null;
  const hotspot = step?.hotspots.find((candidate) => candidate.hotspotId === selectedHotspotId) ?? null;
  const manifestResult = useMemo(() => toManifest(project), [project]);

  // Draft persistence: a refresh mid-authoring must not cost the afternoon.
  useEffect(() => {
    saveDraft(project);
  }, [project]);

  useEffect(() => {
    if (step && step.stepId !== selectedStepId) setSelectedStepId(step.stepId);
  }, [selectedStepId, step]);

  const notice = useCallback((message: string) => {
    setNotices((previous) => [message, ...previous].slice(0, 4));
  }, []);

  const onImported = useCallback(
    (imported: Omit<EditorStep, 'stepId' | 'chapterId'>, warnings: string[]) => {
      // A new step joins the chapter the author was last working in, which is almost
      // always what "import the next screen" means.
      const stepId = nextStepId(project);
      const chapterId =
        project.steps[project.steps.length - 1]?.chapterId ?? project.chapters[0]?.chapterId ?? DEFAULT_CHAPTER_ID;

      dispatch({ type: 'step/add', step: { ...imported, stepId, chapterId } });
      setSelectedStepId(stepId);
      setSelectedHotspotId(null);
      setImporting(false);
      setMode('place-hotspot');
      for (const warning of warnings) notice(warning);
      notice(`Imported ${stepId}. Click an element to place your first hotspot.`);
    },
    [notice, project],
  );

  const onPick = useCallback(
    (pick: PickedAnchor) => {
      if (!step) return;
      const hotspotId = nextHotspotId(step);
      dispatch({ type: 'hotspot/add', stepId: step.stepId, hotspot: hotspotFromPick(hotspotId, pick) });
      setSelectedHotspotId(hotspotId);
      setMode('inspect');
      setPanel('inspector');
      if (pick.strength === 'structural') {
        notice(
          `${hotspotId} anchored to a positional path (${pick.selector}). It works, but ask the product team for a data-testid on that element if this demo will live a while.`,
        );
      }
    },
    [notice, step],
  );

  const onMoveHotspot = useCallback(
    (hotspotId: string, pick: PickedAnchor) => {
      if (!step) return;
      dispatch({
        type: 'hotspot/patch',
        stepId: step.stepId,
        hotspotId,
        patch: { anchor: { selector: pick.selector, strategy: 'css' }, anchorFallback: pick.fallback },
      });
      setMode('inspect');
      notice(`${hotspotId} re-anchored to ${pick.selector}`);
    },
    [notice, step],
  );

  async function onPublish(): Promise<void> {
    if (!manifestResult.ok) {
      setPublishState('Fix the problems listed below first.');
      return;
    }
    if (!token) {
      setPublishState('Enter the editor password to publish.');
      return;
    }
    setPublishState('Publishing…');
    const result = await publishDemo(project, token);
    if (result.ok) {
      setPublishState(`Published to ${result.folder} (${result.written} files).`);
      notice(`Published ${project.demoId}.`);
    } else {
      setPublishState(result.error ?? result.issues?.join(' · ') ?? 'Publish failed.');
    }
  }

  return (
    <div className="editor">
      <header className="topbar">
        <div className="topbar-left">
          <strong>Demo editor</strong>
          <span className="topbar-demo">{project.demoId}</span>
          <span className={`badge${manifestResult.ok ? ' badge--ok' : ' badge--warn'}`}>
            {manifestResult.ok ? 'valid' : `${manifestResult.issues.length} to fix`}
          </span>
        </div>

        <div className="topbar-modes" role="group" aria-label="Canvas mode">
          {(['inspect', 'place-hotspot', 'edit-text'] as CanvasMode[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={`btn btn--chip${mode === candidate ? ' is-active' : ''}`}
              onClick={() => setMode(candidate)}
              disabled={!step}
              data-testid={`mode-${candidate}`}
            >
              {candidate === 'inspect' ? 'Inspect' : candidate === 'place-hotspot' ? 'Place hotspot' : 'Edit text'}
            </button>
          ))}
        </div>

        <div className="topbar-right">
          <button
            type="button"
            className={`btn btn--chip${panel === 'settings' ? ' is-active' : ''}`}
            onClick={() => setPanel(panel === 'settings' ? 'inspector' : 'settings')}
          >
            Demo settings
          </button>
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => setPreviewing(true)}
            disabled={!manifestResult.ok}
            title={manifestResult.ok ? 'Play the demo in the real player' : 'Fix the listed problems first'}
            data-testid="preview-button"
          >
            Preview
          </button>
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => void downloadDemoZip(project)}
            disabled={!manifestResult.ok}
          >
            Export folder
          </button>
          <input
            className="token"
            type="password"
            placeholder="Editor password"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              sessionStorage.setItem(TOKEN_KEY, event.target.value);
            }}
            aria-label="Editor password"
          />
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => void onPublish()}
            disabled={!manifestResult.ok}
            data-testid="publish-button"
          >
            Publish
          </button>
        </div>
      </header>

      <div className="workspace">
        <StepList
          project={project}
          selectedStepId={step?.stepId ?? null}
          onSelect={(stepId) => {
            setSelectedStepId(stepId);
            setSelectedHotspotId(null);
            setMode('inspect');
          }}
          onMove={(stepId, toIndex) => dispatch({ type: 'step/move', stepId, toIndex })}
          onAssignChapter={(stepId, chapterId) => dispatch({ type: 'step/assignChapter', stepId, chapterId })}
          onRemove={(stepId) => {
            dispatch({ type: 'step/remove', stepId });
            if (stepId === selectedStepId) setSelectedStepId(null);
          }}
          onAddChapter={() => dispatch({ type: 'chapter/add' })}
          onRenameChapter={(chapterId, title) => dispatch({ type: 'chapter/rename', chapterId, title })}
          onRemoveChapter={(chapterId) => dispatch({ type: 'chapter/remove', chapterId })}
          onImportClick={() => setImporting(true)}
        />

        <main className="stage">
          {step ? (
            <Canvas
              step={step}
              mode={mode}
              selectedHotspotId={selectedHotspotId}
              onPick={onPick}
              onSelectHotspot={(hotspotId) => {
                setSelectedHotspotId(hotspotId);
                setPanel('inspector');
              }}
              onSnapshotEdited={(html) =>
                dispatch({ type: 'step/setSnapshot', stepId: step.stepId, html })
              }
              onMoveHotspot={onMoveHotspot}
            />
          ) : (
            <div className="empty">
              <h2>No steps yet</h2>
              <p>
                Capture a screen with the extension, then import the folder it wrote. A flow is
                usually 8–15 steps.
              </p>
              <button type="button" className="btn btn--primary" onClick={() => setImporting(true)}>
                Import a capture
              </button>
            </div>
          )}
        </main>

        {panel === 'settings' ? (
          <aside className="inspector">
            <SettingsPanel
              project={project}
              onMeta={(patch) => dispatch({ type: 'project/meta', patch })}
              onTheme={(patch) => dispatch({ type: 'project/theme', patch })}
              onSettings={(patch) => dispatch({ type: 'project/settings', patch })}
              onEndScreen={(patch) => dispatch({ type: 'project/endScreen', patch })}
            />
          </aside>
        ) : step ? (
          <Inspector
            project={project}
            step={step}
            hotspot={hotspot}
            onPatchHotspot={(patch) =>
              hotspot &&
              dispatch({ type: 'hotspot/patch', stepId: step.stepId, hotspotId: hotspot.hotspotId, patch })
            }
            onRemoveHotspot={() => {
              if (!hotspot) return;
              dispatch({ type: 'hotspot/remove', stepId: step.stepId, hotspotId: hotspot.hotspotId });
              setSelectedHotspotId(null);
            }}
            onPatchStep={(patch) => dispatch({ type: 'step/patch', stepId: step.stepId, patch })}
            onStartPlacing={() => setMode('place-hotspot')}
          />
        ) : (
          <aside className="inspector" />
        )}
      </div>

      <footer className="statusbar">
        {manifestResult.ok ? (
          <span className="status-ok">
            {project.steps.length} step(s) · {project.chapters.length} chapter(s) · ready to publish
          </span>
        ) : (
          <ul className="status-issues">
            {manifestResult.issues.slice(0, 3).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
            {manifestResult.issues.length > 3 ? <li>…and {manifestResult.issues.length - 3} more</li> : null}
          </ul>
        )}
        {publishState ? <span className="status-publish">{publishState}</span> : null}
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            clearDraft();
            dispatch({ type: 'project/load', project: emptyProject() });
            setSelectedStepId(null);
          }}
        >
          New demo
        </button>
      </footer>

      {notices.length > 0 ? (
        <div className="notices" role="status">
          {notices.map((message, index) => (
            <p key={`${message}-${index}`}>{message}</p>
          ))}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNotices([])}>
            Dismiss
          </button>
        </div>
      ) : null}

      {importing ? <ImportDialog onImported={onImported} onClose={() => setImporting(false)} /> : null}

      {previewing && manifestResult.ok ? (
        <PreviewModal
          project={project}
          manifest={manifestResult.manifest}
          {...(step ? { startStepId: step.stepId } : {})}
          onClose={() => setPreviewing(false)}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
