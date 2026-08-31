import { useMemo } from 'react';
import { ConsoleTransport, DemoPlayer } from '@demo-platform/player';
import type { Manifest } from '@demo-platform/shared';
import { fallbackPath, snapshotPath, type EditorProject } from '../state/project.js';

export interface PreviewModalProps {
  project: EditorProject;
  manifest: Manifest;
  startStepId?: string;
  onClose: () => void;
}

/**
 * Live preview using the actual player component (SPEC §7 — "import it, never a
 * re-implementation").
 *
 * The only difference from production is where the files come from: the player resolves
 * manifest-relative paths, and here those resolve to blob URLs made from the in-memory
 * project, so an author previews unsaved edits.
 */
export function PreviewModal({ project, manifest, startStepId, onClose }: PreviewModalProps): React.ReactElement {
  const transport = useMemo(() => new ConsoleTransport(), []);

  const { resolve, revoke } = useMemo(() => {
    const urls = new Map<string, string>();

    for (const step of project.steps) {
      urls.set(
        snapshotPath(step.stepId),
        URL.createObjectURL(new Blob([step.snapshotHtml], { type: 'text/html' })),
      );
      // The fallback image is already a data: URL, which the player can use directly.
      urls.set(fallbackPath(step.stepId), step.fallbackImage);
    }
    for (const asset of project.assets) urls.set(asset.path, asset.dataUrl);

    return {
      resolve: (path: string) => urls.get(path) ?? path,
      revoke: () => {
        for (const url of urls.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      },
    };
  }, [project.assets, project.steps]);

  return (
    <div className="preview" role="dialog" aria-modal="true" aria-label="Demo preview">
      <header className="preview-bar">
        <span>
          Preview · <strong>{manifest.title}</strong> · gating and analytics are stubbed
        </span>
        <button
          type="button"
          className="btn btn--outline btn--sm"
          onClick={() => {
            revoke();
            onClose();
          }}
        >
          Close preview
        </button>
      </header>
      <div className="preview-stage">
        <DemoPlayer
          manifest={manifest}
          resolve={resolve}
          transport={transport}
          entrySource="editor-preview"
          analyticsEnabled
          {...(startStepId ? { initialStepId: startStepId } : {})}
        />
      </div>
    </div>
  );
}
