// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { describeElement, elementLabel, hotspotFromPick, startPicker } from '../src/lib/anchor-picker.js';
import {
  replaceEverywhere,
  scanEditedText,
  serialiseForExport,
  startTextEditing,
} from '../src/lib/text-edit.js';
import { buildDemoFiles, decodeDataUrl } from '../src/lib/export.js';
import { importCapture, groupCaptureFiles } from '../src/state/import-capture.js';
import { emptyProject, projectReducer, type EditorProject } from '../src/state/project.js';

const CAPTURED = { width: 1440, height: 900 };
const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

const SNAPSHOT = `<!DOCTYPE html>
<html data-demo-viewport="1440x900" data-demo-capture-id="cap_1">
<head><meta charset="utf-8"></head>
<body>
  <header><h1>Requisitions</h1></header>
  <table id="reqs">
    <tr><td>REQ-1042</td><td><button data-testid="approve-1042">Approve</button></td></tr>
    <tr><td>REQ-1041</td><td><button data-testid="approve-1041">Approve</button></td></tr>
  </table>
  <p id="customer">Strides Pharma</p>
</body></html>`;

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function stub(element: Element, rect: { x: number; y: number; width: number; height: number }): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('visual hotspot placement', () => {
  it('records the selector and the normalised coordinates together', () => {
    const doc = parse(SNAPSHOT);
    const button = doc.querySelector('[data-testid="approve-1042"]')!;
    stub(button, { x: 720, y: 450, width: 100, height: 36 });

    const pick = describeElement(button, CAPTURED)!;
    expect(pick.selector).toBe('[data-testid="approve-1042"]');
    expect(pick.strength).toBe('attribute');
    // Centre of the element as a fraction of the captured document.
    expect(pick.fallback.x).toBeCloseTo((720 + 50) / 1440, 4);
    expect(pick.fallback.y).toBeCloseTo((450 + 18) / 900, 4);
  });

  it('clamps coordinates for an element that overhangs the capture', () => {
    const doc = parse(SNAPSHOT);
    const button = doc.querySelector('[data-testid="approve-1041"]')!;
    stub(button, { x: 1430, y: 890, width: 200, height: 200 });
    const pick = describeElement(button, CAPTURED)!;
    expect(pick.fallback.x).toBeLessThanOrEqual(1);
    expect(pick.fallback.y).toBeLessThanOrEqual(1);
  });

  it('refuses to anchor to the document or body', () => {
    const doc = parse(SNAPSHOT);
    expect(describeElement(doc.documentElement, CAPTURED)).toBeNull();
    expect(describeElement(doc.body, CAPTURED)).toBeNull();
  });

  it('seeds the tooltip title from the element the author clicked', () => {
    const doc = parse(SNAPSHOT);
    const button = doc.querySelector('[data-testid="approve-1042"]')!;
    stub(button, { x: 0, y: 0, width: 10, height: 10 });
    const created = hotspotFromPick('hs-01', describeElement(button, CAPTURED)!);
    expect(created.tooltip.title).toBe('Approve');
    expect(created.trigger).toBe('click');
    expect(created.anchor.strategy).toBe('css');
  });

  it('labels an element by its accessible name first', () => {
    const doc = parse('<body><button aria-label="Approve REQ-1042">Approve</button></body>');
    expect(elementLabel(doc.querySelector('button')!)).toBe('Approve REQ-1042');
  });

  it('picks on click and leaves no trace when stopped', () => {
    const doc = parse(SNAPSHOT);
    const button = doc.querySelector('[data-testid="approve-1042"]')! as HTMLElement;
    stub(button, { x: 10, y: 10, width: 50, height: 20 });

    const picks: string[] = [];
    const picker = startPicker(doc, CAPTURED, (pick) => picks.push(pick.selector));

    expect(doc.querySelectorAll('[data-editor-only]')).toHaveLength(1);
    // A document from DOMParser has no defaultView, so use the ambient constructors.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picks).toEqual(['[data-testid="approve-1042"]']);

    picker.stop();
    expect(doc.querySelectorAll('[data-editor-only]')).toHaveLength(0);
    // A document from DOMParser has no defaultView, so use the ambient constructors.
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picks).toHaveLength(1);
  });
});

