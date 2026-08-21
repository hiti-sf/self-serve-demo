import { describe, expect, it } from 'vitest';
import {
  ManifestValidationError,
  nextStepId,
  orderedStepIds,
  parseManifest,
  previousStepId,
  safeParseManifest,
} from '../src/manifest.js';
import { SchemaVersionError, assertSupportedSchemaVersion } from '../src/schema-version.js';

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    demoId: 'inlumin-flow-01',
    product: 'InLumin',
    title: 'Requisition to approved PO',
    description: 'Synthetic demo data.',
    theme: { primaryColor: '#20A676' },
    settings: { gated: true },
    chapters: [
      { chapterId: 'ch-01', title: 'Raise a requisition', steps: ['step-01', 'step-02'] },
      { chapterId: 'ch-02', title: 'Approve', steps: ['step-03'] },
    ],
    steps: [
      {
        stepId: 'step-01',
        snapshot: 'snapshots/step-01.html',
        fallbackImage: 'snapshots/step-01.png',
        hotspots: [
          {
            hotspotId: 'hs-01',
            anchor: { selector: '#new-requisition', strategy: 'css' },
            anchorFallback: { x: 0.72, y: 0.31 },
            trigger: 'click',
            tooltip: { title: 'Start here', body: 'Raise a requisition.', position: 'auto' },
            advancesTo: 'step-02',
          },
        ],
      },
      { stepId: 'step-02', snapshot: 's/2.html', fallbackImage: 's/2.png', hotspots: [] },
      { stepId: 'step-03', snapshot: 's/3.html', fallbackImage: 's/3.png', hotspots: [] },
    ],
    endScreen: {
      headline: 'See it on your own spend data',
      cta: { label: 'Book a walkthrough', url: 'https://example.com/book' },
    },
    ...overrides,
  };
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest and applies defaults', () => {
    const manifest = parseManifest(baseManifest());
    expect(manifest.demoId).toBe('inlumin-flow-01');
    expect(manifest.settings.showProgress).toBe(true);
    expect(manifest.settings.keyboardNav).toBe(true);
    expect(manifest.steps[1]?.hotspots).toEqual([]);
  });

  it('rejects a chapter referencing an unknown step', () => {
    const bad = baseManifest({
      chapters: [{ chapterId: 'ch-01', title: 'x', steps: ['step-01', 'nope'] }],
    });
    expect(() => parseManifest(bad)).toThrow(ManifestValidationError);
    const result = safeParseManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join('\n')).toContain('unknown stepId "nope"');
    }
  });

  it('rejects an orphan step that no chapter plays', () => {
    const bad = baseManifest({
      chapters: [{ chapterId: 'ch-01', title: 'x', steps: ['step-01'] }],
    });
    const result = safeParseManifest(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('not listed in any chapter');
  });

  it('rejects a hotspot advancing to an unknown step', () => {
    const manifest = baseManifest();
    (manifest.steps[0] as { hotspots: { advancesTo: string }[] }).hotspots[0]!.advancesTo = 'ghost';
    const result = safeParseManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('unknown stepId "ghost"');
  });

  it('rejects duplicate step ids', () => {
    const manifest = baseManifest();
    (manifest.steps as { stepId: string }[])[2]!.stepId = 'step-02';
    const result = safeParseManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('duplicate stepId');
  });

  it('rejects snapshot paths that escape the demo folder', () => {
    const manifest = baseManifest();
    (manifest.steps as { snapshot: string }[])[0]!.snapshot = '../../etc/passwd';
    const result = safeParseManifest(manifest);
    expect(result.ok).toBe(false);
  });

  it('refuses a manifest from a newer major schema version', () => {
    expect(() => parseManifest(baseManifest({ schemaVersion: '2.0' }))).toThrow(SchemaVersionError);
  });

  it('accepts a newer minor schema version', () => {
    expect(() => parseManifest(baseManifest({ schemaVersion: '1.4' }))).not.toThrow();
  });

  it('round-trips reserved v2 fields without implementing them', () => {
    const manifest = parseManifest(
      baseManifest({ branches: [{ id: 'b1' }], tokens: { company: 'Acme' }, variant: 'A' }),
    );
    expect(manifest.branches).toEqual([{ id: 'b1' }]);
    expect(manifest.tokens).toEqual({ company: 'Acme' });
    expect(manifest.variant).toBe('A');
  });

  it('rejects unknown top-level keys so typos surface at authoring time', () => {
    const result = safeParseManifest(baseManifest({ setttings: {} }));
    expect(result.ok).toBe(false);
  });
});

describe('navigation helpers', () => {
  const manifest = parseManifest(baseManifest());

  it('orders steps by chapter', () => {
    expect(orderedStepIds(manifest)).toEqual(['step-01', 'step-02', 'step-03']);
  });

  it('prefers an explicit advancesTo over chapter order', () => {
    expect(nextStepId(manifest, 'step-01', 'hs-01')).toBe('step-02');
  });

  it('falls through to chapter order across a chapter boundary', () => {
    expect(nextStepId(manifest, 'step-02')).toBe('step-03');
  });

  it('returns undefined at the end of the demo', () => {
    expect(nextStepId(manifest, 'step-03')).toBeUndefined();
    expect(previousStepId(manifest, 'step-01')).toBeUndefined();
  });
});

describe('assertSupportedSchemaVersion', () => {
  it('rejects malformed versions', () => {
    expect(() => assertSupportedSchemaVersion('one')).toThrow(SchemaVersionError);
  });

  it('names both versions in the error so the operator knows what to update', () => {
    try {
      assertSupportedSchemaVersion('9.0');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('9.0');
      expect((error as Error).message).toContain('1.0');
    }
  });
});
