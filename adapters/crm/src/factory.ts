import { BatchingCrmAdapter } from './batching.js';
import { ConsoleCrmAdapter } from './console.js';
import { WebhookCrmAdapter } from './webhook.js';
import type { CrmAdapter, DemoEvent } from './types.js';

/**
 * Build the adapter from the environment. Server-side only.
 *
 * CRM_ADAPTER=console (default) | webhook
 *   webhook needs CRM_LEAD_ENDPOINT, CRM_EVENT_ENDPOINT and usually CRM_TOKEN.
 *
 * Defaulting to `console` is deliberate: an unconfigured deployment logs leads loudly
 * rather than silently dropping them, and every environment upstream of the CRM
 * decision (§10) works out of the box.
 */
export interface CrmEnv {
  CRM_ADAPTER?: string;
  CRM_LEAD_ENDPOINT?: string;
  CRM_EVENT_ENDPOINT?: string;
  CRM_TOKEN?: string;
  CRM_AUTH_SCHEME?: string;
  CRM_LEAD_ID_PATH?: string;
  CRM_BATCH_SIZE?: string;
  CRM_FLUSH_INTERVAL_MS?: string;
}

export function createCrmAdapter(
  env: CrmEnv = process.env as CrmEnv,
  { onError }: { onError?: (error: unknown, dropped: DemoEvent[]) => void } = {},
): CrmAdapter {
  const kind = (env.CRM_ADAPTER ?? 'console').toLowerCase();

  const base: CrmAdapter = (() => {
    if (kind === 'webhook') {
      if (!env.CRM_LEAD_ENDPOINT || !env.CRM_EVENT_ENDPOINT) {
        throw new Error(
          'CRM_ADAPTER=webhook requires CRM_LEAD_ENDPOINT and CRM_EVENT_ENDPOINT.',
        );
      }
      return new WebhookCrmAdapter({
        leadEndpoint: env.CRM_LEAD_ENDPOINT,
        eventEndpoint: env.CRM_EVENT_ENDPOINT,
        token: env.CRM_TOKEN,
        authScheme: env.CRM_AUTH_SCHEME,
        leadIdPath: env.CRM_LEAD_ID_PATH,
      });
    }
    if (kind !== 'console') {
      // Fail loudly: a typo here would silently stop leads reaching the CRM.
      throw new Error(`Unknown CRM_ADAPTER "${env.CRM_ADAPTER}". Expected "console" or "webhook".`);
    }
    return new ConsoleCrmAdapter();
  })();

  return new BatchingCrmAdapter(base, {
    batchSize: env.CRM_BATCH_SIZE ? Number(env.CRM_BATCH_SIZE) : undefined,
    flushIntervalMs: env.CRM_FLUSH_INTERVAL_MS ? Number(env.CRM_FLUSH_INTERVAL_MS) : undefined,
    onError,
  });
}
