import { describe, expect, it } from 'vitest';
import {
  extractCssUrls,
  findExternalUrlsInHtml,
  isExternalUrl,
  parseSrcset,
  rewriteCssUrls,
  serialiseSrcset,
  stripCssImports,
} from '../src/lib/urls.js';

describe('isExternalUrl', () => {
  it('treats data, blob and fragment references as self-contained', () => {
    expect(isExternalUrl('data:image/png;base64,AAA')).toBe(false);
    expect(isExternalUrl('blob:https://x/y')).toBe(false);
    expect(isExternalUrl('#main')).toBe(false);
    expect(isExternalUrl('')).toBe(false);
  });

  it('treats http, protocol-relative and path references as external', () => {
    expect(isExternalUrl('https://cdn.example/a.png')).toBe(true);
    expect(isExternalUrl('//cdn.example/a.png')).toBe(true);
    expect(isExternalUrl('/static/a.png')).toBe(true);
  });
});

describe('css url handling', () => {
  const css = `
    @import url("https://fonts.example/reset.css");
    .a { background: url('images/bg.png') no-repeat; }
    @font-face { src: url("https://cdn.example/f.woff2") format("woff2"); }
    .b { background-image: url(data:image/gif;base64,AAA); }
  `;

  it('extracts external url() references and resolves them', () => {
    const refs = extractCssUrls(css, 'https://app.example/assets/main.css');
    const raws = refs.map((r) => r.raw);
    expect(raws).toContain('images/bg.png');
    expect(raws).toContain('https://cdn.example/f.woff2');
    expect(raws).not.toContain('data:image/gif;base64,AAA');
    const bg = refs.find((r) => r.raw === 'images/bg.png');
    expect(bg?.absolute).toBe('https://app.example/assets/images/bg.png');
  });

  it('rewrites known urls and neutralises the rest', () => {
    const replacements = new Map([['images/bg.png', 'data:image/png;base64,BBB']]);
    const out = rewriteCssUrls(css, replacements);
    expect(out).toContain('url("data:image/png;base64,BBB")');
    // The font we could not embed must not stay as a network reference.
    expect(out).not.toContain('cdn.example/f.woff2');
    expect(out).toContain('url("")');
    // Already-inline references are untouched.
    expect(out).toContain('url(data:image/gif;base64,AAA)');
  });

  it('strips @import rules', () => {
    expect(stripCssImports(css)).not.toContain('@import');
  });
});

describe('srcset', () => {
  it('round-trips', () => {
    const parsed = parseSrcset('a.png 1x, b.png 2x, c.png 400w');
    expect(parsed).toHaveLength(3);
    expect(serialiseSrcset(parsed)).toBe('a.png 1x, b.png 2x, c.png 400w');
  });

  it('tolerates a bare url', () => {
    expect(parseSrcset('a.png')).toEqual([{ url: 'a.png', descriptor: '' }]);
  });
});

describe('findExternalUrlsInHtml', () => {
  it('finds attribute, css and import references', () => {
    const html = `
      <img src="https://cdn.example/a.png">
      <img srcset="https://cdn.example/b.png 2x, data:image/gif;base64,A 1x">
      <style>.x{background:url('//cdn.example/c.png')}</style>
      <style>@import url(https://cdn.example/d.css);</style>
      <img src="data:image/gif;base64,AAA">
    `;
    const found = findExternalUrlsInHtml(html);
    expect(found).toContain('https://cdn.example/a.png');
    expect(found).toContain('https://cdn.example/b.png');
    expect(found).toContain('//cdn.example/c.png');
    expect(found).toContain('https://cdn.example/d.css');
    expect(found.some((u) => u.startsWith('data:'))).toBe(false);
  });

  it('returns nothing for a fully embedded document', () => {
    expect(
      findExternalUrlsInHtml('<img src="data:image/gif;base64,AAA"><style>.a{background:url("")}</style>'),
    ).toEqual([]);
  });
});
