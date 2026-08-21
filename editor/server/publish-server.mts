#!/usr/bin/env tsx
/**
 * Publish server for the editor (SPEC §7).
 *
 * One route: it takes a built demo folder from the editor and writes it into `demos/`.
 * That is the "one-click publish" the spec asks for, and it is the only thing in the
 * editor that writes anything, so it is the only thing that needs auth.
 *
 * Auth is a shared password (`EDITOR_TOKEN`) or a trusted SSO header
 * (`SSO_HEADER`, e.g. `x-forwarded-email`, set by whatever proxy fronts the tool).
 * §7 is explicit that user management is out of scope.
 *
 *   EDITOR_TOKEN=letmein tsx editor/server/publish-server.mts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { safeParseManifest, slugify, assertScriptFree } from '../../packages/shared/src/index.js';

const repoRoot = resolve(import.meta.dirname, '../..');
/** Overridable so a staging instance (or a test) can publish somewhere other than the repo. */
const demosRoot = process.env.DEMOS_ROOT ? resolve(process.env.DEMOS_ROOT) : join(repoRoot, 'demos');
const port = Number(process.env.PORT ?? 8788);
const token = process.env.EDITOR_TOKEN ?? '';
const ssoHeader = process.env.SSO_HEADER ?? '';

if (!token && !ssoHeader) {
  console.warn(
    'No EDITOR_TOKEN or SSO_HEADER set. Publishing is disabled until one is configured —\n' +
      'the editor still works for authoring and Export.',
  );
}

interface IncomingFile {
  path: string;
  text?: string;
  base64?: string;
  contentType?: string;
}

interface PublishBody {
  demoId?: string;
  product?: string;
  files?: IncomingFile[];
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function authorised(req: IncomingMessage): boolean {
  if (ssoHeader) {
    const value = req.headers[ssoHeader.toLowerCase()];
    if (typeof value === 'string' && value.length > 0) return true;
  }
  if (token) {
    const provided = req.headers['x-editor-token'];
    // Length-independent compare is overkill for an internal tool with one shared
    // password, but constant-time is free here.
    if (typeof provided === 'string' && provided.length === token.length) {
      let mismatch = 0;
      for (let i = 0; i < token.length; i += 1) mismatch |= provided.charCodeAt(i) ^ token.charCodeAt(i);
      if (mismatch === 0) return true;
    }
  }
  return false;
}

/** Reject anything that would write outside the demo folder. */
function safeRelativePath(path: string): string | null {
  const cleaned = normalize(path).replace(/^\/+/, '');
  if (!cleaned || cleaned.startsWith('..') || cleaned.includes('\0')) return null;
  if (/^[a-zA-Z]:/.test(cleaned)) return null;
  return cleaned;
}

const ALLOWED_EXTENSIONS = new Set(['.json', '.html', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.woff2', '.ico']);

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index < 0 ? '' : path.slice(index).toLowerCase();
}

async function handlePublish(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!token && !ssoHeader) {
    json(res, 503, { ok: false, error: 'Publishing is not configured on this server.' });
    return;
  }
  if (!authorised(req)) {
    json(res, 401, { ok: false, error: 'Not authorised. Check the editor password.' });
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 200 * 1024 * 1024) {
      json(res, 413, { ok: false, error: 'Demo folder too large.' });
      return;
    }
    chunks.push(chunk as Buffer);
  }

  let body: PublishBody;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PublishBody;
  } catch {
    json(res, 400, { ok: false, error: 'Invalid JSON.' });
    return;
  }

  const demoId = slugify(body.demoId ?? '', '');
  const product = slugify(body.product ?? '', '');
  if (!demoId || !product) {
    json(res, 422, { ok: false, error: 'demoId and product are required.' });
    return;
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    json(res, 422, { ok: false, error: 'No files to publish.' });
    return;
  }

  // Validate before writing anything: a half-written demo folder is worse than none.
  const manifestFile = body.files.find((file) => file.path === 'manifest.json');
  if (!manifestFile?.text) {
    json(res, 422, { ok: false, error: 'manifest.json is missing from the upload.' });
    return;
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestFile.text);
  } catch {
    json(res, 422, { ok: false, error: 'manifest.json is not valid JSON.' });
    return;
  }
  const parsed = safeParseManifest(manifestJson);
  if (!parsed.ok) {
    json(res, 422, { ok: false, error: 'The manifest is not valid.', issues: parsed.issues });
    return;
  }

  const staged: { path: string; write: () => Promise<void> }[] = [];
  const target = join(demosRoot, product, demoId);

  for (const file of body.files) {
    const relative = safeRelativePath(file.path);
    if (!relative) {
      json(res, 422, { ok: false, error: `Refusing to write outside the demo folder: ${file.path}` });
      return;
    }
    if (!ALLOWED_EXTENSIONS.has(extensionOf(relative))) {
      json(res, 422, { ok: false, error: `File type not allowed in a demo folder: ${relative}` });
      return;
    }

    const absolute = join(target, relative);
    if (!absolute.startsWith(`${target}/`) && absolute !== target) {
      json(res, 422, { ok: false, error: `Refusing to write outside the demo folder: ${relative}` });
      return;
    }

    if (file.text !== undefined) {
      if (relative.endsWith('.html')) {
        // The editor already checks this; the server checks it again because it is the
        // thing that actually writes to the repo (§11).
        try {
          assertScriptFree(file.text);
        } catch (error) {
          json(res, 422, { ok: false, error: `${relative}: ${(error as Error).message}` });
          return;
        }
      }
      const text = file.text;
      staged.push({
        path: relative,
        write: async () => {
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(absolute, text, 'utf8');
        },
      });
    } else if (file.base64 !== undefined) {
      const buffer = Buffer.from(file.base64, 'base64');
      staged.push({
        path: relative,
        write: async () => {
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(absolute, buffer);
        },
      });
    } else {
      json(res, 422, { ok: false, error: `${relative} has no content.` });
      return;
    }
  }

  // Replace the folder wholesale: a republish that left an orphaned step file behind
  // would ship a snapshot no manifest references.
  await rm(target, { recursive: true, force: true });
  for (const file of staged) await file.write();

  const folder = `demos/${product}/${demoId}`;
  console.log(`[publish] ${folder} — ${staged.length} file(s), ${parsed.manifest.steps.length} step(s)`);
  json(res, 200, { ok: true, folder, written: staged.length });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  if (url.pathname === '/api/publish' && req.method === 'POST') {
    handlePublish(req, res).catch((error) => {
      console.error('[publish] failed', error);
      json(res, 500, { ok: false, error: 'Publish failed. See the server log.' });
    });
    return;
  }

  if (url.pathname === '/api/health') {
    json(res, 200, {
      ok: true,
      publishing: Boolean(token || ssoHeader),
      auth: ssoHeader ? `sso:${ssoHeader}` : token ? 'shared-password' : 'disabled',
      demosRoot: demosRoot.replace(`${repoRoot}/`, ''),
    });
    return;
  }

  json(res, 404, { ok: false, error: 'unknown route' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Editor publish server on http://127.0.0.1:${port}`);
  console.log(`Writing demos into ${demosRoot.replace(`${repoRoot}/`, '')}`);
  console.log(`Auth: ${ssoHeader ? `SSO header ${ssoHeader}` : token ? 'shared password' : 'DISABLED'}`);
});
