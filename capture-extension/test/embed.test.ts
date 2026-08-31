// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { BLANK_IMAGE, dataUrlToText, embedResources, type FetchedResource } from '../src/lib/embed.js';
import { findExternalUrlsInHtml } from '../src/lib/urls.js';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function textResource(text: string, contentType = 'text/css'): FetchedResource {
  return {
    dataUrl: `data:${contentType};base64,${Buffer.from(text, 'utf8').toString('base64')}`,
    bytes: text.length,
    contentType,
  };
}

const pngResource: FetchedResource = {
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  bytes: 128,
  contentType: 'image/png',
};

describe('embedResources', () => {
  it('inlines image src and srcset as data URIs', async () => {
    const doc = parse(
      '<body><img id="hero" src="/img/hero.png" srcset="/img/hero@2x.png 2x" loading="lazy"></body>',
    );
    const fetchResource = vi.fn(async () => pngResource);
    const result = await embedResources(doc, { baseUrl: 'https://app.example/po', fetchResource });

    const img = doc.getElementById('hero')!;
    expect(img.getAttribute('src')).toBe(pngResource.dataUrl);
    expect(img.getAttribute('srcset')).toBe(`${pngResource.dataUrl} 2x`);
    expect(img.hasAttribute('loading')).toBe(false);
    expect(result.embedded).toBeGreaterThan(0);
    expect(fetchResource).toHaveBeenCalledWith('https://app.example/img/hero.png');
  });

  it('falls back to a blank image when a resource cannot be fetched', async () => {
    const doc = parse('<body><img id="a" src="/missing.png"></body>');
    const result = await embedResources(doc, {
      baseUrl: 'https://app.example/',
      fetchResource: async () => null,
    });
    expect(doc.getElementById('a')?.getAttribute('src')).toBe(BLANK_IMAGE);
    expect(doc.getElementById('a')?.getAttribute('data-demo-missing-src')).toBe('1');
    expect(result.skipped).toBe(1);
    expect(result.warnings[0]?.kind).toBe('resource-fetch-failed');
  });

  it('inlines a cross-origin stylesheet and the fonts it references', async () => {
    const doc = parse('<head><link rel="stylesheet" href="https://cdn.example/app.css"></head>');
    const fetchResource = vi.fn(async (url: string) => {
      if (url.endsWith('.css')) {
        return textResource('@font-face{src:url("f.woff2")}.a{color:red}');
      }
      return { dataUrl: 'data:font/woff2;base64,AAAA', bytes: 64, contentType: 'font/woff2' };
    });

    await embedResources(doc, { baseUrl: 'https://app.example/', fetchResource });

    expect(doc.querySelector('link[rel~="stylesheet"]')).toBeNull();
    const style = doc.querySelector('style')!;
    expect(style.textContent).toContain('data:font/woff2;base64,AAAA');
    expect(style.textContent).toContain('.a{color:red}');
    expect(fetchResource).toHaveBeenCalledWith('https://cdn.example/f.woff2');
  });

  it('drops a stylesheet it cannot fetch rather than leaving a network reference', async () => {
    const doc = parse('<head><link rel="stylesheet" href="https://cdn.example/app.css"></head>');
    const result = await embedResources(doc, {
      baseUrl: 'https://app.example/',
      fetchResource: async () => null,
    });
    expect(doc.querySelector('link')).toBeNull();
    expect(result.warnings.some((w) => w.kind === 'cross-origin-stylesheet')).toBe(true);
  });

  it('rewrites url() inside style attributes', async () => {
    const doc = parse('<body><div id="d" style="background:url(/bg.png) center"></div></body>');
    await embedResources(doc, { baseUrl: 'https://app.example/', fetchResource: async () => pngResource });
    expect(doc.getElementById('d')?.getAttribute('style')).toContain(pngResource.dataUrl);
  });

  it('replaces video with its poster frame', async () => {
    const doc = parse('<body><video id="v" poster="/poster.png" width="640"></video></body>');
    const result = await embedResources(doc, {
      baseUrl: 'https://app.example/',
      fetchResource: async () => pngResource,
    });
    expect(doc.querySelector('video')).toBeNull();
    const img = doc.querySelector('img[data-demo-replaced="video"]')!;
    expect(img.getAttribute('src')).toBe(pngResource.dataUrl);
    expect(img.getAttribute('width')).toBe('640');
    expect(result.warnings.some((w) => w.kind === 'video-poster')).toBe(true);
  });

  it('leaves no external URL behind after a successful pass', async () => {
    const doc = parse(`
      <head><link rel="stylesheet" href="https://cdn.example/app.css"><link rel="preload" href="https://cdn.example/x.js"></head>
      <body>
        <img src="https://cdn.example/a.png" srcset="https://cdn.example/a2.png 2x">
        <div style="background:url(https://cdn.example/b.png)"></div>
        <svg><image href="https://cdn.example/c.svg"></image></svg>
      </body>`);
    await embedResources(doc, {
      baseUrl: 'https://app.example/',
      fetchResource: async (url) => (url.endsWith('.css') ? textResource('.a{color:red}') : pngResource),
    });
    const html = doc.documentElement.outerHTML;
    expect(findExternalUrlsInHtml(html)).toEqual([]);
  });

  it('skips resources above the per-resource limit', async () => {
    const doc = parse('<body><img id="a" src="/big.png"></body>');
    const result = await embedResources(doc, {
      baseUrl: 'https://app.example/',
      fetchResource: async () => ({ ...pngResource, bytes: 20 * 1024 * 1024 }),
      maxResourceBytes: 1024,
    });
    expect(result.warnings.some((w) => w.kind === 'resource-too-large')).toBe(true);
    expect(doc.getElementById('a')?.getAttribute('src')).toBe(BLANK_IMAGE);
  });

  it('fetches each unique URL once', async () => {
    const doc = parse('<body><img src="/a.png"><img src="/a.png"><img src="/a.png"></body>');
    const fetchResource = vi.fn(async () => pngResource);
    await embedResources(doc, { baseUrl: 'https://app.example/', fetchResource });
    expect(fetchResource).toHaveBeenCalledTimes(1);
  });
});

describe('dataUrlToText', () => {
  it('decodes base64 and percent-encoded payloads', () => {
    expect(dataUrlToText(textResource('.a{color:red}').dataUrl)).toBe('.a{color:red}');
    expect(dataUrlToText('data:text/css,.b%7Bcolor%3Ablue%7D')).toBe('.b{color:blue}');
  });
});
