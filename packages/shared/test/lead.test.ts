import { describe, expect, it } from 'vitest';
import { validateLeadInput, validateWorkEmail } from '../src/lead.js';

const valid = {
  name: 'Priya Raman',
  workEmail: 'priya.raman@strides.example',
  company: 'Strides',
  role: 'Head of Procurement',
  productInterest: 'InLumin',
  consent: true as const,
  demoId: 'inlumin-flow-01',
  sessionId: 'ses_1',
};

describe('validateWorkEmail', () => {
  it('accepts a corporate address', () => {
    const result = validateWorkEmail('Priya.Raman@Strides.example');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.email).toBe('priya.raman@strides.example');
  });

  it('rejects free-mail domains', () => {
    expect(validateWorkEmail('someone@gmail.com')).toMatchObject({ ok: false, reason: 'freemail' });
    expect(validateWorkEmail('someone@mailinator.com')).toMatchObject({ ok: false, reason: 'freemail' });
  });

  it('rejects malformed addresses', () => {
    expect(validateWorkEmail('not-an-email')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(validateWorkEmail('a@b')).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('honours a custom blocklist', () => {
    expect(validateWorkEmail('a@partner.test', ['partner.test'])).toMatchObject({ ok: false });
    expect(validateWorkEmail('a@gmail.com', ['partner.test'])).toMatchObject({ ok: true });
  });
});

describe('validateLeadInput', () => {
  it('accepts a complete submission', () => {
    const result = validateLeadInput(valid);
    expect(result.ok).toBe(true);
  });

  it('requires consent before anything is recorded', () => {
    const result = validateLeadInput({ ...valid, consent: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.consent).toContain('privacy notice');
  });

  it('surfaces a per-field error for a free-mail address', () => {
    const result = validateLeadInput({ ...valid, workEmail: 'x@gmail.com' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.workEmail).toContain('work email');
  });

  it('rejects unexpected fields', () => {
    const result = validateLeadInput({ ...valid, isAdmin: true });
    expect(result.ok).toBe(false);
  });
});
