#!/usr/bin/env node
/**
 * CI check for accidental credential inclusion (SPEC §11).
 *
 * Two distinct risks, both checked:
 *   1. A secret committed to the repo at all.
 *   2. A secret that reached a **client bundle** — the player, the web target, the kiosk
 *      folder or the extension. CRM credentials are server-side only (§8.1), so anything
 *      that looks like one in a built bundle is a shipping incident, not a lint nit.
 *
 *   node scripts/lint-no-secrets.mjs [--staged]
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const stagedOnly = process.argv.includes('--staged');

/** Directories that are built output rather than source; both are scanned, differently. */
const BUNDLE_DIRS = [
  'player/dist',
  'editor/dist',
  'builds/web/dist',
  'builds/kiosk/dist-kiosk',
  'capture-extension/dist',
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.smoke', 'coverage', 'bin']);
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.json', '.html', '.css', '.md',
  '.yml', '.yaml', '.txt', '.go', '.sh', '.cmd', '.command', '.env', '',
]);

/**
 * Patterns for real credential shapes. Deliberately specific: a lint that fires on the
 * word "token" trains people to ignore it.
 */
const PATTERNS = [
  { name: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key', regex: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}/i },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', regex: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe key', regex: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{20,}\b/ },
  { name: 'Salesforce/OAuth refresh token', regex: /\b5Aep[0-9A-Za-z._-]{40,}\b/ },
  { name: 'private key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'bearer token literal', regex: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  {
    name: 'assigned secret',
    // `CRM_TOKEN = "…"` with something that is not a placeholder.
    regex:
      /\b(?:CRM_TOKEN|EDITOR_TOKEN|API_KEY|APIKEY|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|AUTH_TOKEN|ACCESS_TOKEN)\b\s*[=:]\s*['"][^'"\s${}]{12,}['"]/i,
  },
];

/** Values that look like secrets but are documentation, tests or obvious placeholders. */
const PLACEHOLDER = /(?:example|placeholder|changeme|change-me|your[-_]?|xxx+|<[^>]+>|\$\{|process\.env|letmein|smoke-token|secret-token|not-the-password|dummy|redacted|fake|sample|test-token)/i;

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(path)));
    else found.push(path);
  }
  return found;
}

async function filesToScan() {
  if (stagedOnly) {
    const { stdout } = await execFileAsync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: repoRoot,
    });
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean).map((p) => join(repoRoot, p));
  }
  return walk(repoRoot);
}

const findings = [];
let scanned = 0;

for (const file of await filesToScan()) {
  const extension = extname(file).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) continue;
  try {
    const { size } = await stat(file);
    if (size > 4 * 1024 * 1024) continue;
  } catch {
    continue;
  }

  const rel = relative(repoRoot, file);
  const text = await readFile(file, 'utf8').catch(() => '');
  if (!text) continue;
  scanned += 1;

  const inBundle = BUNDLE_DIRS.some((dir) => rel.startsWith(dir));

  for (const { name, regex } of PATTERNS) {
    const match = regex.exec(text);
    if (!match) continue;
    if (PLACEHOLDER.test(match[0])) continue;
    findings.push({
      rel,
      name,
      excerpt: match[0].slice(0, 48),
      severity: inBundle ? 'SHIPPED IN A CLIENT BUNDLE' : 'committed to the repo',
    });
  }

  // A .env file must never be committed, secret-shaped contents or not.
  if (/(?:^|\/)\.env(?:\.|$)/.test(rel) && !rel.endsWith('.example')) {
    findings.push({ rel, name: '.env file', excerpt: '(whole file)', severity: 'committed to the repo' });
  }
}

console.log(`Scanned ${scanned} text file(s) for credentials.`);

if (findings.length > 0) {
  console.error(`\n${findings.length} possible credential(s):\n`);
  for (const finding of findings) {
    console.error(`  ${finding.rel}\n    ${finding.name} — ${finding.severity}\n    ${finding.excerpt}`);
  }
  console.error(
    '\nCRM and editor credentials belong in the server environment, never in the repo and\n' +
      'never in a client bundle (§8.1, §11). If this is a false positive, make the value an\n' +
      'obvious placeholder or read it from process.env.',
  );
  process.exit(1);
}

console.log('No credentials found.');
