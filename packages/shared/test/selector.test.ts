// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { computeSelector, isLikelyGeneratedId, resolveSelector } from '../src/selector.js';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe('computeSelector', () => {
  beforeEach(() => setBody(''));

  it('prefers a stable data attribute', () => {
    setBody('<div><button data-testid="save-po" id="mui-4821x9f3">Save</button></div>');
    const el = document.querySelector('button')!;
    const result = computeSelector(el);
    expect(result.selector).toBe('[data-testid="save-po"]');
    expect(result.strength).toBe('attribute');
    expect(result.unique).toBe(true);
  });

  it('uses an authored id when there is no data attribute', () => {
    setBody('<button id="new-requisition">New</button>');
    const result = computeSelector(document.querySelector('button')!);
    expect(result.selector).toBe('#new-requisition');
    expect(result.strength).toBe('id');
  });

  it('ignores framework-generated ids in favour of a structural path', () => {
    setBody('<main><section><button id="radix-:r3:">Go</button></section></main>');
    const result = computeSelector(document.querySelector('button')!);
    expect(result.selector).not.toContain('radix');
    expect(result.strength).toBe('structural');
    expect(document.querySelectorAll(result.selector)).toHaveLength(1);
  });

  it('falls back to aria-label before going structural', () => {
    setBody('<div><a aria-label="Export spend report" href="#">Export</a></div>');
    const result = computeSelector(document.querySelector('a')!);
    expect(result.selector).toBe('a[aria-label="Export spend report"]');
  });

  it('disambiguates repeated siblings with nth-of-type', () => {
    setBody('<ul><li><span>a</span></li><li><span>b</span></li><li><span>c</span></li></ul>');
    const target = document.querySelectorAll('li')[2]!.querySelector('span')!;
    const result = computeSelector(target);
    expect(document.querySelectorAll(result.selector)).toHaveLength(1);
    expect(document.querySelector(result.selector)).toBe(target);
  });

  it('produces a selector that resolves inside a table row', () => {
    setBody(`
      <table id="po-table">
        <tbody>
          <tr><td>REQ-1041</td><td><button class="approve">Approve</button></td></tr>
          <tr><td>REQ-1042</td><td><button class="approve">Approve</button></td></tr>
        </tbody>
      </table>`);
    const target = document.querySelectorAll('tr')[1]!.querySelector('button')!;
    const result = computeSelector(target);
    expect(resolveSelector(document, result.selector)).toBe(target);
  });
});

describe('isLikelyGeneratedId', () => {
  it('flags hashes, counters and framework prefixes', () => {
    expect(isLikelyGeneratedId('mui-48219a3f')).toBe(true);
    expect(isLikelyGeneratedId('item-129843')).toBe(true);
    expect(isLikelyGeneratedId('el1234')).toBe(true);
    expect(isLikelyGeneratedId('radix-x')).toBe(true);
  });

  it('accepts authored ids', () => {
    expect(isLikelyGeneratedId('new-requisition')).toBe(false);
    expect(isLikelyGeneratedId('spend_summary')).toBe(false);
  });
});

describe('resolveSelector', () => {
  it('returns null for a selector that no longer matches', () => {
    setBody('<div id="a"></div>');
    expect(resolveSelector(document, '#gone')).toBeNull();
  });

  it('returns null rather than throwing on an invalid selector', () => {
    setBody('<div id="a"></div>');
    expect(resolveSelector(document, '###')).toBeNull();
  });

  it('finds an element inside an open shadow root', () => {
    setBody('<div id="host"></div>');
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button data-testid="inner">Inner</button>';
    const found = resolveSelector(document, '[data-testid="inner"]');
    expect(found).toBe(shadow.querySelector('button'));
  });
});
