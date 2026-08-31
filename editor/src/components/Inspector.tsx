import type { Hotspot } from '@demo-platform/shared';
import type { EditorProject, EditorStep } from '../state/project.js';

export interface InspectorProps {
  project: EditorProject;
  step: EditorStep;
  hotspot: Hotspot | null;
  onPatchHotspot: (patch: Partial<Hotspot>) => void;
  onRemoveHotspot: () => void;
  onPatchStep: (patch: Partial<Omit<EditorStep, 'stepId'>>) => void;
  onStartPlacing: () => void;
}

/**
 * Tooltip and hotspot authoring (SPEC §7).
 *
 * The selector and the coordinates are shown, not hidden: an author who knows a hotspot
 * is anchored to a fragile structural path is an author who re-anchors it before it drifts
 * in front of a prospect.
 */
export function Inspector({
  project,
  step,
  hotspot,
  onPatchHotspot,
  onRemoveHotspot,
  onPatchStep,
  onStartPlacing,
}: InspectorProps): React.ReactElement {
  const otherSteps = project.steps.filter((candidate) => candidate.stepId !== step.stepId);

  return (
    <aside className="inspector">
      {hotspot ? (
        <>
          <header className="inspector-header">
            <h2>{hotspot.hotspotId}</h2>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onRemoveHotspot}>
              Delete
            </button>
          </header>

          <label className="field">
            <span>Tooltip title</span>
            <input
              value={hotspot.tooltip.title}
              maxLength={160}
              onChange={(event) =>
                onPatchHotspot({ tooltip: { ...hotspot.tooltip, title: event.target.value } })
              }
              data-testid="tooltip-title"
            />
          </label>

          <label className="field">
            <span>Tooltip body</span>
            <textarea
              rows={5}
              value={hotspot.tooltip.body}
              maxLength={2000}
              onChange={(event) =>
                onPatchHotspot({ tooltip: { ...hotspot.tooltip, body: event.target.value } })
              }
              data-testid="tooltip-body"
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Position</span>
              <select
                value={hotspot.tooltip.position}
                onChange={(event) =>
                  onPatchHotspot({
                    tooltip: { ...hotspot.tooltip, position: event.target.value as Hotspot['tooltip']['position'] },
                  })
                }
              >
                {(['auto', 'top', 'bottom', 'left', 'right'] as const).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Trigger</span>
              <select
                value={hotspot.trigger}
                onChange={(event) => onPatchHotspot({ trigger: event.target.value as Hotspot['trigger'] })}
              >
                {(['click', 'hover', 'auto'] as const).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {hotspot.trigger === 'auto' ? (
            <label className="field">
              <span>Auto-advance after (ms)</span>
              <input
                type="number"
                min={0}
                max={60000}
                step={250}
                value={hotspot.autoAdvanceMs ?? 2500}
                onChange={(event) => onPatchHotspot({ autoAdvanceMs: Number(event.target.value) })}
              />
            </label>
          ) : null}

          <label className="field">
            <span>Advances to</span>
            <select
              value={hotspot.advancesTo ?? ''}
              onChange={(event) =>
                onPatchHotspot({ advancesTo: event.target.value ? event.target.value : undefined })
              }
            >
              <option value="">Next step in order</option>
              {otherSteps.map((candidate) => (
                <option key={candidate.stepId} value={candidate.stepId}>
                  {candidate.stepId}
                </option>
              ))}
            </select>
          </label>

          <div className="anchor">
            <h3>Anchor</h3>
            <code className="anchor-selector" data-testid="anchor-selector">
              {hotspot.anchor.selector}
            </code>
            <p className="anchor-coords">
              fallback ({hotspot.anchorFallback.x.toFixed(3)}, {hotspot.anchorFallback.y.toFixed(3)})
            </p>
            <button type="button" className="btn btn--outline btn--sm" onClick={onStartPlacing}>
              Re-anchor by clicking the screen
            </button>
            <p className="hint">
              The selector is used first; the coordinates are the fallback when a snapshot
              cannot render.
            </p>
          </div>
        </>
      ) : (
        <>
          <header className="inspector-header">
            <h2>{step.stepId}</h2>
          </header>
          <p className="hint">
            Select a hotspot on the canvas, or place a new one, to author its tooltip.
          </p>
          <button type="button" className="btn btn--primary btn--sm" onClick={onStartPlacing}>
            Place a hotspot
          </button>

          <label className="field">
            <span>Author notes (never shown to a prospect)</span>
            <textarea
              rows={3}
              value={step.notes ?? ''}
              onChange={(event) => onPatchStep({ notes: event.target.value })}
            />
          </label>

          {step.captureMeta ? (
            <div className="capture-meta">
              <h3>Capture</h3>
              <dl>
                <dt>From</dt>
                <dd className="anchor-selector">{step.captureMeta.url}</dd>
                <dt>Taken</dt>
                <dd>{new Date(step.captureMeta.timestamp).toLocaleString()}</dd>
                <dt>Viewport</dt>
                <dd>
                  {step.captureMeta.viewport.width}×{step.captureMeta.viewport.height}
                </dd>
                <dt>Embedded</dt>
                <dd>{step.captureMeta.stats.embeddedResources} resources</dd>
              </dl>
              {step.captureMeta.warnings.length > 0 ? (
                <ul className="capture-warnings">
                  {step.captureMeta.warnings.slice(0, 6).map((warning, index) => (
                    <li key={`${warning.kind}-${index}`}>
                      <strong>{warning.kind.replace(/-/g, ' ')}</strong> {warning.detail}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}
