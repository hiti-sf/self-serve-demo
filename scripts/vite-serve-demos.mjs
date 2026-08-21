import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * Dev-only Vite middleware that serves the repo's `demos/` folder at `/demos/*`.
 *
 * Demo content lives outside every app's Vite root because it is content, not code
 * (SPEC §2). In production each build target copies the demos it needs; in dev this
 * plugin stands in for that copy so the player, editor and both targets all resolve
 * `/demos/<id>/manifest.json` the same way.
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export function serveDemos({ demosDir, mount = '/demos' } = {}) {
  const root = resolve(demosDir);

  return {
    name: 'demo-platform:serve-demos',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith(`${mount}/`)) return next();

        // Path traversal guard: a dev server that reads outside demos/ is a liability.
        const relative = normalize(decodeURIComponent(url.slice(mount.length + 1)));
        if (relative.startsWith('..')) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }

        const filePath = join(root, relative);
        try {
          const stats = await stat(filePath);
          if (!stats.isFile()) throw new Error('not a file');
          res.setHeader('content-type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
          res.setHeader('cache-control', 'no-cache');
          createReadStream(filePath).pipe(res);
        } catch {
          res.statusCode = 404;
          res.end(`not found: ${url}`);
        }
      });
    },
  };
}
