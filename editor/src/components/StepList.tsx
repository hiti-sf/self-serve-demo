import { useRef, useState } from 'react';
import type { EditorProject } from '../state/project.js';

export interface StepListProps {
  project: EditorProject;
  selectedStepId: string | null;
  onSelect: (stepId: string) => void;
  onMove: (stepId: string, toIndex: number) => void;
  onAssignChapter: (stepId: string, chapterId: string) => void;
  onRemove: (stepId: string) => void;
  onAddChapter: () => void;
  onRenameChapter: (chapterId: string, title: string) => void;
  onRemoveChapter: (chapterId: string) => void;
  onImportClick: () => void;
}

/**
 * Step list with drag reordering and chapter grouping (SPEC §7).
 *
 * Plain HTML5 drag-and-drop: no drag library. The list is short (a flow is 8–15 steps),
 * the interaction is one-dimensional, and a dependency here would end up in the editor
 * bundle for no gain.
 */
export function StepList({
  project,
  selectedStepId,
  onSelect,
  onMove,
  onAssignChapter,
  onRemove,
  onAddChapter,
  onRenameChapter,
  onRemoveChapter,
  onImportClick,
}: StepListProps): React.ReactElement {
  // The dragged step id lives in a ref, not state: dragstart and drop can land in the
  // same task, and a state update would not be visible to the drop handler yet.
  const draggingRef = useRef<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const stepIndex = (stepId: string) => project.steps.findIndex((step) => step.stepId === stepId);

  return (
    <aside className="steps">
      <header className="steps-header">
        <h2>Steps</h2>
        <button type="button" className="btn btn--primary btn--sm" onClick={onImportClick}>
          Import capture
        </button>
      </header>

      {project.chapters.map((chapter) => {
        const chapterSteps = project.steps.filter((step) => step.chapterId === chapter.chapterId);
        return (
          <section key={chapter.chapterId} className="chapter">
            <header className="chapter-header">
              <input
                className="chapter-title"
                value={chapter.title}
                onChange={(event) => onRenameChapter(chapter.chapterId, event.target.value)}
                aria-label={`Chapter title for ${chapter.chapterId}`}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => onRemoveChapter(chapter.chapterId)}
                disabled={project.chapters.length <= 1}
                title={
                  project.chapters.length <= 1
                    ? 'A demo needs at least one chapter'
                    : 'Delete this chapter; its steps move to the first chapter'
                }
              >
                Delete
              </button>
            </header>

            <ol className="step-list">
              {chapterSteps.map((step) => {
                const index = stepIndex(step.stepId);
                return (
                  <li
                    key={step.stepId}
                    draggable
                    className={`step${step.stepId === selectedStepId ? ' is-selected' : ''}${
                      dropIndex === index ? ' is-drop-target' : ''
                    }`}
                    onDragStart={() => {
                      draggingRef.current = step.stepId;
                    }}
                    onDragEnd={() => {
                      draggingRef.current = null;
                      setDropIndex(null);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDropIndex(index);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const dragging = draggingRef.current;
                      if (dragging && dragging !== step.stepId) {
                        onMove(dragging, index);
                        // A step dragged into another chapter's block joins it: the
                        // author's intent is "put it here", not "put it here but keep
                        // it in a chapter it no longer sits under".
                        onAssignChapter(dragging, chapter.chapterId);
                      }
                      draggingRef.current = null;
                      setDropIndex(null);
                    }}
                    data-testid={`step-row-${step.stepId}`}
                  >
                    <button type="button" className="step-main" onClick={() => onSelect(step.stepId)}>
                      <img className="step-thumb" src={step.fallbackImage} alt="" />
                      <span className="step-meta">
                        <span className="step-id">{step.stepId}</span>
                        <span className="step-sub">
                          {step.hotspots.length} hotspot{step.hotspots.length === 1 ? '' : 's'}
                          {step.textEdited ? ' · edited' : ''}
                        </span>
                      </span>
                    </button>
                    <div className="step-actions">
                      <select
                        value={step.chapterId}
                        onChange={(event) => onAssignChapter(step.stepId, event.target.value)}
                        aria-label={`Chapter for ${step.stepId}`}
                        title="Move to chapter"
                      >
                        {project.chapters.map((option) => (
                          <option key={option.chapterId} value={option.chapterId}>
                            {option.title}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => onRemove(step.stepId)}
                        title="Delete this step"
                      >
                        ×
                      </button>
                    </div>
                  </li>
                );
              })}
              {chapterSteps.length === 0 ? (
                <li
                  className="step step--empty"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggingRef.current) onAssignChapter(draggingRef.current, chapter.chapterId);
                    draggingRef.current = null;
                  }}
                >
                  Drag a step here
                </li>
              ) : null}
            </ol>
          </section>
        );
      })}

      <button type="button" className="btn btn--outline btn--sm steps-add-chapter" onClick={onAddChapter}>
        Add chapter
      </button>
    </aside>
  );
}
