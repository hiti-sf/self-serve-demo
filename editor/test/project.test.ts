import { describe, expect, it } from 'vitest';
import type { Hotspot } from '@demo-platform/shared';
import {
  DEFAULT_CHAPTER_ID,
  emptyProject,
  fromManifest,
  nextHotspotId,
  nextStepId,
  projectReducer,
  toChapters,
  toManifest,
  type EditorProject,
  type EditorStep,
} from '../src/state/project.js';

const SNAPSHOT = '<!DOCTYPE html><html><body><button id="save">Save</button></body></html>';
const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

function step(stepId: string, chapterId = DEFAULT_CHAPTER_ID, hotspots: Hotspot[] = []): EditorStep {
  return {
    stepId,
    chapterId,
    snapshotHtml: SNAPSHOT,
    fallbackImage: IMAGE,
    viewport: { width: 1440, height: 900 },
    hotspots,
  };
}

function hotspot(hotspotId: string, overrides: Partial<Hotspot> = {}): Hotspot {
  return {
    hotspotId,
    anchor: { selector: '#save', strategy: 'css' },
    anchorFallback: { x: 0.5, y: 0.5 },
    trigger: 'click',
    tooltip: { title: 'Save it', body: 'Commit the change.', position: 'auto' },
    ...overrides,
  } as Hotspot;
}

function withSteps(count: number): EditorProject {
  let project = emptyProject();
  for (let index = 1; index <= count; index += 1) {
    project = projectReducer(project, {
      type: 'step/add',
      step: step(`step-0${index}`, DEFAULT_CHAPTER_ID, [hotspot('hs-01')]),
    });
  }
  return project;
}

describe('step ordering and chapter grouping', () => {
  it('appends imported steps in order', () => {
    const project = withSteps(3);
    expect(project.steps.map((s) => s.stepId)).toEqual(['step-01', 'step-02', 'step-03']);
  });

  it('moves a step to a new position', () => {
    const project = projectReducer(withSteps(3), { type: 'step/move', stepId: 'step-03', toIndex: 0 });
    expect(project.steps.map((s) => s.stepId)).toEqual(['step-03', 'step-01', 'step-02']);
  });

  it('ignores a move for an unknown step', () => {
    const before = withSteps(2);
    expect(projectReducer(before, { type: 'step/move', stepId: 'ghost', toIndex: 0 })).toBe(before);
  });

  it('clamps an out-of-range move instead of losing the step', () => {
    const project = projectReducer(withSteps(3), { type: 'step/move', stepId: 'step-01', toIndex: 99 });
    expect(project.steps.map((s) => s.stepId)).toEqual(['step-02', 'step-03', 'step-01']);
  });

  it('assigns a step to another chapter', () => {
    let project = projectReducer(withSteps(2), { type: 'chapter/add', title: 'Approve' });
    const second = project.chapters[1]!.chapterId;
    project = projectReducer(project, { type: 'step/assignChapter', stepId: 'step-02', chapterId: second });
    expect(project.steps[1]?.chapterId).toBe(second);
    expect(toChapters(project)).toEqual([
      { chapterId: DEFAULT_CHAPTER_ID, title: 'Chapter 1', steps: ['step-01'] },
      { chapterId: second, title: 'Approve', steps: ['step-02'] },
    ]);
  });

  it('refuses to assign a step to a chapter that does not exist', () => {
    const before = withSteps(1);
    expect(projectReducer(before, { type: 'step/assignChapter', stepId: 'step-01', chapterId: 'ch-99' })).toBe(
      before,
    );
  });

  it('keeps steps when their chapter is deleted', () => {
    let project = projectReducer(withSteps(2), { type: 'chapter/add', title: 'Approve' });
    const second = project.chapters[1]!.chapterId;
    project = projectReducer(project, { type: 'step/assignChapter', stepId: 'step-02', chapterId: second });
    project = projectReducer(project, { type: 'chapter/remove', chapterId: second });

    expect(project.chapters).toHaveLength(1);
    expect(project.steps).toHaveLength(2);
    expect(project.steps.every((s) => s.chapterId === DEFAULT_CHAPTER_ID)).toBe(true);
  });

  it('never deletes the last chapter', () => {
    const before = withSteps(1);
    expect(projectReducer(before, { type: 'chapter/remove', chapterId: DEFAULT_CHAPTER_ID })).toBe(before);
  });

  it('drops dangling advancesTo references when a step is deleted', () => {
    let project = withSteps(2);
    project = projectReducer(project, {
      type: 'hotspot/patch',
      stepId: 'step-01',
      hotspotId: 'hs-01',
      patch: { advancesTo: 'step-02' },
    });
    project = projectReducer(project, { type: 'step/remove', stepId: 'step-02' });

    expect(project.steps).toHaveLength(1);
    expect(project.steps[0]?.hotspots[0]?.advancesTo).toBeUndefined();
  });
});

