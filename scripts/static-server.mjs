import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * Minimal static file server used by the smoke tests and by the kiosk launcher fallback.
 *
 * Dependency-free on purpose: the kiosk target must not need npm at runtime (SPEC §8.2),
 * and a smoke test that pulls a server package is a smoke test that fails offline.
 */

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
  '.map': 'application/json; charset=utf-8',
};

export function createStaticServer({ root, spaFallback = null } = {}) {
  const base = resolve(root);

  return createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    let relative = normalize(decodeURIComponent(url)).replace(/^\/+/, '');
    if (relative.startsWith('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (relative === '') relative = 'index.html';

    let filePath = join(base, relative);
    try {
      const stats = await stat(filePath);
      if (stats.isDirectory()) filePath = join(filePath, 'index.html');
      await stat(filePath);
    } catch {
      if (spaFallback) {
        filePath = join(base, spaFallback);
      } else {
        res.writeHead(404).end(`not found: ${url}`);
        return;
      }
    }

    res.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    createReadStream(filePath).pipe(res);
  });
}

export function listen(server, port = 0) {
  return new Promise((resolveListen) => {
    server.listen(port, '127.0.0.1', () => resolveListen(server.address().port));
  });
}
