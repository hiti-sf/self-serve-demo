import {
  DEFAULT_VIEWPORT,
  ManifestSchema,
  parseManifest,
  slugify,
  type CaptureMeta,
  type Chapter,
  type EndScreen,
  type Hotspot,
  type Manifest,
  type Settings,
  type Theme,
} from '@demo-platform/shared';

/**
 * The editor's working model (SPEC §7).
 *
 * Two deliberate differences from the manifest shape:
 *
 * 1. **Chapter membership lives on the step.** The manifest stores chapters as ordered
 *    lists of step ids, which makes drag-reordering and regrouping a two-place update
 *    that can go out of sync — and an orphaned or double-claimed step is a demo that
 *    silently never plays. Here the step order is the step order and each step names its
 *    chapter, so those states are unrepresentable.
 * 2. **Snapshots are held as strings.** Inline text editing is the payoff of DOM capture
 *    (§7), so the editor owns the HTML, not a file path.
 *
 * Everything in this module is pure: `toManifest` is the only place the two shapes meet,
 * and it validates on the way out.
 */

export interface EditorStep {
  stepId: string;
  /** The captured document, as edited. */
  snapshotHtml: string;
  /** Fallback image as a data: URL, decoded to a file on export. */
  fallbackImage: string;
  viewport: { width: number; height: number };
  hotspots: Hotspot[];
  notes?: string;
  chapterId: string;
  /** Kept from the import so the editor can offer anchor hints and show warnings. */
  captureMeta?: CaptureMeta;
  /** True once the author has edited the captured DOM. */
  textEdited?: boolean;
}

export interface EditorProject {
  demoId: string;
  product: string;
  title: string;
  description: string;
  theme: Theme;
  settings: Settings;
  chapters: { chapterId: string; title: string }[];
  steps: EditorStep[];
  endScreen: EndScreen;
  /** Extra files copied into the demo folder (logo, etc.), as data: URLs. */
  assets: { path: string; dataUrl: string }[];
}

export const DEFAULT_CHAPTER_ID = 'ch-01';

