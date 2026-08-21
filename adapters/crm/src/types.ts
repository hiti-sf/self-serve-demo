import type { DemoEvent, LeadInput } from '@demo-platform/shared';

/**
 * CRM boundary (SPEC §10).
 *
 * Two methods, deliberately. Everything the platform needs from a CRM is "here is a
 * lead" and "here is something that lead did" — keeping the interface this small is what
 * makes a second CRM a day of work rather than a project.
 *
 * Implementations run **server-side only**. Credentials must never reach a client
 * bundle (§8.1, §11).
 */
export interface CrmAdapter {
  /** Human name, for logs and the health endpoint. */
  readonly name: string;
  createLead(lead: LeadInput): Promise<{ leadId: string }>;
  /** May batch internally (§10). */
  recordEvent(event: DemoEvent): Promise<void>;
  /** Push anything buffered. Called on shutdown and by the events route after a batch. */
  flush?(): Promise<void>;
}

export class CrmError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, { status, retryable = false }: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'CrmError';
    this.status = status;
    this.retryable = retryable;
  }
}

export type { DemoEvent, LeadInput };