describe('hotspots', () => {
  it('adds, patches and removes', () => {
    let project = withSteps(1);
    project = projectReducer(project, { type: 'hotspot/add', stepId: 'step-01', hotspot: hotspot('hs-02') });
    expect(project.steps[0]?.hotspots).toHaveLength(2);

    project = projectReducer(project, {
      type: 'hotspot/patch',
      stepId: 'step-01',
      hotspotId: 'hs-02',
      patch: { tooltip: { title: 'New', body: 'Body', position: 'top' } },
    });
    expect(project.steps[0]?.hotspots[1]?.tooltip.title).toBe('New');

    project = projectReducer(project, { type: 'hotspot/remove', stepId: 'step-01', hotspotId: 'hs-01' });
    expect(project.steps[0]?.hotspots.map((h) => h.hotspotId)).toEqual(['hs-02']);
  });

  it('generates ids that do not collide', () => {
    const project = withSteps(1);
    expect(nextHotspotId(project.steps[0]!)).toBe('hs-02');
    expect(nextStepId(project)).toBe('step-02');
  });
});

describe('toManifest', () => {
  it('produces a valid manifest from a complete project', () => {
    const result = toManifest(withSteps(2));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.chapters).toEqual([
        { chapterId: DEFAULT_CHAPTER_ID, title: 'Chapter 1', steps: ['step-01', 'step-02'] },
      ]);
      expect(result.manifest.steps[0]?.snapshot).toBe('snapshots/step-01.html');
      expect(result.manifest.steps[0]?.fallbackImage).toBe('snapshots/step-01.png');
      expect(result.manifest.schemaVersion).toBe('1.0');
    }
  });

  it('refuses an empty project', () => {
    const result = toManifest(emptyProject());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toContain('at least one step');
  });

  it('refuses a hotspot with no tooltip text', () => {
    let project = withSteps(1);
    project = projectReducer(project, {
      type: 'hotspot/patch',
      stepId: 'step-01',
      hotspotId: 'hs-01',
      patch: { tooltip: { title: '', body: '', position: 'auto' } },
    });
    const result = toManifest(project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('tooltip has no text');
  });

  it('refuses a step with no fallback image', () => {
    let project = withSteps(1);
    project = projectReducer(project, { type: 'step/patch', stepId: 'step-01', patch: { fallbackImage: '' } });
    const result = toManifest(project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('no fallback image');
  });

  it('catches steps interleaved across chapters, which would play out of order', () => {
    let project = withSteps(3);
    project = projectReducer(project, { type: 'chapter/add', title: 'Second' });
    const second = project.chapters[1]!.chapterId;
    // step-02 in chapter two, step-03 back in chapter one: the list order and the
    // chapter order now disagree.
    project = projectReducer(project, { type: 'step/assignChapter', stepId: 'step-02', chapterId: second });

    const result = toManifest(project);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toContain('interleaved');
  });

  it('drops an empty chapter rather than failing validation on it', () => {
    const project = projectReducer(withSteps(1), { type: 'chapter/add', title: 'Unused' });
    const result = toManifest(project);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.chapters).toHaveLength(1);
  });

  it('surfaces schema errors from the shared validator', () => {
    const project = projectReducer(withSteps(1), { type: 'project/meta', patch: { demoId: 'not a valid id!' } });
    const result = toManifest(project);
    expect(result.ok).toBe(false);
  });
});

describe('round trip', () => {
  it('rebuilds an editable project from a published manifest', () => {
    let project = withSteps(2);
    project = projectReducer(project, { type: 'chapter/add', title: 'Approve' });
    const second = project.chapters[1]!.chapterId;
    project = projectReducer(project, { type: 'step/assignChapter', stepId: 'step-02', chapterId: second });

    const built = toManifest(project);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const restored = fromManifest(built.manifest, {
      snapshots: { 'snapshots/step-01.html': SNAPSHOT, 'snapshots/step-02.html': SNAPSHOT },
      fallbacks: { 'snapshots/step-01.png': IMAGE, 'snapshots/step-02.png': IMAGE },
    });

    expect(restored.steps.map((s) => s.stepId)).toEqual(['step-01', 'step-02']);
    expect(restored.steps[1]?.chapterId).toBe(second);
    expect(restored.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Approve']);

    // …and the round trip is stable.
    const rebuilt = toManifest(restored);
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) expect(rebuilt.manifest).toEqual(built.manifest);
  });
});
