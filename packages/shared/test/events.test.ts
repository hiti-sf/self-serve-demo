import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, isEventName, safeParseDemoEvent } from '../src/events.js';

const envelope = {
  eventId: 'evt_1',
  sessionId: 'ses_1',
  demoId: 'inlumin-flow-01',
  timestamp: '2026-08-21T10:00:00.000Z',
};

describe('event taxonomy', () => {
  it('defines exactly the events in the spec', () => {
    expect([...EVENT_NAMES]).toEqual([
      'demo_started',
      'step_viewed',
      'step_completed',
      'chapter_completed',
      'demo_completed',
      'cta_clicked',
      'gate_submitted',
      'session_abandoned',
    ]);
  });

  it('accepts a valid step_viewed event', () => {
    const result = safeParseDemoEvent({
      ...envelope,
      name: 'step_viewed',
      payload: { stepId: 'step-01', chapterId: 'ch-01' },
    });
    expect(result.ok).toBe(true);
  });

  it('carries leadId when present', () => {
    const result = safeParseDemoEvent({
      ...envelope,
      leadId: 'lead_123',
      name: 'gate_submitted',
      payload: { leadId: 'lead_123' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.leadId).toBe('lead_123');
  });

  it('rejects an event name outside the whitelist', () => {
    const result = safeParseDemoEvent({ ...envelope, name: 'drop_table', payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toContain('unknown event name');
    expect(isEventName('drop_table')).toBe(false);
  });

  it('rejects a payload that does not match its event', () => {
    const result = safeParseDemoEvent({ ...envelope, name: 'step_completed', payload: { stepId: 'a' } });
    expect(result.ok).toBe(false);
  });

  it('rejects extra payload keys', () => {
    const result = safeParseDemoEvent({
      ...envelope,
      name: 'chapter_completed',
      payload: { chapterId: 'ch-01', injected: true },
    });
    expect(result.ok).toBe(false);
  });

  it('requires session_abandoned to record how it was derived', () => {
    const missing = safeParseDemoEvent({
      ...envelope,
      name: 'session_abandoned',
      payload: { lastStepId: 'step-02', dwellMs: 4000 },
    });
    expect(missing.ok).toBe(false);

    const present = safeParseDemoEvent({
      ...envelope,
      name: 'session_abandoned',
      payload: { lastStepId: 'step-02', dwellMs: 4000, derivedFrom: 'session-timeout' },
    });
    expect(present.ok).toBe(true);
  });

  it('rejects a non-ISO timestamp', () => {
    const result = safeParseDemoEvent({
      ...envelope,
      timestamp: 'yesterday',
      name: 'demo_completed',
      payload: { totalMs: 1000 },
    });
    expect(result.ok).toBe(false);
  });
});