export function emptyProject(overrides: Partial<EditorProject> = {}): EditorProject {
  return {
    demoId: 'new-demo',
    product: 'InLumin',
    title: 'Untitled demo',
    description: '',
    theme: { primaryColor: '#20A676', accentColor: '#1B91A3' },
    settings: {
      gated: true,
      showProgress: true,
      showChapterMenu: true,
      keyboardNav: true,
      idleResetMs: 0,
    },
    chapters: [{ chapterId: DEFAULT_CHAPTER_ID, title: 'Chapter 1' }],
    steps: [],
    endScreen: {
      headline: 'See it on your own data',
      cta: { label: 'Book a walkthrough', url: 'https://pivotpath.example/walkthrough' },
    },
    assets: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------- actions

export type ProjectAction =
  | { type: 'project/meta'; patch: Partial<Pick<EditorProject, 'demoId' | 'product' | 'title' | 'description'>> }
  | { type: 'project/theme'; patch: Partial<Theme> }
  | { type: 'project/settings'; patch: Partial<Settings> }
  | { type: 'project/endScreen'; patch: Partial<EndScreen> }
  | { type: 'project/load'; project: EditorProject }
  | { type: 'step/add'; step: EditorStep; atIndex?: number }
  | { type: 'step/remove'; stepId: string }
  | { type: 'step/move'; stepId: string; toIndex: number }
  | { type: 'step/assignChapter'; stepId: string; chapterId: string }
  | { type: 'step/patch'; stepId: string; patch: Partial<Omit<EditorStep, 'stepId'>> }
  | { type: 'step/setSnapshot'; stepId: string; html: string; textEdited?: boolean }
  | { type: 'chapter/add'; title?: string }
  | { type: 'chapter/rename'; chapterId: string; title: string }
  | { type: 'chapter/remove'; chapterId: string }
  | { type: 'chapter/move'; chapterId: string; toIndex: number }
  | { type: 'hotspot/add'; stepId: string; hotspot: Hotspot }
  | { type: 'hotspot/patch'; stepId: string; hotspotId: string; patch: Partial<Hotspot> }
  | { type: 'hotspot/remove'; stepId: string; hotspotId: string }
  | { type: 'asset/add'; path: string; dataUrl: string };

function replaceStep(
  project: EditorProject,
  stepId: string,
  update: (step: EditorStep) => EditorStep,
): EditorProject {
  return {
    ...project,
    steps: project.steps.map((step) => (step.stepId === stepId ? update(step) : step)),
  };
}

function nextChapterId(project: EditorProject): string {
  for (let index = project.chapters.length + 1; index < 500; index += 1) {
    const candidate = `ch-${String(index).padStart(2, '0')}`;
    if (!project.chapters.some((chapter) => chapter.chapterId === candidate)) return candidate;
  }
  return `ch-${Date.now()}`;
}

export function nextStepId(project: EditorProject): string {
  for (let index = project.steps.length + 1; index < 5000; index += 1) {
    const candidate = `step-${String(index).padStart(2, '0')}`;
    if (!project.steps.some((step) => step.stepId === candidate)) return candidate;
  }
  return `step-${Date.now()}`;
}

export function nextHotspotId(step: EditorStep): string {
  for (let index = step.hotspots.length + 1; index < 500; index += 1) {
    const candidate = `hs-${String(index).padStart(2, '0')}`;
    if (!step.hotspots.some((hotspot) => hotspot.hotspotId === candidate)) return candidate;
  }
  return `hs-${Date.now()}`;
}

export function projectReducer(project: EditorProject, action: ProjectAction): EditorProject {
  switch (action.type) {
    case 'project/load':
      return action.project;

    case 'project/meta':
      return { ...project, ...action.patch };

    case 'project/theme':
      return { ...project, theme: { ...project.theme, ...action.patch } };

    case 'project/settings':
      return { ...project, settings: { ...project.settings, ...action.patch } };

    case 'project/endScreen':
      return { ...project, endScreen: { ...project.endScreen, ...action.patch } };

    case 'step/add': {
      const steps = [...project.steps];
      const at = action.atIndex ?? steps.length;
      steps.splice(Math.max(0, Math.min(at, steps.length)), 0, action.step);
      return { ...project, steps };
    }

    case 'step/remove': {
      const steps = project.steps.filter((step) => step.stepId !== action.stepId);
      // A hotspot pointing at a deleted step would fail manifest validation on export,
      // so drop the reference here rather than surfacing it as a mystery later.
      return {
        ...project,
        steps: steps.map((step) => ({
          ...step,
          hotspots: step.hotspots.map((hotspot) =>
            hotspot.advancesTo === action.stepId ? stripAdvancesTo(hotspot) : hotspot,
          ),
        })),
      };
    }

    case 'step/move': {
      const from = project.steps.findIndex((step) => step.stepId === action.stepId);
      if (from < 0) return project;
      const steps = [...project.steps];
      const [moved] = steps.splice(from, 1);
      if (!moved) return project;
      const to = Math.max(0, Math.min(action.toIndex, steps.length));
      steps.splice(to, 0, moved);
      return { ...project, steps };
    }

    case 'step/assignChapter':
      if (!project.chapters.some((chapter) => chapter.chapterId === action.chapterId)) return project;
      return replaceStep(project, action.stepId, (step) => ({ ...step, chapterId: action.chapterId }));

    case 'step/patch':
      return replaceStep(project, action.stepId, (step) => ({ ...step, ...action.patch }));

    case 'step/setSnapshot':
      return replaceStep(project, action.stepId, (step) => ({
        ...step,
        snapshotHtml: action.html,
        textEdited: action.textEdited ?? step.textEdited ?? true,
      }));

    case 'chapter/add': {
      const chapterId = nextChapterId(project);
      return {
        ...project,
        chapters: [
          ...project.chapters,
          { chapterId, title: action.title ?? `Chapter ${project.chapters.length + 1}` },
        ],
      };
    }

    case 'chapter/rename':
      return {
        ...project,
        chapters: project.chapters.map((chapter) =>
          chapter.chapterId === action.chapterId ? { ...chapter, title: action.title } : chapter,
        ),
      };

    case 'chapter/remove': {
      if (project.chapters.length <= 1) return project; // a demo needs at least one
      const remaining = project.chapters.filter((chapter) => chapter.chapterId !== action.chapterId);
      const fallback = remaining[0]!.chapterId;
      return {
        ...project,
        chapters: remaining,
        // Steps follow the chapter rather than disappearing with it.
        steps: project.steps.map((step) =>
          step.chapterId === action.chapterId ? { ...step, chapterId: fallback } : step,
        ),
      };
    }

    case 'chapter/move': {
      const from = project.chapters.findIndex((chapter) => chapter.chapterId === action.chapterId);
      if (from < 0) return project;
      const chapters = [...project.chapters];
      const [moved] = chapters.splice(from, 1);
      if (!moved) return project;
      chapters.splice(Math.max(0, Math.min(action.toIndex, chapters.length)), 0, moved);
      return { ...project, chapters };
    }

    case 'hotspot/add':
      return replaceStep(project, action.stepId, (step) => ({
        ...step,
        hotspots: [...step.hotspots, action.hotspot],
      }));

    case 'hotspot/patch':
      return replaceStep(project, action.stepId, (step) => ({
        ...step,
        hotspots: step.hotspots.map((hotspot) =>
          hotspot.hotspotId === action.hotspotId ? { ...hotspot, ...action.patch } : hotspot,
        ),
      }));

    case 'hotspot/remove':
      return replaceStep(project, action.stepId, (step) => ({
        ...step,
        hotspots: step.hotspots.filter((hotspot) => hotspot.hotspotId !== action.hotspotId),
      }));

    case 'asset/add':
      return {
        ...project,
        assets: [...project.assets.filter((asset) => asset.path !== action.path), { path: action.path, dataUrl: action.dataUrl }],
      };

    default:
      return project;
  }
}

function stripAdvancesTo(hotspot: Hotspot): Hotspot {
  const { advancesTo: _dropped, ...rest } = hotspot;
  return rest as Hotspot;
}

// ---------------------------------------------------------------- export

export function snapshotPath(stepId: string): string {
  return `snapshots/${stepId}.html`;
}

export function fallbackPath(stepId: string): string {
  return `snapshots/${stepId}.png`;
}

/**
 * Steps grouped into manifest chapters, in step order. A chapter with no steps is
 * dropped: it would fail validation, and an author who left an empty chapter behind
 * meant to delete it.
 */
export function toChapters(project: EditorProject): Chapter[] {
  return project.chapters
    .map((chapter) => ({
      chapterId: chapter.chapterId,
      title: chapter.title,
      steps: project.steps.filter((step) => step.chapterId === chapter.chapterId).map((step) => step.stepId),
    }))
    .filter((chapter) => chapter.steps.length > 0);
}

export interface ManifestResult {
  ok: true;
  manifest: Manifest;
}

export interface ManifestProblems {
  ok: false;
  issues: string[];
}

/**
 * Build and validate the manifest. The editor calls this on every render so the author
 * sees problems while authoring, not at publish time.
 */
export function toManifest(project: EditorProject): ManifestResult | ManifestProblems {
  const issues: string[] = [];
  if (project.steps.length === 0) issues.push('Add at least one step before publishing.');

  const chapters = toChapters(project);
  if (chapters.length === 0 && project.steps.length > 0) {
    issues.push('Every step is in a chapter that no longer exists.');
  }

  // Steps that are not in chapter order would play out of the order the author sees.
  const stepOrder = project.steps.map((step) => step.stepId);
  const chapterOrder = chapters.flatMap((chapter) => chapter.steps);
  if (stepOrder.join('|') !== chapterOrder.join('|')) {
    issues.push(
      'Steps are interleaved across chapters. Reorder them so each chapter\'s steps are consecutive.',
    );
  }

  for (const step of project.steps) {
    if (!step.snapshotHtml.trim()) issues.push(`${step.stepId}: the snapshot is empty.`);
    if (!step.fallbackImage) issues.push(`${step.stepId}: no fallback image was imported.`);
    for (const hotspot of step.hotspots) {
      if (!hotspot.anchor.selector.trim()) {
        issues.push(`${step.stepId}/${hotspot.hotspotId}: no element is selected.`);
      }
      if (!hotspot.tooltip.title.trim() && !hotspot.tooltip.body.trim()) {
        issues.push(`${step.stepId}/${hotspot.hotspotId}: the tooltip has no text.`);
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const candidate = {
    schemaVersion: '1.0',
    demoId: project.demoId,
    product: project.product,
    title: project.title,
    description: project.description,
    theme: project.theme,
    settings: project.settings,
    chapters,
    steps: project.steps.map((step) => ({
      stepId: step.stepId,
      snapshot: snapshotPath(step.stepId),
      fallbackImage: fallbackPath(step.stepId),
      viewport: step.viewport ?? DEFAULT_VIEWPORT,
      hotspots: step.hotspots,
      ...(step.notes ? { notes: step.notes } : {}),
    })),
    endScreen: project.endScreen,
  };

  try {
    return { ok: true, manifest: parseManifest(candidate, 'the demo you are editing') };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: detail.split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean) };
  }
}

/** Where `publish` writes the demo folder. */
export function demoFolder(project: EditorProject): string {
  return `demos/${slugify(project.product, 'product')}/${slugify(project.demoId, 'demo')}`;
}

/** Round-trip a published manifest back into an editable project. */
export function fromManifest(
  manifest: Manifest,
  files: { snapshots: Record<string, string>; fallbacks: Record<string, string> },
): EditorProject {
  const parsed = ManifestSchema.parse(manifest);
  const chapterOf = new Map<string, string>();
  for (const chapter of parsed.chapters) {
    for (const stepId of chapter.steps) chapterOf.set(stepId, chapter.chapterId);
  }

  // Manifest order is chapter order; keep it, so the editor list matches playback.
  const ordered = parsed.chapters.flatMap((chapter) =>
    chapter.steps.flatMap((stepId) => {
      const step = parsed.steps.find((candidate) => candidate.stepId === stepId);
      return step ? [step] : [];
    }),
  );

  return {
    demoId: parsed.demoId,
    product: parsed.product,
    title: parsed.title,
    description: parsed.description,
    theme: parsed.theme,
    settings: parsed.settings,
    chapters: parsed.chapters.map((chapter) => ({ chapterId: chapter.chapterId, title: chapter.title })),
    steps: ordered.map((step) => ({
      stepId: step.stepId,
      snapshotHtml: files.snapshots[step.snapshot] ?? '',
      fallbackImage: files.fallbacks[step.fallbackImage] ?? '',
      viewport: step.viewport ?? DEFAULT_VIEWPORT,
      hotspots: step.hotspots,
      ...(step.notes ? { notes: step.notes } : {}),
      chapterId: chapterOf.get(step.stepId) ?? parsed.chapters[0]!.chapterId,
    })),
    endScreen: parsed.endScreen,
    assets: [],
  };
}