describe('inline text editing', () => {
  it('makes leaf text elements editable and reverts cleanly', () => {
    const doc = parse(SNAPSHOT);
    const handle = startTextEditing(doc, () => {});

    expect(doc.querySelector('#customer')?.getAttribute('contenteditable')).toBe('true');
    // A container with element children is not made editable: that is how captured
    // layout gets broken.
    expect(doc.querySelector('table')?.hasAttribute('contenteditable')).toBe(false);

    handle.stop();
    expect(doc.querySelectorAll('[contenteditable]')).toHaveLength(0);
    expect(doc.querySelectorAll('[data-editor-only]')).toHaveLength(0);
  });

  it('reports changes as the author types', () => {
    const doc = parse(SNAPSHOT);
    const onChange = vi.fn();
    const handle = startTextEditing(doc, onChange);

    const customer = doc.querySelector('#customer')!;
    customer.textContent = 'Acme Excipients';
    customer.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalled();
    handle.stop();
  });

  it('exports the edit without any editor artefacts', () => {
    const doc = parse(SNAPSHOT);
    const handle = startTextEditing(doc, () => {});
    doc.querySelector('#customer')!.textContent = 'Acme Excipients';

    const html = serialiseForExport(doc);
    handle.stop();

    expect(html).toContain('Acme Excipients');
    expect(html).not.toContain('contenteditable');
    expect(html).not.toContain('data-editor-only');
    expect(html).not.toContain('data-editor-editable');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    // Provenance survives the edit.
    expect(html).toContain('data-demo-capture-id="cap_1"');
  });

  it('refuses to export a document that has gained a script', () => {
    const doc = parse(SNAPSHOT);
    const script = doc.createElement('script');
    script.textContent = 'alert(1)';
    doc.body.append(script);
    expect(() => serialiseForExport(doc)).toThrow(/not script-free/);
  });

  it('renames a customer everywhere at once', () => {
    const doc = parse(
      '<body><p>Strides Pharma</p><table><tr><td>Strides Pharma</td></tr></table><input value="Strides Pharma"></body>',
    );
    const changed = replaceEverywhere(doc, 'Strides Pharma', 'Northwind Labs');
    expect(changed).toBe(3);
    expect(doc.body.innerHTML).not.toContain('Strides Pharma');
    expect(doc.querySelector('input')?.getAttribute('value')).toBe('Northwind Labs');
  });

  it('flags personal data an author types into a demo', () => {
    const doc = parse('<body><p id="c">Contact k.mehta@acme-pharma.example</p></body>');
    const findings = scanEditedText(doc);
    expect(findings.map((f) => f.kind)).toContain('email');
  });
});

