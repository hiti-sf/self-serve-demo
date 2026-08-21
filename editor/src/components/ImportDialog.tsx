import { useRef, useState } from 'react';
import { groupCaptureFiles, importCapture, type CaptureFiles } from '../state/import-capture.js';
import type { EditorStep } from '../state/project.js';

export interface ImportDialogProps {
  /** The validated step, ready for an id and a chapter. */
  onImported: (step: Omit<EditorStep, 'stepId' | 'chapterId'>, warnings: string[]) => void;
  onClose: () => void;
}

/**
 * Import a capture trio (SPEC §7).
 *
 * Accepts a whole folder drop, because that is what the extension writes: the author
 * should not have to pick three files in the right order.
 */
export function ImportDialog({ onImported, onClose }: ImportDialogProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function handleFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    setBusy(true);
    setErrors([]);

    try {
      const files = Array.from(fileList);
      const grouped = groupCaptureFiles(files.map((file) => file.name));

      const snapshotFile = files.find((file) => file.name === grouped.snapshot);
      const fallbackFile = files.find((file) => file.name === grouped.fallback);
      const metaFile = files.find((file) => file.name === grouped.meta);

      if (!snapshotFile) {
        setErrors(['No .html file in that selection. Pick the capture folder the extension wrote.']);
        return;
      }

      const captureFiles: CaptureFiles = {
        snapshotHtml: await snapshotFile.text(),
        fallbackImage: fallbackFile ? await readAsDataUrl(fallbackFile) : '',
        ...(metaFile ? { metaJson: await metaFile.text() } : {}),
      };

      const result = importCapture(captureFiles);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      onImported(result.step, result.warnings);
    } catch (error) {
      setErrors([error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Import a capture">
      <div className="modal-panel">
        <header className="modal-header">
          <h2>Import a capture</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div
          className="dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void handleFiles(event.dataTransfer?.files ?? null);
          }}
          onClick={() => inputRef.current?.click()}
          data-testid="import-dropzone"
        >
          <p>
            <strong>Drop a capture folder here</strong>
          </p>
          <p className="hint">
            The three files the extension wrote: <code>snapshot.html</code>,{' '}
            <code>fallback.png</code> and <code>capture-meta.json</code>.
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => void handleFiles(event.target.files)}
          />
        </div>

        {busy ? <p className="hint">Reading files…</p> : null}

        {errors.length > 0 ? (
          <ul className="errors" role="alert">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
