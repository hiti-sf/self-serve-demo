import { randomId } from '@demo-platform/shared';
import type { CrmAdapter, DemoEvent, LeadInput } from './types.js';

/**
 * Logs to stdout instead of calling a CRM (SPEC §10).
 *
 * This exists so that everything upstream of Milestone 4 — the gate form, the events
 * endpoint, the whole kiosk sync path — is testable and demoable without CRM
 * credentials, and so that the concrete CRM (still TBD, §10) can be dropped in later
 * without touching a single caller.
 */
export class ConsoleCrmAdapter implements CrmAdapter {
  readonly name = 'console';

  private readonly leads: (LeadInput & { leadId: string })[] = [];
  private readonly events: DemoEvent[] = [];

  constructor(private readonly log: (message: string, payload?: unknown) => void = defaultLog) {}

  async createLead(lead: LeadInput): Promise<{ leadId: string }> {
    const leadId = `lead_${randomId(14)}`;
    this.leads.push({ ...lead, leadId });
    this.log(`[crm:console] lead created ${leadId}`, {
      leadId,
      workEmail: lead.workEmail,
      company: lead.company,
      role: lead.role,
      productInterest: lead.productInterest,
      demoId: lead.demoId,
    });
    return { leadId };
  }

  async recordEvent(event: DemoEvent): Promise<void> {
    this.events.push(event);
    this.log(`[crm:console] ${event.name}`, {
      leadId: event.leadId ?? '(anonymous)',
      sessionId: event.sessionId,
      demoId: event.demoId,
      payload: event.payload,
    });
  }

  async flush(): Promise<void> {
    /* nothing buffered */
  }

  /** Inspection helpers for tests and for the dev server's debug view. */
  recordedLeads(): readonly (LeadInput & { leadId: string })[] {
    return this.leads;
  }

  recordedEvents(): readonly DemoEvent[] {
    return this.events;
  }
}

function defaultLog(message: string, payload?: unknown): void {
  if (payload === undefined) console.log(message);
  else console.log(message, JSON.stringify(payload));
}