describe('capture import', () => {
  it('imports the trio and reads the viewport from the capture meta', () => {
    const meta = JSON.stringify({
      captureId: 'cap_1',
      url: 'https://inlumin.demo.internal/requisitions',
      title: 'Requisitions',
      timestamp: '2026-08-14T09:32:11.000Z',
      viewport: {
        width: 1600,
        height: 1000,
        devicePixelRatio: 2,
        documentWidth: 1600,
        documentHeight: 2400,
      },
      stats: {
        snapshotBytes: 100,
        embeddedResources: 4,
        strippedScripts: 3,
        strippedEventHandlers: 2,
        rasterisedCanvases: 1,
        serialisedShadowRoots: 0,
        durationMs: 1200,
      },
      sanitised: true,
    });

    const result = importCapture({ snapshotHtml: SNAPSHOT, fallbackImage: IMAGE, metaJson: meta });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.step.viewport).toEqual({ width: 1600, height: 1000 });
    expect(result.step.captureMeta?.stats.embeddedResources).toBe(4);
    expect(result.warnings).toEqual([]);
  });

  it('falls back to the viewport stamped on the document', () => {
    const result = importCapture({ snapshotHtml: SNAPSHOT, fallbackImage: IMAGE });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.step.viewport).toEqual({ width: 1440, height: 900 });
  });

  it('refuses a capture with no fallback image', () => {
    const result = importCapture({ snapshotHtml: SNAPSHOT, fallbackImage: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('fallback.png is missing');
  });

  it('refuses a snapshot containing a script', () => {
    const result = importCapture({
      snapshotHtml: '<html><body><script>steal()</script></body></html>',
      fallbackImage: IMAGE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('not script-free');
  });

  it('warns when the author skipped the PII review', () => {
    const meta = JSON.stringify({
      captureId: 'cap_2',
      url: 'https://x.example/',
      timestamp: '2026-08-14T09:32:11.000Z',
      viewport: { width: 1440, height: 900, documentWidth: 1440, documentHeight: 900 },
      stats: {
        snapshotBytes: 1,
        embeddedResources: 0,
        strippedScripts: 0,
        strippedEventHandlers: 0,
        rasterisedCanvases: 0,
        serialisedShadowRoots: 0,
        durationMs: 1,
      },
      sanitised: false,
      warnings: [{ kind: 'pii-detected', detail: '2 possible values' }],
    });
    const result = importCapture({ snapshotHtml: SNAPSHOT, fallbackImage: IMAGE, metaJson: meta });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.join(' ')).toContain('PII review');
      expect(result.warnings.join(' ')).toContain('2 possible values');
    }
  });

  it('sorts a folder drop into the trio', () => {
    expect(groupCaptureFiles(['capture-meta.json', 'fallback.png', 'snapshot.html'])).toEqual({
      snapshot: 'snapshot.html',
      fallback: 'fallback.png',
      meta: 'capture-meta.json',
    });
  });
});

describe('export', () => {
  function projectWithStep(): EditorProject {
    return projectReducer(emptyProject(), {
      type: 'step/add',
      step: {
        stepId: 'step-01',
        chapterId: 'ch-01',
        snapshotHtml: SNAPSHOT,
        fallbackImage: IMAGE,
        viewport: { width: 1440, height: 900 },
        hotspots: [
          {
            hotspotId: 'hs-01',
            anchor: { selector: '[data-testid="approve-1042"]', strategy: 'css' },
            anchorFallback: { x: 0.5, y: 0.5 },
            trigger: 'click',
            tooltip: { title: 'Approve', body: 'One click.', position: 'auto' },
          },
        ],
      },
    });
  }

  it('produces exactly the demo folder the player loads', () => {
    const built = buildDemoFiles(projectWithStep());
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.files.map((file) => file.path).sort()).toEqual([
      'manifest.json',
      'snapshots/step-01.html',
      'snapshots/step-01.png',
    ]);

    const manifest = JSON.parse(built.files.find((f) => f.path === 'manifest.json')!.text!);
    expect(manifest.steps[0].snapshot).toBe('snapshots/step-01.html');
    expect(manifest.schemaVersion).toBe('1.0');
    expect(built.files.find((f) => f.path.endsWith('.png'))?.base64).toBeTruthy();
  });

  it('refuses to export an invalid project', () => {
    const built = buildDemoFiles(emptyProject());
    expect(built.ok).toBe(false);
  });

  it('refuses to export a snapshot that gained a script', () => {
    const project = projectReducer(projectWithStep(), {
      type: 'step/setSnapshot',
      stepId: 'step-01',
      html: '<html><body><div onclick="x()">hi</div></body></html>',
    });
    const built = buildDemoFiles(project);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.issues.join(' ')).toContain('not script-free');
  });

  it('decodes both base64 and percent-encoded data URLs', () => {
    expect(decodeDataUrl(IMAGE)?.contentType).toBe('image/png');
    const text = decodeDataUrl('data:text/plain,hello%20world');
    expect(text && atob(text.base64)).toBe('hello world');
    expect(decodeDataUrl('not-a-data-url')).toBeNull();
  });
});
