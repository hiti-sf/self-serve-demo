import type { Chapter } from '@demo-platform/shared';

export interface ChapterMenuProps {
  chapters: Chapter[];
  currentStepId: string;
  onSelect: (stepId: string) => void;
  onClose: () => void;
}

/** Chapter menu (SPEC §6). Opened from the progress bar or with Esc. */
export function ChapterMenu({
  chapters,
  currentStepId,
  onSelect,
  onClose,
}: ChapterMenuProps): React.ReactElement {
  return (
    <div className="dp-sheet" role="dialog" aria-modal="true" aria-label="Chapters">
      <div className="dp-sheet-panel">
        <header className="dp-sheet-header">
          <h2>Chapters</h2>
          <button type="button" className="dp-button dp-button--ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <ol className="dp-chapter-list">
          {chapters.map((chapter, index) => {
            const isCurrent = chapter.steps.includes(currentStepId);
            return (
              <li key={chapter.chapterId}>
                <button
                  type="button"
                  className={`dp-chapter${isCurrent ? ' is-current' : ''}`}
                  onClick={() => onSelect(chapter.steps[0]!)}
                >
                  <span className="dp-chapter-index">{index + 1}</span>
                  <span className="dp-chapter-title">{chapter.title}</span>
                  <span className="dp-chapter-steps">
                    {chapter.steps.length} step{chapter.steps.length === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
