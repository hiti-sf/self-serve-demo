import { z } from 'zod';

/**
 * Runtime configuration for a kiosk bundle (SPEC §8.2).
 *
 * Read from `kiosk-config.json` next to index.html so a sales engineer can point a
 * bundle at a different events endpoint without a rebuild. This file is the **only**
 * sanctioned place in the bundle for an external URL, and nothing is sent to it until
 * someone presses Sync or the machine comes back online.
 */

export const KioskConfigSchema = z
  .object({
    /**
     * Where queued events are flushed on sync. Empty means "queue only" — a bundle
     * handed to a partner can be built with no endpoint at all.
     */
    eventsEndpoint: z.string().max(2048).default(''),
    /** Attract loop: ms of idle before returning to the demo picker. 0 disables. */
    idleResetMs: z.number().int().min(0).max(3_600_000).default(120_000),
    /** Sync automatically when the browser reports it is back online. */
    autoSyncOnline: z.boolean().default(true),
    /** Shown on the picker so a booth machine can be identified in the event data. */
    kioskLabel: z.string().max(120).default(''),
    buildId: z.string().max(120).default(''),
  })
  .strict();

export type KioskConfig = z.infer<typeof KioskConfigSchema>;

export const DEFAULT_CONFIG: KioskConfig = KioskConfigSchema.parse({});

export async function loadKioskConfig(
  url = './kiosk-config.json',
  fetchImpl: typeof fetch = fetch,
): Promise<KioskConfig> {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return DEFAULT_CONFIG;
    const parsed = KioskConfigSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : DEFAULT_CONFIG;
  } catch {
    // A kiosk with no config file still has to run the demos.
    return DEFAULT_CONFIG;
  }
}

export const DemoIndexSchema = z
  .object({
    generatedFor: z.string().default('kiosk'),
    buildId: z.string().default(''),
    demos: z
      .array(
        z
          .object({
            demoId: z.string(),
            product: z.string(),
            title: z.string(),
            description: z.string().default(''),
            path: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type DemoIndex = z.infer<typeof DemoIndexSchema>;

export async function loadDemoIndex(
  url = './demos/index.json',
  fetchImpl: typeof fetch = fetch,
): Promise<DemoIndex> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`This bundle has no demo index (${response.status} from ${url}).`);
  return DemoIndexSchema.parse(await response.json());
}
