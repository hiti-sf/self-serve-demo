// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { flattenShadowRoots } from '../src/lib/shadow.js';
import { sanitiseDocument } from '../src/lib/sanitise.js';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** jsdom parses declarative shadow DOM only on request, so build the roots by hand. */
function attach(host: Element, html: string): ShadowRoot {
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = html;
  return root;
}

describe('flattenShadowRoots', () => {
  it('moves shadow content into a declarative template so outerHTML carries it', () => {
    const doc = parse('<body><my-badge id="b"></my-badge></body>');
    attach(doc.getElementById('b')!, '<span class="pill">Qualified</span>');

    // The bug this pass exists for: without it, the host serialises empty.
    expect(doc.body.innerHTML).not.toContain('Qualified');

    const { flattened } = flattenShadowRoots(doc);

    expect(flattened).toBe(1);
    const template = doc.querySelector('my-badge > template') as HTMLTemplateElement;
    expect(template.getAttribute('shadowrootmode')).toBe('open');
    expect(template.content.querySelector('.pill')?.textContent).toBe('Qualified');
    expect(doc.body.innerHTML).toContain('Qualified');
  });

  it('carries the pre-standard attribute too, for older kiosk browsers', () => {
    const doc = parse('<body><my-badge id="b"></my-badge></body>');
    attach(doc.getElementById('b')!, '<b>x</b>');
    flattenShadowRoots(doc);
    expect(doc.querySelector('template')?.getAttribute('shadowroot')).toBe('open');
  });

  it('flattens nested shadow roots from the inside out', () => {
    const doc = parse('<body><outer-card id="o"></outer-card></body>');
    const outer = attach(doc.getElementById('o')!, '<inner-chip id="i"></inner-chip>');
    attach(outer.querySelector('#i')!, '<em>deep</em>');

    const { flattened } = flattenShadowRoots(doc);

    expect(flattened).toBe(2);
    const outerTemplate = doc.querySelector('outer-card > template') as HTMLTemplateElement;
    const innerTemplate = outerTemplate.content.querySelector('inner-chip > template') as HTMLTemplateElement;
    expect(innerTemplate.content.querySelector('em')?.textContent).toBe('deep');
  });

  it('keeps the template first so slotted light DOM still follows it', () => {
    const doc = parse('<body><my-card id="c"><p>slotted</p></my-card></body>');
    attach(doc.getElementById('c')!, '<slot></slot>');
    flattenShadowRoots(doc);

    const host = doc.getElementById('c')!;
    expect(host.firstElementChild?.tagName).toBe('TEMPLATE');
    expect(host.lastElementChild?.textContent).toBe('slotted');
  });

  it('leaves a document without shadow roots untouched and warns about nothing', () => {
    const doc = parse('<body><p>plain</p></body>');
    const { flattened, warnings } = flattenShadowRoots(doc);
    expect(flattened).toBe(0);
    expect(warnings).toHaveLength(0);
  });

  it('hands shadow content to the sanitiser, so a script inside a component still dies', () => {
    const doc = parse('<body><my-badge id="b"></my-badge></body>');
    attach(doc.getElementById('b')!, '<span onclick="steal()">hi</span><script>alert(1)</script>');

    flattenShadowRoots(doc);
    const { stats } = sanitiseDocument(doc);

    expect(stats.strippedScripts).toBe(1);
    expect(doc.documentElement.outerHTML).not.toContain('onclick');
    expect(doc.documentElement.outerHTML).not.toContain('alert(1)');
  });
});
