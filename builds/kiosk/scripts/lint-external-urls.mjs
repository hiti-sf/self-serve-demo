#!/usr/bin/env node
/**
 * Fail the kiosk build if any external URL survives into the bundle (SPEC §8.2, §11).
 *
 * The check distinguishes positions, because "contains the string https://" is both too
 * strict and too loose:
 *
 *   FAIL — loadable positions: src/srcset/poster, href on <link>, CSS url() and @import,
 *          and network call sites in JS (fetch, import(), Worker, EventSource,
 *          WebSocket, importScripts, XMLHttpRequest.open).
 *   FAIL — any other external URL whose host is not declared in allowed-hosts.json with
 *          a reason. That file is the review gate: adding a host is a deliberate act.
 *   PASS — link targets a visitor clicks (an end-screen CTA opens their browser, which is
 *          the point of the CTA) and declared hosts.
 *
 * The single sanctioned exception is `kiosk-config.json`, which carries the
 * operator-editable sync endpoint. It is reported, never hidden, and nothing is sent
 * there until someone presses Sync.
 *
 *   node builds/kiosk/scripts/lint-external-urls.mjs [bundleDir]
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bundleDir = resolve(process.argv[2] ?? join(import.meta.dirname, '../dist-kiosk'));
const allowFile = join(import.meta.dirname, '../allowed-hosts.json');

const CONFIG_FILE = 'kiosk-config.json';

const TEXT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.json',
  '.webmanifest',
  '.svg',
  '.txt',
]);
const SKIP_EXTENSIONS = new Set(['.map']);

const HOST = '[a-z0-9-]+(?:\\.[a-z0-9-]+)*(?::[0-9]+)?';
const TAIL = '(?:/[^\\s"\'`)<>\\\\]*)?';

/**
 * Absolute URLs are unambiguous. Protocol-relative ones need a preceding delimiter:
 * without it, `//` matches inside base64 payloads (`…w//C…`) and after regex literals
 * (`/…/i.test`), which produced three false failures the first time this ran.
 */
const EXTERNAL_SOURCES = [`https?://${HOST}${TAIL}`, `(?<=["'\`(,;=\\s])//${HOST}${TAIL}`];

/** Loopback is not "external": it is this machine, and it is how the launcher serves the bundle. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * A host worth flagging looks like a hostname: a dotted name with a letter TLD, or
 * loopback. Anything else is a coincidence inside encoded data.
 */
function isPlausibleHost(host) {
  if (LOOPBACK_HOSTS.has(host)) return true;
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host);
}

/** Loadable positions — an external URL here is a runtime network call. */
const LOADABLE_PATTERNS = [
  ['element src', '\\ssrc\\s*=\\s*["\']((?:https?:)?//[^"\']+)["\']'],
  ['element srcset', '\\ssrcset\\s*=\\s*["\']([^"\']*(?:https?:)?//[^"\']+)["\']'],
  ['video poster', '\\sposter\\s*=\\s*["\']((?:https?:)?//[^"\']+)["\']'],
  ['<link href>', '<link\\b[^>]*\\shref\\s*=\\s*["\']((?:https?:)?//[^"\']+)["\']'],
  ['<script src>', '<script\\b[^>]*\\ssrc\\s*=\\s*["\']((?:https?:)?//[^"\']+)["\']'],
  ['CSS url()', 'url\\(\\s*["\']?((?:https?:)?//[^"\')\\s]+)'],
  ['CSS @import', '@import\\s+(?:url\\()?["\']?((?:https?:)?//[^"\')\\s;]+)'],
  ['fetch()', '\\bfetch\\s*\\(\\s*["\'`]((?:https?:)?//[^"\'`]+)'],
  ['dynamic import()', '\\bimport\\s*\\(\\s*["\'`]((?:https?:)?//[^"\'`]+)'],
  ['static import', '\\bfrom\\s*["\'`]((?:https?:)?//[^"\'`]+)["\'`]'],
  ['new Worker()', 'new\\s+(?:Shared)?Worker\\s*\\(\\s*["\'`]((?:https?:)?//[^"\'`]+)'],
  ['new EventSource()', 'new\\s+EventSource\\s*\\(\\s*["\'`]((?:https?:)?//[^"\'`]+)'],
  ['WebSocket', 'new\\s+WebSocket\\s*\\(\\s*["\'`](wss?://[^"\'`]+)'],
  ['importScripts()', 'importScripts\\s*\\(\\s*["\'`]((?:https?:)?//[^"\'`]+)'],
  ['XHR open()', '\\.open\\s*\\(\\s*["\'][A-Z]+["\']\\s*,\\s*["\'`]((?:https?:)?//[^"\'`]+)'],
];

