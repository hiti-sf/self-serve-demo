#!/usr/bin/env tsx
/**
 * End-to-end verification of the gated web target (SPEC §12, M4 acceptance).
 *
 * Runs the real API handlers against a ConsoleCrmAdapter in this process, serves the
 * built web target, and drives a real browser through the gate. Asserts what the
 * acceptance gate asks for: the form creates a CRM lead, the demo unlocks, the full
 * event stream lands with the leadId attached, and abandonment is derivable.
 *
 *   pnpm build:web && tsx scripts/smoke-web.mts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { ConsoleCrmAdapter } from '../adapters/crm/src/index.js';
import { routeApi } from '../builds/web/api/handlers.js';
import { createStaticServer, listen } from './static-server.mjs';
import { launchBrowser } from './cdp.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const distDir = join(repoRoot, 'builds/web/dist');
const demoPath = '/demos/inlumin/flow-01-requisition-to-po';

const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: unknown, detail = ''): void {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

const crm = new ConsoleCrmAdapter(() => {});
const config = { crm, log: () => {} };

// The static handler serves the built app; API paths are handled before it.
const staticHandler = createStaticServer({ root: distDir, spaFallback: 'index.html' });

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  if (!url.pathname.startsWith('/api/')) {
    staticHandler.emit('request', req, res);
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([key, value]) =>
      typeof value === 'string' ? ([[key, value]] as [string, string][]) : [],
    ),
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Buffer.concat(chunks) }),
  });

  const routed = routeApi(request, config);
  if (!routed) {
    res.writeHead(404).end('{}');
    return;
  }
  const response = await routed;
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
});

const port = await listen(server);
const origin = `http://127.0.0.1:${port}`;
const url = `${origin}/index.html?demo=${demoPath}`;

console.log(`\nSmoke-testing the gated web target at ${url}\n`);

const browser = await launchBrowser({ width: 1440, height: 900 });
let failures = 0;

try {
  // ---------------------------------------------------------------- the gate
  await browser.goto(url, { waitMs: 2000 });

  const gate = await browser.evaluate(`(() => ({
    form: Boolean(document.querySelector('[data-testid="gate-form"]')),
    preview: getComputedStyle(document.querySelector('[data-testid="gate-preview"]')).filter,
    previewImage: document.querySelector('[data-testid="gate-preview"]')?.style.backgroundImage ?? '',
    player: Boolean(document.querySelector('.dp-root')),
    fields: [...document.querySelectorAll('[data-testid="gate-form"] input, [data-testid="gate-form"] select')].length,
  }))()`);

  check('the gate blocks the demo', gate.form === true && gate.player === false, JSON.stringify(gate));
  check('the first frame shows through, blurred', gate.preview.includes('blur') && gate.previewImage.includes('step-01.png'), gate.preview);

  // Submitting without consent must be refused client-side and record nothing.
  const withoutConsent = await browser.evaluate(`(async () => {
    const form = document.querySelector('[data-testid="gate-form"]');
    const setValue = (selector, value) => {
      const input = form.querySelector(selector);
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const inputs = [...form.querySelectorAll('input[type="text"], input[type="email"], input:not([type])')];
    setValue('input[autocomplete="name"]', 'Priya Raman');
    setValue('input[type="email"]', 'priya.raman@strides.example');
    setValue('input[autocomplete="organization"]', 'Strides');
    form.querySelector('button[type="submit"]').click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      stillGated: Boolean(document.querySelector('[data-testid="gate-form"]')),
      consentError: [...document.querySelectorAll('.gate-error, .gate-field em')].map((n) => n.textContent).join(' | '),
      inputCount: inputs.length,
    };
  })()`);
  check('a submission without consent is refused', withoutConsent.stillGated === true, JSON.stringify(withoutConsent));
  check('the visitor is told why', withoutConsent.consentError.toLowerCase().includes('privacy'), withoutConsent.consentError);
  check('nothing was recorded pre-consent', crm.recordedLeads().length === 0 && crm.recordedEvents().length === 0,
    `${crm.recordedLeads().length} leads / ${crm.recordedEvents().length} events`);

  // A free-mail address is rejected.
  const freemail = await browser.evaluate(`(async () => {
    const form = document.querySelector('[data-testid="gate-form"]');
    const input = form.querySelector('input[type="email"]');
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
    setter.call(input, 'priya@gmail.com');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.querySelector('[data-testid="gate-consent"]').click();
    await new Promise((r) => setTimeout(r, 200));
    form.querySelector('button[type="submit"]').click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      stillGated: Boolean(document.querySelector('[data-testid="gate-form"]')),
      message: [...document.querySelectorAll('.gate-field em')].map((n) => n.textContent).join(' | '),
    };
  })()`);
  check('a free-mail address is rejected', freemail.stillGated === true, JSON.stringify(freemail));
  check('the free-mail message asks for a work address', freemail.message.toLowerCase().includes('work email'), freemail.message);

  // Now submit properly.
  const submitted = await browser.evaluate(`(async () => {
    const form = document.querySelector('[data-testid="gate-form"]');
    const input = form.querySelector('input[type="email"]');
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
    setter.call(input, 'priya.raman@strides.example');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.querySelector('button[type="submit"]').click();
    await new Promise((r) => setTimeout(r, 1800));
    return {
      unlocked: Boolean(document.querySelector('.dp-root')),
      gateGone: !document.querySelector('[data-testid="gate-form"]'),
      stepId: document.querySelector('.dp-root')?.getAttribute('data-step-id') ?? null,
      storedGate: sessionStorage.getItem('demo-gate:inlumin-flow-01'),
    };
  })()`);

  check('the demo unlocks on a valid submission', submitted.unlocked && submitted.gateGone, JSON.stringify(submitted));
  check('the gate result is kept for the session', String(submitted.storedGate ?? '').includes('lead_'), String(submitted.storedGate));

  const lead = crm.recordedLeads()[0];
  check('a CRM lead was created', Boolean(lead?.leadId), JSON.stringify(lead ?? null));
  check('the lead carries the demo context', lead?.demoId === 'inlumin-flow-01' && lead?.productInterest === 'InLumin',
    JSON.stringify({ demoId: lead?.demoId, productInterest: lead?.productInterest }));
  check('the work email was normalised', lead?.workEmail === 'priya.raman@strides.example', String(lead?.workEmail));

  // ---------------------------------------------------------------- the stream
  // Play to the end so demo_completed and cta_clicked land too.
  await browser.evaluate(`(async () => {
    for (let i = 0; i < 20; i += 1) {
      const target = document.querySelector('.dp-hotspot.is-active, .dp-tooltip-actions .dp-button--primary');
      if (!target) break;
      target.click();
      await new Promise((r) => setTimeout(r, 380));
    }
    document.querySelector('.dp-end-actions .dp-button--primary')?.click();
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  })()`);
  await browser.delay(1200);

  const names = crm.recordedEvents().map((event) => event.name);
  const leadId = lead?.leadId;
  check('gate_submitted was recorded server-side', names.includes('gate_submitted'), names.join(', '));
  check('demo_started arrived', names.includes('demo_started'));
  check('step_viewed arrived', names.includes('step_viewed'));
  check('step_completed arrived', names.includes('step_completed'));
  check('chapter_completed arrived', names.includes('chapter_completed'));
  check('demo_completed arrived', names.includes('demo_completed'));
  check('cta_clicked arrived', names.includes('cta_clicked'));
  check(
    'every event carries the leadId',
    Boolean(leadId) && crm.recordedEvents().every((event) => event.leadId === leadId),
    `${crm.recordedEvents().filter((e) => e.leadId !== leadId).length} event(s) without it`,
  );
  check(
    'every event carries one sessionId',
    new Set(crm.recordedEvents().map((event) => event.sessionId)).size === 1,
    [...new Set(crm.recordedEvents().map((e) => e.sessionId))].join(', '),
  );
  const dwell = crm.recordedEvents().filter((event) => event.name === 'step_completed');
  check('step dwell time was measured', dwell.length > 0 && dwell.every((e) => (e.payload as { dwellMs: number }).dwellMs >= 0),
    JSON.stringify(dwell.map((e) => (e.payload as { dwellMs: number }).dwellMs)));

  // ---------------------------------------------------------------- abandonment
  // Fresh session: unlock, walk partway in, then navigate away.
  const before = crm.recordedEvents().length;
  await browser.goto(`${origin}/index.html?demo=${demoPath}&run=2`, { waitMs: 1800 });
  await browser.evaluate(`(async () => {
    sessionStorage.clear();
    return true;
  })()`);
  await browser.goto(`${origin}/index.html?demo=${demoPath}&run=3`, { waitMs: 1800 });
  await browser.evaluate(`(async () => {
    const form = document.querySelector('[data-testid="gate-form"]');
    if (!form) return 'already unlocked';
    const set = (selector, value) => {
      const input = form.querySelector(selector);
      const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('input[autocomplete="name"]', 'Tomas Okafor');
    set('input[type="email"]', 't.okafor@meridian.example');
    set('input[autocomplete="organization"]', 'Meridian Polymers');
    form.querySelector('[data-testid="gate-consent"]').click();
    form.querySelector('button[type="submit"]').click();
    await new Promise((r) => setTimeout(r, 1600));
    // Move one step in, then leave without finishing.
    document.querySelector('.dp-hotspot.is-active')?.click();
    await new Promise((r) => setTimeout(r, 600));
    return document.querySelector('.dp-root')?.getAttribute('data-step-id') ?? null;
  })()`);

  await browser.goto('about:blank', { waitMs: 1500 });
  await browser.delay(800);

  const abandoned = crm.recordedEvents().slice(before).filter((event) => event.name === 'session_abandoned');
  check('abandonment is reported when the visitor leaves', abandoned.length > 0,
    crm.recordedEvents().slice(before).map((e) => e.name).join(', '));
  if (abandoned.length > 0) {
    const payload = abandoned[0]!.payload as { lastStepId: string; dwellMs: number; derivedFrom: string };
    check('the abandonment names the last step reached', Boolean(payload.lastStepId), JSON.stringify(payload));
    check('the abandonment records how it was derived', payload.derivedFrom === 'client-unload', payload.derivedFrom);
    check('a second lead was created for the second visitor', crm.recordedLeads().length === 2,
      `${crm.recordedLeads().length} lead(s)`);
  }

  failures = checks.filter((entry) => !entry.ok).length;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${checks.length - failures}/${checks.length} checks passed.`);
console.log(`CRM saw ${crm.recordedLeads().length} lead(s) and ${crm.recordedEvents().length} event(s).`);
if (failures > 0) process.exit(1);
