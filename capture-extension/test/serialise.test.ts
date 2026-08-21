// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_CSP,
  applyRedactions,
  scanDocumentForPii,
  serialiseDocument,
} from '../src/lib/serialise.js';
import { sanitiseDocument } from '../src/lib/sanitise.js';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const meta = {
  captureId: 'cap_abc',
  sourceUrl: 'https://app.example/requisitions',
  capturedAt: '2026-08-21T10:00:00.000Z',
  viewportWidth: 1440,
  viewportHeight: 900,
  documentWidth: 1440,
  documentHeight: 2100,
};

describe('serialiseDocument', () => {
  it('stamps provenance, a hard CSP and a doctype', () => {
    const doc = parse('<body><h1>Requisitions</h1></body>');
    const html = serialiseDocument(doc, meta);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain(SNAPSHOT_CSP);
    expect(html).toContain('data-demo-capture-id="cap_abc"');
    expect(html).toContain('data-demo-viewport="1440x900"');
    expect(html).toContain('data-demo-document="1440x2100"');
  });

  it('refuses to serialise a document that still contains script', () => {
    const doc = parse('<body><script>x()</script></body>');
    expect(() => serialiseDocument(doc, meta)).toThrow(/not script-free/);
  });

  it('serialises cleanly once sanitised', () => {
    const doc = parse('<body><button onclick="x()">Go</button><script>y()</script></body>');
    sanitiseDocument(doc);
    expect(() => serialiseDocument(doc, meta)).not.toThrow();
  });
});

describe('scanDocumentForPii', () => {
  it('finds PII in text, input values and placeholders', () => {
    const doc = parse(`
      <body>
        <p>Approver: k.mehta@acme-pharma.example</p>
        <input value="Patient ID PT-99311">
        <input placeholder="+44 20 7946 0958">
        <table><tr><td>REQ-1042</td><td>40 units</td></tr></table>
      </body>`);
    const findings = scanDocumentForPii(doc);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain('email');
    expect(kinds).toContain('patient-id');
    expect(kinds).toContain('phone');
    expect(findings.every((f) => f.context.length > 0)).toBe(true);
  });

  it('finds PII inside declarative shadow DOM', () => {
    const doc = parse(
      '<body><div><template shadowrootmode="open"><p>ops.lead@vendor.example</p></template></div></body>',
    );
    expect(scanDocumentForPii(doc).map((f) => f.kind)).toContain('email');
  });

  it('reports nothing for clean synthetic data', () => {
    const doc = parse('<body><p>Requisition REQ-1042 · 40 units · Strides Ltd</p></body>');
    expect(scanDocumentForPii(doc)).toEqual([]);
  });
});

describe('applyRedactions', () => {
  it('replaces selected values in text and attributes only', () => {
    const doc = parse(`
      <body>
        <p id="t">Contact k.mehta@acme-pharma.example about REQ-1042</p>
        <input id="i" value="k.mehta@acme-pharma.example" placeholder="ops@vendor.example">
      </body>`);
    const changed = applyRedactions(doc, ['k.mehta@acme-pharma.example']);
    expect(changed).toBeGreaterThan(0);
    expect(doc.getElementById('t')?.textContent).toContain('[redacted]');
    expect(doc.getElementById('t')?.textContent).toContain('REQ-1042');
    expect(doc.getElementById('i')?.getAttribute('value')).toBe('[redacted]');
    // Not selected, so left alone: redaction is the author's decision.
    expect(doc.getElementById('i')?.getAttribute('placeholder')).toBe('ops@vendor.example');
  });

  it('is a no-op with no selections', () => {
    const doc = parse('<body><p>a@b.example</p></body>');
    expect(applyRedactions(doc, [])).toBe(0);
  });
});
