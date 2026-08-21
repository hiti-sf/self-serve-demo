export type { CrmAdapter, DemoEvent, LeadInput } from './types.js';
export { CrmError } from './types.js';
export { ConsoleCrmAdapter } from './console.js';
export { WebhookCrmAdapter } from './webhook.js';
export type { WebhookCrmOptions } from './webhook.js';
export {
  BatchingCrmAdapter,
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
} from './batching.js';
export type { BatchingOptions } from './batching.js';
export { createCrmAdapter } from './factory.js';
export type { CrmEnv } from './factory.js';