/** Positions where an external URL is expected: the visitor clicks it, nothing fetches it. */
const LINK_TARGET_PATTERNS = [
  '<a\\b[^>]*\\shref\\s*=\\s*["\']((?:https?:)?//[^"\']+)["\']',
  '"url"\\s*:\\s*"((?:https?:)?//[^"]+)"',
  '\\sdata-demo-(?:original-href|source-url)\\s*=\\s*["\']((?:https?:)?//[^"\']+)["\']',
];

function matchAll(text, source) {
  const found = [];
  const regex = new RegExp(source, 'gi');
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = match[1] ?? match[0];
    if (value) found.push(value);
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
  }
  return found;
}

function matchAllUrls(text) {
  return EXTERNAL_SOURCES.flatMap((source) => matchAll(text, source));
}

function hostOf(url) {
  try {
    return new URL(url.startsWith('//') ? `https:${url}` : url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

export async function lintBundle(dir, { allowedHosts }) {
  const failures = [];
  const informational = [];
  let scanned = 0;

  for (const file of await walk(dir)) {
    const extension = extname(file).toLowerCase();
    if (SKIP_EXTENSIONS.has(extension) || !TEXT_EXTENSIONS.has(extension)) continue;

    const rel = relative(dir, file);
    const text = await readFile(file, 'utf8');
    scanned += 1;

    if (rel === CONFIG_FILE) {
      for (const url of matchAllUrls(text)) {
        informational.push({ rel, label: 'sync endpoint (operator-configured)', url });
      }
      continue;
    }

    // Several detectors can fire on one URL (an <img src> is both "element src" and an
    // undeclared host). Report each URL once, under the most specific label, so the
    // build output names the actual problem rather than repeating it.
    const reported = new Map();
    const report = (label, url, why) => {
      if (reported.has(url)) return;
      reported.set(url, { rel, label, url, why });
    };

    for (const [label, source] of LOADABLE_PATTERNS) {
      for (const url of matchAll(text, source)) {
        report(label, url, 'loadable position — this would hit the network at runtime');
      }
    }

    const linkTargets = new Set(LINK_TARGET_PATTERNS.flatMap((source) => matchAll(text, source)));

    for (const url of matchAllUrls(text)) {
      if (linkTargets.has(url)) continue;
      const host = hostOf(url);
      if (!host || !isPlausibleHost(host)) continue;
      if (LOOPBACK_HOSTS.has(host)) continue;
      if (allowedHosts.has(host)) continue;
      report('undeclared external URL', url, `host "${host}" is not in allowed-hosts.json`);
    }

    failures.push(...reported.values());
  }

  return { failures, informational, scanned };
}

export async function readAllowedHosts(file = allowFile) {
  const allow = JSON.parse(await readFile(file, 'utf8'));
  return new Set(allow.hosts.map((entry) => entry.host.toLowerCase()));
}

/** Run as a script; when imported by a test, only the exports above are used. */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await stat(bundleDir);
  } catch {
    console.error(`Bundle directory not found: ${bundleDir}`);
    console.error('Run `pnpm build:kiosk --all` first, or pass the bundle path.');
    process.exit(1);
  }

  const allowedHosts = await readAllowedHosts();
  const { failures, informational, scanned } = await lintBundle(bundleDir, { allowedHosts });

  console.log(`Scanned ${scanned} text file(s) in ${relative(process.cwd(), bundleDir) || bundleDir}`);
  for (const note of informational) {
    console.log(`  · ${note.rel}: ${note.label} -> ${note.url}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} external reference(s) must not ship in a kiosk bundle:\n`);
    const seen = new Set();
    for (const failure of failures) {
      const key = `${failure.rel}|${failure.url}|${failure.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.error(`  ${failure.rel}\n    ${failure.label}: ${failure.url}\n    ${failure.why}`);
    }
    console.error(
      '\nEmbed the asset, remove the reference, or - only if it is genuinely never fetched -\n' +
        'declare the host in builds/kiosk/allowed-hosts.json with a reason.',
    );
    process.exit(1);
  }

  console.log('\nNo external references. This bundle will run with the wifi switched off.');
}
