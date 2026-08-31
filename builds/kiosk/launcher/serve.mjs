#!/usr/bin/env node
/**
 * Node fallback launcher for a kiosk bundle.
 *
 * Used when the bundle was built on a machine without Go. Dependency-free on purpose:
 * `npm install` on a booth laptop with no network is not a plan (SPEC §8.2).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dirname);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^\/+/, '');
  if (path.startsWith('..')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let file = join(root, path || 'index.html');
  try {
    const stats = await stat(file);
    if (stats.isDirectory()) file = join(file, 'index.html');
    await stat(file);
  } catch {
    file = join(root, 'index.html');
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  createReadStream(file).pipe(res);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;
  console.log(`\nPivot Path demo kiosk\n---------------------\nServing ${root}\nOpen ${url}\n`);
  console.log('Leave this window open while you present. Close it to stop the demo.');
  const opener =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
});
