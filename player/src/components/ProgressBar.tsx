export interface ProgressBarProps {
  currentIndex: number;
  total: number;
  chapterTitle: string;
  onOpenChapters?: () => void;
}

/** Progress bar and step counter (SPEC §6). */
export function ProgressBar({
  currentIndex,
  total,
  chapterTitle,
  onOpenChapters,
}: ProgressBarProps): React.ReactElement {
  const percent = total > 0 ? Math.round(((currentIndex + 1) / total) * 100) : 0;
  return (
    <div className="dp-progress">
      <div className="dp-progress-meta">
        {onOpenChapters ? (
          <button type="button" className="dp-button dp-button--chip" onClick={onOpenChapters}>
            {chapterTitle}
          </button>
        ) : (
          <span className="dp-progress-chapter">{chapterTitle}</span>
        )}
        <span className="dp-progress-count">
          Step {Math.min(currentIndex + 1, total)} of {total}
        </span>
      </div>
      <div
        className="dp-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Demo progress"
      >
        <div className="dp-progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
