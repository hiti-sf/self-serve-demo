// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { assertScriptFree, sanitiseDocument } from '../src/lib/sanitise.js';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('sanitiseDocument', () => {
  it('removes script elements', () => {
    const doc = parse('<body><h1>Spend</h1><script>alert(1)</script></body>');
    const { stats } = sanitiseDocument(doc);
    expect(doc.querySelector('script')).toBeNull();
    expect(stats.strippedScripts).toBe(1);
    expect(doc.querySelector('h1')?.textContent).toBe('Spend');
  });

  it('removes inline event handlers', () => {
    const doc = parse('<body><button onclick="steal()" onmouseover="x()">Go</button></body>');
    const { stats } = sanitiseDocument(doc);
    const button = doc.querySelector('button')!;
    expect(button.hasAttribute('onclick')).toBe(false);
    expect(button.hasAttribute('onmouseover')).toBe(false);
    expect(stats.strippedEventHandlers).toBe(2);
  });

  it('neutralises javascript: URLs', () => {
    const doc = parse('<body><a id="a" href="javascript:alert(1)">x</a></body>');
    sanitiseDocument(doc);
    expect(doc.getElementById('a')?.getAttribute('href')).toBe('#');
  });

  it('strips scripts hidden inside declarative shadow DOM templates', () => {
    const doc = parse(
      '<body><div><template shadowrootmode="open"><script>evil()</script><p>inner</p></template></div></body>',
    );
    const { stats } = sanitiseDocument(doc);
    const template = doc.querySelector('template') as HTMLTemplateElement | null;
    expect(template).not.toBeNull();
    expect(template!.content.querySelector('script')).toBeNull();
    expect(template!.content.querySelector('p')?.textContent).toBe('inner');
    expect(stats.strippedScripts).toBe(1);
  });

  it('removes meta refresh so the snapshot cannot navigate away', () => {
    const doc = parse('<head><meta http-equiv="refresh" content="0;url=https://evil.test"></head>');
    sanitiseDocument(doc);
    expect(doc.querySelector('meta[http-equiv]')).toBeNull();
  });

  it('parks anchor targets but keeps them for the author', () => {
    const doc = parse('<body><a href="https://app.example/po/44">PO</a></body>');
    sanitiseDocument(doc);
    const anchor = doc.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('#');
    expect(anchor.getAttribute('data-demo-original-href')).toBe('https://app.example/po/44');
  });

  it('drops srcdoc that smuggles a document', () => {
    const doc = parse('<body><iframe srcdoc="<script>x()</script>"></iframe></body>');
    sanitiseDocument(doc);
    expect(doc.querySelector('iframe')?.hasAttribute('srcdoc')).toBe(false);
  });

  it('removes noscript, which is how rrweb represents a script tag', () => {
    const doc = parse('<body><noscript>enable js</noscript></body>');
    sanitiseDocument(doc);
    expect(doc.querySelector('noscript')).toBeNull();
  });
});

describe('assertScriptFree', () => {
  it('passes for a clean document', () => {
    expect(() => assertScriptFree('<!DOCTYPE html><html><body><p once=1>ok</p></body></html>')).not.toThrow();
  });

  it('fails on a script element', () => {
    expect(() => assertScriptFree('<html><body><script src="a.js"></script></body></html>')).toThrow(
      /not script-free/,
    );
  });

  it('fails on an inline handler', () => {
    expect(() => assertScriptFree('<html><body><div onclick="x()"></div></body></html>')).toThrow();
  });

  it('does not false-positive on body text that starts with "on"', () => {
    expect(() => assertScriptFree('<html><body>only=1 once=2</body></html>')).not.toThrow();
  });
});
