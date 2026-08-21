import { z } from 'zod';
import { SUPPORTED_SCHEMA_VERSION, assertSupportedSchemaVersion } from './schema-version.js';

/**
 * Demo manifest schema — the single source of truth (SPEC §4).
 *
 * Both the player and the editor validate against these schemas at load time.
 * Demos are data, not code: anything a new demo needs must be expressible here.
 */

const ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'ids may contain letters, digits, dot, dash, underscore');

/** Relative, forward-slash path inside the demo folder. No absolute or escaping paths. */
const RelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => !p.startsWith('/') && !p.includes('..') && !/^[a-zA-Z]+:/.test(p), {
    message: 'must be a relative path inside the demo folder (no leading /, no "..", no scheme)',
  });

const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected a hex colour, e.g. #20A676');

/** 0..1 fraction of the captured viewport. */
const Normalised = z.number().min(0).max(1);

export const ThemeSchema = z
  .object({
    primaryColor: HexColor.default('#20A676'),
    /** Optional secondary/gradient partner colour. Falls back to primaryColor. */
    accentColor: HexColor.optional(),
    logo: RelativePath.optional(),
    /** Rendered behind letterboxed snapshots. */
    backgroundColor: HexColor.optional(),
  })
  .strict();

export const SettingsSchema = z
  .object({
    /** Ignored by kiosk builds — gating is stripped at build time (§8.2). */
    gated: z.boolean().default(false),
    showProgress: z.boolean().default(true),
    showChapterMenu: z.boolean().default(true),
    keyboardNav: z.boolean().default(true),
    /** Kiosk attract loop: ms of idle before returning to the demo picker. 0 disables. */
    idleResetMs: z.number().int().min(0).max(3_600_000).default(0),
  })
  .strict();

export const AnchorSchema = z
  .object({
    selector: z.string().min(1).max(1024),
    strategy: z.literal('css').default('css'),
  })
  .strict();

export const AnchorFallbackSchema = z.object({ x: Normalised, y: Normalised }).strict();

export const TooltipSchema = z
  .object({
    title: z.string().max(160).default(''),
    body: z.string().max(2000).default(''),
    position: z.enum(['auto', 'top', 'bottom', 'left', 'right']).default('auto'),
  })
  .strict();

export const HotspotSchema = z
  .object({
    hotspotId: ID,
    anchor: AnchorSchema,
    /** Used when the selector does not resolve, or when the step fell back to an image. */
    anchorFallback: AnchorFallbackSchema,
    trigger: z.enum(['click', 'hover', 'auto']).default('click'),
    tooltip: TooltipSchema,
    /** stepId to advance to. Omit on a terminal hotspot (advances to the end screen). */
    advancesTo: ID.optional(),
    /** Auto-advance delay in ms. Only meaningful for trigger === 'auto'. */
    autoAdvanceMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict();

export const StepSchema = z
  .object({
    stepId: ID,
    /** Self-contained, script-free DOM capture. */
    snapshot: RelativePath,
    /** Mandatory per §4: the player swaps to this when a snapshot fails to render. */
    fallbackImage: RelativePath,
    /** Captured viewport, used to letterbox without reflow. Defaults to 1440x900. */
    viewport: z
      .object({ width: z.number().int().min(320).max(7680), height: z.number().int().min(320).max(4320) })
      .strict()
      .optional(),
    hotspots: z.array(HotspotSchema).default([]),
    /** Author note, never rendered to a prospect. */
    notes: z.string().max(2000).optional(),
  })
  .strict();

export const ChapterSchema = z
  .object({
    chapterId: ID,
    title: z.string().min(1).max(160),
    steps: z.array(ID).min(1),
  })
  .strict();

export const CtaSchema = z
  .object({
    label: z.string().min(1).max(120),
    url: z.string().min(1).max(2048),
  })
  .strict();

export const EndScreenSchema = z
  .object({
    headline: z.string().min(1).max(240),
    body: z.string().max(1000).optional(),
    cta: CtaSchema,
    secondaryCta: CtaSchema.optional(),
  })
  .strict();

/**
 * Reserved for v2 (§4). Declared so manifests carrying them validate and round-trip
 * through the editor unchanged, but the player must not read them.
 * DO NOT IMPLEMENT — see §13.
 */
export const ReservedV2Schema = z
  .object({
    /** v2: branching / choose-your-path. */
    branches: z.unknown().optional(),
    /** v2: personalisation tokens. */
    tokens: z.unknown().optional(),
    /** v2: A/B variant identity. */
    variant: z.unknown().optional(),
  })
  .partial();

export const ManifestSchema = ReservedV2Schema.extend({
  schemaVersion: z.string().regex(/^\d+\.\d+$/).default(SUPPORTED_SCHEMA_VERSION),
  demoId: ID,
  product: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  theme: ThemeSchema.default(() => ThemeSchema.parse({})),
  settings: SettingsSchema.default(() => SettingsSchema.parse({})),
  chapters: z.array(ChapterSchema).min(1),
  steps: z.array(StepSchema).min(1),
  endScreen: EndScreenSchema,
})
  .strict()
  .superRefine((manifest, ctx) => {
    const stepIds = new Set<string>();
    manifest.steps.forEach((step, i) => {
      if (stepIds.has(step.stepId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'stepId'],
          message: `duplicate stepId "${step.stepId}"`,
        });
      }
      stepIds.add(step.stepId);
    });

    const chapterIds = new Set<string>();
    manifest.chapters.forEach((chapter, i) => {
      if (chapterIds.has(chapter.chapterId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['chapters', i, 'chapterId'],
          message: `duplicate chapterId "${chapter.chapterId}"`,
        });
      }
      chapterIds.add(chapter.chapterId);

      chapter.steps.forEach((stepId, j) => {
        if (!stepIds.has(stepId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['chapters', i, 'steps', j],
            message: `chapter "${chapter.chapterId}" references unknown stepId "${stepId}"`,
          });
        }
      });
    });

    // Every step must be reachable from exactly one chapter: an orphan step is an
    // authoring slip that would silently never play.
    const claimed = new Map<string, string[]>();
    for (const chapter of manifest.chapters) {
      for (const stepId of chapter.steps) {
        claimed.set(stepId, [...(claimed.get(stepId) ?? []), chapter.chapterId]);
      }
    }
    manifest.steps.forEach((step, i) => {
      const owners = claimed.get(step.stepId) ?? [];
      if (owners.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'stepId'],
          message: `step "${step.stepId}" is not listed in any chapter`,
        });
      } else if (owners.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'stepId'],
          message: `step "${step.stepId}" appears in multiple chapters (${owners.join(', ')})`,
        });
      }
    });

    const hotspotIds = new Set<string>();
    manifest.steps.forEach((step, i) => {
      step.hotspots.forEach((hotspot, j) => {
        const key = `${step.stepId}/${hotspot.hotspotId}`;
        if (hotspotIds.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'hotspots', j, 'hotspotId'],
            message: `duplicate hotspotId "${hotspot.hotspotId}" within step "${step.stepId}"`,
          });
        }
        hotspotIds.add(key);

        if (hotspot.advancesTo && !stepIds.has(hotspot.advancesTo)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'hotspots', j, 'advancesTo'],
            message: `hotspot "${hotspot.hotspotId}" advances to unknown stepId "${hotspot.advancesTo}"`,
          });
        }
      });
    });
  });

