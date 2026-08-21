import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A very small Chrome DevTools Protocol client.
 *
 * Used by the player and kiosk smoke tests to drive a real browser without adding a
 * browser-automation dependency to a project whose whole point is shipping bundles with
 * no external dependencies. Node's global WebSocket is enough.
 */

const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];

export async function findChromium() {
  for (const candidate of CANDIDATES.filter(Boolean)) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  for (const entry of await readdir(base)) {
    if (!entry.startsWith('chromium-')) continue;
    const candidate = join(base, entry, 'chrome-linux', 'chrome');
    try {
      await stat(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error('No Chromium found; set CHROMIUM_PATH.');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function launchBrowser({ width = 1440, height = 900, extraArgs = [] } = {}) {
  const binary = await findChromium();
  const port = 9222 + Math.floor((process.pid % 500));
  const profile = await mkdtemp(join(tmpdir(), 'demo-smoke-'));

  const child = spawn(
    binary,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
      ...extraArgs,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  // Wait for the debugging endpoint.
  let target = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(200);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      target = targets.find((t) => t.type === 'page');
      if (target?.webSocketDebuggerUrl) break;
    } catch {
      /* not up yet */
    }
  }
  if (!target) {
    child.kill('SIGKILL');
    throw new Error(`Chromium did not expose a debugging target.\n${stderr}`);
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const events = [];

  socket.addEventListener('message', (message) => {
    const payload = JSON.parse(String(message.data));
    if (payload.id && pending.has(payload.id)) {
      const { resolve, reject } = pending.get(payload.id);
      pending.delete(payload.id);
      if (payload.error) reject(new Error(`${payload.error.message} (${payload.method ?? ''})`));
      else resolve(payload.result);
      return;
    }
    events.push(payload);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30_000);
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Console.enable').catch(() => {});

  return {
    send,
    events,
    consoleMessages: () =>
      events
        .filter((e) => e.method === 'Console.messageAdded')
        .map((e) => `${e.params.message.level}: ${e.params.message.text}`),
    async goto(url, { waitMs = 1200 } = {}) {
      await send('Page.navigate', { url });
      await delay(waitMs);
    },
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(`page threw: ${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception?.description ?? '')}`);
      }
      return result.result.value;
    },
    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, Buffer.from(data, 'base64'));
      return path;
    },
    async close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await Promise.race([exited, delay(3000)]);
      // Chromium can still be flushing its profile; a failed cleanup of a temp dir is
      // not worth failing a smoke test over.
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
    stderr: () => stderr,
    delay,
  };
}
