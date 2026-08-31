import { describe, expect, it } from 'vitest';
import { hasPii, redactMatches, redactText, scanText } from '../src/pii.js';

describe('PII scanning', () => {
  it('finds email addresses', () => {
    const findings = scanText('Contact a.singh@acme-pharma.example for the PO.');
    expect(findings.map((f) => f.kind)).toContain('email');
  });

  it('finds phone numbers but not order quantities', () => {
    expect(hasPii('Call +91 98450 12345 to confirm')).toBe(true);
    expect(scanText('Quantity 250 units').filter((f) => f.kind === 'phone')).toHaveLength(0);
  });

  it('finds patient and case identifiers', () => {
    expect(scanText('Patient ID PT-88213 reviewed').map((f) => f.kind)).toContain('patient-id');
    expect(scanText('Case No. AER-2291-B closed').map((f) => f.kind)).toContain('case-id');
  });

  it('does not double-report overlapping matches', () => {
    const findings = scanText('Case 4111-1111-1111-1111');
    const spans = findings.map((f) => `${f.start}-${f.end}`);
    expect(new Set(spans).size).toBe(spans.length);
  });

  it('leaves clean synthetic copy alone', () => {
    expect(hasPii('Requisition REQ-1042 for 40 units of nitrile gloves')).toBe(false);
  });

  it('redacts everything it finds', () => {
    const redacted = redactText('Email a@b.example or call +44 20 7946 0958');
    expect(redacted).not.toContain('a@b.example');
    expect(redacted).toContain('[redacted]');
  });

  it('redacts only the matches the author selected', () => {
    const text = 'Email a@b.example or ops@c.example';
    const redacted = redactMatches(text, ['a@b.example']);
    expect(redacted).toContain('ops@c.example');
    expect(redacted).not.toContain('a@b.example');
  });
});