export type Theme = z.infer<typeof ThemeSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type AnchorFallback = z.infer<typeof AnchorFallbackSchema>;
export type Tooltip = z.infer<typeof TooltipSchema>;
export type Hotspot = z.infer<typeof HotspotSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Chapter = z.infer<typeof ChapterSchema>;
export type Cta = z.infer<typeof CtaSchema>;
export type EndScreen = z.infer<typeof EndScreenSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export class ManifestValidationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[]) {
    super(`${message}\n  - ${issues.join('\n  - ')}`);
    this.name = 'ManifestValidationError';
    this.issues = issues;
  }
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

/**
 * Parse + validate a manifest. Checks the schema version BEFORE shape validation so
 * a future-version manifest reports "player too old" rather than a wall of unknown-key errors.
 */
export function parseManifest(input: unknown, source = 'manifest'): Manifest {
  if (input === null || typeof input !== 'object') {
    throw new ManifestValidationError(`Could not load ${source}`, ['expected a JSON object']);
  }
  const declared = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof declared === 'string') {
    assertSupportedSchemaVersion(declared);
  }

  const result = ManifestSchema.safeParse(input);
  if (!result.success) {
    throw new ManifestValidationError(`Invalid ${source}`, formatIssues(result.error));
  }
  return result.data;
}

export function safeParseManifest(
  input: unknown,
): { ok: true; manifest: Manifest } | { ok: false; issues: string[] } {
  try {
    return { ok: true, manifest: parseManifest(input) };
  } catch (error) {
    if (error instanceof ManifestValidationError) return { ok: false, issues: error.issues };
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Steps in chapter order — the canonical playback order. */
export function orderedStepIds(manifest: Manifest): string[] {
  return manifest.chapters.flatMap((chapter) => chapter.steps);
}

export function stepById(manifest: Manifest, stepId: string): Step | undefined {
  return manifest.steps.find((step) => step.stepId === stepId);
}

export function chapterForStep(manifest: Manifest, stepId: string): Chapter | undefined {
  return manifest.chapters.find((chapter) => chapter.steps.includes(stepId));
}

/**
 * Resolve the next step: an explicit `advancesTo` wins, otherwise fall through to
 * the next step in chapter order. Returns undefined at the end of the demo.
 */
export function nextStepId(manifest: Manifest, stepId: string, hotspotId?: string): string | undefined {
  const step = stepById(manifest, stepId);
  if (hotspotId && step) {
    const hotspot = step.hotspots.find((h) => h.hotspotId === hotspotId);
    if (hotspot?.advancesTo) return hotspot.advancesTo;
  }
  const order = orderedStepIds(manifest);
  const index = order.indexOf(stepId);
  if (index < 0) return undefined;
  return order[index + 1];
}

export function previousStepId(manifest: Manifest, stepId: string): string | undefined {
  const order = orderedStepIds(manifest);
  const index = order.indexOf(stepId);
  if (index <= 0) return undefined;
  return order[index - 1];
}

export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;

export function stepViewport(step: Step): { width: number; height: number } {
  return step.viewport ?? DEFAULT_VIEWPORT;
}
