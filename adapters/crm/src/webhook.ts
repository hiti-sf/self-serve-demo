import { CrmError, type CrmAdapter, type DemoEvent, type LeadInput } from './types.js';

/**
 * Generic webhook/REST adapter (SPEC §10).
 *
 * The concrete CRM is still TBD — §10 says "confirm with owner before Milestone 4" — so
 * this covers the shape every candidate shares: authenticated POST for a lead, POST for
 * events, and a configurable path to the id in the response. When the CRM is chosen,
 * either configure this or subclass it; nothing upstream changes either way.
 *
 * Server-side only. The token is read from the environment and never crosses to a client
 * bundle (§8.1, §11).
 */

export interface WebhookCrmOptions {
  /** e.g. https://crm.example/api/v1/leads */
  leadEndpoint: string;
  /** e.g. https://crm.example/api/v1/demo-events — accepts a batch. */
  eventEndpoint: string;
  /** Sent as `Authorization: <authScheme> <token>` when present. */
  token?: string;
  authScheme?: string;
  /** Extra headers, e.g. a tenant id. */
  headers?: Record<string, string>;
  /**
   * Dotted path to the lead id in the response body, e.g. "data.id".
   * Defaults to trying leadId → id → data.id.
   */
  leadIdPath?: string;
  /** Reshape the payload for a CRM with its own field names. */
  mapLead?: (lead: LeadInput) => unknown;
  mapEvent?: (event: DemoEvent) => unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Retries for 429/5xx, with exponential backoff. */
  maxRetries?: number;
  name?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

export class WebhookCrmAdapter implements CrmAdapter {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WebhookCrmOptions) {
    this.name = options.name ?? 'webhook';
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  async createLead(lead: LeadInput): Promise<{ leadId: string }> {
    const body = this.options.mapLead ? this.options.mapLead(lead) : defaultLeadPayload(lead);
    const response = await this.post(this.options.leadEndpoint, body);
    const parsed = (await safeJson(response)) as Record<string, unknown> | null;

    const leadId = this.extractLeadId(parsed);
    if (!leadId) {
      throw new CrmError(
        `CRM accepted the lead but no id was found in the response${
          this.options.leadIdPath ? ` at "${this.options.leadIdPath}"` : ''
        }`,
        { status: response.status },
      );
    }
    return { leadId };
  }

  async recordEvent(event: DemoEvent): Promise<void> {
    const body = this.options.mapEvent ? this.options.mapEvent(event) : event;
    await this.post(this.options.eventEndpoint, { events: [body] });
  }

  /** Batch entry point used by BatchingCrmAdapter — one request per batch (§10). */
  async recordEvents(events: DemoEvent[]): Promise<void> {
    if (events.length === 0) return;
    const mapped = this.options.mapEvent ? events.map(this.options.mapEvent) : events;
    await this.post(this.options.eventEndpoint, { events: mapped });
  }

  private extractLeadId(body: Record<string, unknown> | null): string | undefined {
    if (!body) return undefined;
    const paths = this.options.leadIdPath
      ? [this.options.leadIdPath]
      : ['leadId', 'id', 'data.id', 'data.leadId', 'result.id'];
    for (const path of paths) {
      const value = path.split('.').reduce<unknown>((node, key) => {
        if (node && typeof node === 'object') return (node as Record<string, unknown>)[key];
        return undefined;
      }, body);
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'number') return String(value);
    }
    return undefined;
  }

  private async post(url: string, body: unknown): Promise<Response> {
    const maxRetries = this.options.maxRetries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        await delay(200 * 2 ** (attempt - 1));
      }
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });

        if (response.ok) return response;

        const retryable = response.status === 429 || response.status >= 500;
        const error = new CrmError(`CRM returned ${response.status} for ${url}`, {
          status: response.status,
          retryable,
        });
        if (!retryable) throw error;
        lastError = error;
      } catch (error) {
        // A timeout or a socket error is worth retrying; a CrmError we already
        // classified is not.
        if (error instanceof CrmError && !error.retryable) throw error;
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new CrmError(`CRM request to ${url} failed`, { retryable: true });
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.options.headers,
    };
    if (this.options.token) {
      headers.authorization = `${this.options.authScheme ?? 'Bearer'} ${this.options.token}`;
    }
    return headers;
  }
}

function defaultLeadPayload(lead: LeadInput): Record<string, unknown> {
  return {
    name: lead.name,
    email: lead.workEmail,
    company: lead.company,
    jobTitle: lead.role,
    productInterest: lead.productInterest,
    source: 'interactive-demo',
    demoId: lead.demoId,
    sessionId: lead.sessionId,
    consent: lead.consent,
    referrer: lead.referrer,
    ...(lead.utm ? { utm: lead.utm } : {}),
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
