#!/usr/bin/env node
/**
 * Node host for the gated web target.
 *
 * Serves the built app, the demos folder and the API routes from one process, so the
 * whole gated flow can be exercised locally and self-hosted without a serverless
 * platform. The CRM adapter is constructed here: its credential stays in this process
 * (SPEC §8.1, §11).
 *
 *   node builds/web/server/dev-server.mjs            # API only, for `vite dev` to proxy
 *   SERVE_DIST=1 node builds/web/server/dev-server.mjs
 */
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createStaticServer } from '../../../scripts/static-server.mjs';
import { createCrmAdapter } from '../../../adapters/crm/src/index.ts';
import { routeApi } from '../api/handlers.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const port = Number(process.env.PORT ?? 8787);
const serveDist = process.env.SERVE_DIST === '1';

const crm = createCrmAdapter(process.env, {
  onError: (error, dropped) =>
    console.error(`[api] dropped ${dropped.length} event(s):`, error instanceof Error ? error.message : error),
});

const config = {
  crm,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  freemailDomains: process.env.FREEMAIL_DOMAINS
    ? process.env.FREEMAIL_DOMAINS.split(',').map((d) => d.trim()).filter(Boolean)
    : undefined,
  log: (message, payload) => console.log(message, payload ? JSON.stringify(payload) : ''),
};

/** Static handlers, only when asked: `vite dev` serves the app itself. */
const distServer = serveDist ? createStaticServer({ root: join(repoRoot, 'builds/web/dist'), spaFallback: 'index.html' }) : null;
const demosServer = createStaticServer({ root: join(repoRoot, 'demos') });

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value]] : [],
      ),
      ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body }),
    });

    const routed = routeApi(request, config);
    if (!routed) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"unknown route"}');
      return;
    }
    const response = await routed;
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }

  if (url.pathname.startsWith('/demos/')) {
    // Reuse the static handler by rewriting the path into the demos root.
    req.url = url.pathname.replace('/demos', '') + (url.search ?? '');
    demosServer.emit('request', req, res);
    return;
  }

  if (distServer) {
    distServer.emit('request', req, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
});

// Never lose a buffered batch on shutdown.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n${signal} — flushing the CRM buffer…`);
    await crm.flush?.();
    server.close(() => process.exit(0));
  });
}

server.listen(port, () => {
  console.log(`Demo API on http://127.0.0.1:${port} (CRM adapter: ${crm.name})`);
  if (serveDist) {
    void stat(join(repoRoot, 'builds/web/dist/index.html')).catch(() =>
      console.warn('builds/web/dist is missing — run `pnpm build:web` first.'),
    );
    console.log(`Serving builds/web/dist and /demos`);
  } else {
    console.log('Run `pnpm --filter @demo-platform/web dev` in another shell; it proxies /api here.');
  }
});
