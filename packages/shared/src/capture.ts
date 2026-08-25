import { z } from 'zod';

/**
 * The capture trio the extension emits and the editor imports (SPEC §5):
 *   snapshot.html + fallback.png + capture-meta.json
 */

export const CAPTURE_META_VERSION = '1.0';

export const CaptureWarningSchema = z
  .object({
    kind: z.enum([
      'cross-origin-iframe',
      'cross-origin-stylesheet',
      'canvas-rasterised',
      'webgl-rasterised',
      'video-poster',
      'shadow-root-closed',
      'shadow-dom-flattened',
      'resource-fetch-failed',
      'resource-too-large',
      'pii-detected',
      'pii-redacted',
    ]),
    detail: z.string().max(2000),
    /** Selector of the element the warning concerns, when applicable. */
    selector: z.string().max(1024).optional(),
  })
  .strict();

export type CaptureWarning = z.infer<typeof CaptureWarningSchema>;

export const CaptureMetaSchema = z
  .object({
    metaVersion: z.string().default(CAPTURE_META_VERSION),
    captureId: z.string().min(1).max(128),
    /** Page the snapshot was taken from. Kept for provenance and re-capture. */
    url: z.string().max(2048),
    title: z.string().max(500).default(''),
    timestamp: z.string(),
    viewport: z
      .object({
        width: z.number().int().min(1),
        height: z.number().int().min(1),
        devicePixelRatio: z.number().min(0.1).max(8).default(1),
        /** Full scrollable document size — the fallback PNG covers this. */
        documentWidth: z.number().int().min(1),
        documentHeight: z.number().int().min(1),
        scrollX: z.number().int().default(0),
        scrollY: z.number().int().default(0),
      })
      .strict(),
    /** What the serialiser produced, for editor display and debugging. */
    stats: z
      .object({
        snapshotBytes: z.number().int().min(0),
        embeddedResources: z.number().int().min(0),
        strippedScripts: z.number().int().min(0),
        strippedEventHandlers: z.number().int().min(0),
        rasterisedCanvases: z.number().int().min(0),
        serialisedShadowRoots: z.number().int().min(0),
        durationMs: z.number().min(0),
      })
      .strict(),
    warnings: z.array(CaptureWarningSchema).default([]),
    /** Selectors the extension pre-computed for clickable elements, as editor hints. */
    anchorHints: z
      .array(
        z
          .object({
            selector: z.string().max(1024),
            strength: z.enum(['attribute', 'id', 'text', 'structural']),
            label: z.string().max(200),
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
          })
          .strict(),
      )
      .default([]),
    /** True once the author has run and accepted the PII pass. */
    sanitised: z.boolean().default(false),
    /** Extension version, so a bad capture batch can be traced to a build. */
    capturedBy: z.string().max(120).default('capture-extension'),
  })
  .strict();

export type CaptureMeta = z.infer<typeof CaptureMetaSchema>;

export function parseCaptureMeta(input: unknown): CaptureMeta {
  return CaptureMetaSchema.parse(input);
}

export function safeParseCaptureMeta(
  input: unknown,
): { ok: true; meta: CaptureMeta } | { ok: false; issues: string[] } {
  const result = CaptureMetaSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, meta: result.data };
}

export const CAPTURE_FILE_NAMES = {
  snapshot: 'snapshot.html',
  fallback: 'fallback.png',
  meta: 'capture-meta.json',
} as const;
