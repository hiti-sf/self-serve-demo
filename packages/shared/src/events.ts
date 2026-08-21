import { z } from 'zod';

/**
 * Analytics event taxonomy (SPEC §9). Defined once, consumed by the player,
 * the kiosk queue, the web events endpoint and the CRM adapter.
 *
 * Envelope: { eventId, sessionId, demoId, leadId?, timestamp, payload }
 */

export const EVENT_NAMES = [
  'demo_started',
  'step_viewed',
  'step_completed',
  'chapter_completed',
  'demo_completed',
  'cta_clicked',
  'gate_submitted',
  'session_abandoned',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** Whitelist used by the events endpoint (§11) — anything else is rejected, not stored. */
export const EVENT_NAME_SET: ReadonlySet<string> = new Set(EVENT_NAMES);

export const EntrySourceSchema = z.enum(['web', 'kiosk', 'editor-preview']);
export type EntrySource = z.infer<typeof EntrySourceSchema>;

const DwellMs = z.number().int().min(0).max(86_400_000);

export const EventPayloadSchemas = {
  demo_started: z
    .object({
      entrySource: EntrySourceSchema,
      referrer: z.string().max(2048).default(''),
    })
    .strict(),
  step_viewed: z.object({ stepId: z.string().max(128), chapterId: z.string().max(128) }).strict(),
  step_completed: z.object({ stepId: z.string().max(128), dwellMs: DwellMs }).strict(),
  chapter_completed: z.object({ chapterId: z.string().max(128) }).strict(),
  demo_completed: z.object({ totalMs: DwellMs }).strict(),
  cta_clicked: z.object({ ctaLabel: z.string().max(200), url: z.string().max(2048) }).strict(),
  gate_submitted: z.object({ leadId: z.string().max(200) }).strict(),
  session_abandoned: z
    .object({
      lastStepId: z.string().max(128),
      dwellMs: DwellMs,
      /** How the abandonment was determined; drop-off analysis is the primary output (§9). */
      derivedFrom: z.enum(['client-unload', 'session-timeout', 'kiosk-idle-reset']),
    })
    .strict(),
} as const;

const envelopeBase = {
  eventId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  demoId: z.string().min(1).max(128),
  leadId: z.string().min(1).max(200).optional(),
  /** ISO-8601. Kiosk events are queued offline, so this can lag the server clock by days. */
  timestamp: z.string().datetime({ offset: true }),
};

export const DemoEventSchema = z.discriminatedUnion(
  'name',
  EVENT_NAMES.map((name) =>
    z
      .object({
        ...envelopeBase,
        name: z.literal(name),
        payload: EventPayloadSchemas[name],
      })
      .strict(),
  ) as unknown as [z.ZodObject<z.ZodRawShape>, ...z.ZodObject<z.ZodRawShape>[]],
);

export type DemoEvent = {
  [N in EventName]: {
    eventId: string;
    sessionId: string;
    demoId: string;
    leadId?: string;
    timestamp: string;
    name: N;
    payload: z.infer<(typeof EventPayloadSchemas)[N]>;
  };
}[EventName];

export type EventPayload<N extends EventName> = z.infer<(typeof EventPayloadSchemas)[N]>;

export const DemoEventBatchSchema = z.array(DemoEventSchema).min(1).max(500);

export function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && EVENT_NAME_SET.has(value);
}

export function parseDemoEvent(input: unknown): DemoEvent {
  return DemoEventSchema.parse(input) as unknown as DemoEvent;
}

export function safeParseDemoEvent(
  input: unknown,
): { ok: true; event: DemoEvent } | { ok: false; issues: string[] } {
  // Reject unknown names before the union runs, so the operator gets
  // "unknown event name" rather than a discriminator dump.
  const name = (input as { name?: unknown } | null)?.name;
  if (!isEventName(name)) {
    return { ok: false, issues: [`unknown event name ${JSON.stringify(name)}`] };
  }
  const result = DemoEventSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  return { ok: true, event: result.data as unknown as DemoEvent };
}
