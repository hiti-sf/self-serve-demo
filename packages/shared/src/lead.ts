import { z } from 'zod';

/**
 * Lead capture (SPEC §8.1). The gate form validates client-side for UX and the
 * server route re-validates with the same schema before it reaches the CRM.
 */

/**
 * Default free-mail rejection list. Configurable per deployment: pass your own list to
 * `validateWorkEmail`, or set FREEMAIL_DOMAINS (comma-separated) on the server.
 */
export const DEFAULT_FREEMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.co.uk',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'mail.com',
  'mail.ru',
  'yandex.com',
  'yandex.ru',
  'zoho.com',
  'rediffmail.com',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'tutanota.com',
  'hushmail.com',
  // Disposable-address services: a throwaway address is not a lead.
  'mailinator.com',
  'yopmail.com',
  'guerrillamail.com',
  '10minutemail.com',
  'trashmail.com',
  'sharklasers.com',
  'temp-mail.org',
  'getnada.com',
  'dispostable.com',
];

export type WorkEmailResult =
  | { ok: true; email: string; domain: string }
  | { ok: false; reason: 'malformed' | 'freemail'; message: string };

const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

export function validateWorkEmail(
  raw: string,
  freemailDomains: readonly string[] = DEFAULT_FREEMAIL_DOMAINS,
): WorkEmailResult {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return { ok: false, reason: 'malformed', message: 'Enter a valid email address.' };
  }
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const blocked = new Set(freemailDomains.map((d) => d.trim().toLowerCase()).filter(Boolean));
  if (blocked.has(domain)) {
    return {
      ok: false,
      reason: 'freemail',
      message: 'Please use your work email address.',
    };
  }
  return { ok: true, email, domain };
}

export const LeadInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    workEmail: z.string().trim().toLowerCase().min(5).max(254),
    company: z.string().trim().min(1).max(160),
    role: z.string().trim().min(1).max(120),
    /** Pre-filled from demo context (§8.1) but editable by the visitor. */
    productInterest: z.string().trim().min(1).max(120),
    /** No events fire before this is true (§8.1, §11). */
    consent: z.literal(true),
    demoId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    /** Attribution context, best-effort. */
    referrer: z.string().max(2048).optional(),
    utm: z.record(z.string().max(64), z.string().max(256)).optional(),
  })
  .strict();

export type LeadInput = z.infer<typeof LeadInputSchema>;

export type LeadValidation =
  | { ok: true; lead: LeadInput }
  | { ok: false; fieldErrors: Record<string, string> };

/**
 * Full gate-form validation: shape via zod, plus the work-email rule which is a
 * deployment policy rather than a schema constraint.
 */
export function validateLeadInput(
  input: unknown,
  freemailDomains: readonly string[] = DEFAULT_FREEMAIL_DOMAINS,
): LeadValidation {
  const parsed = LeadInputSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      if (!fieldErrors[key]) {
        fieldErrors[key] =
          key === 'consent' ? 'Please accept the privacy notice to continue.' : issue.message;
      }
    }
    return { ok: false, fieldErrors };
  }

  const email = validateWorkEmail(parsed.data.workEmail, freemailDomains);
  if (!email.ok) {
    return { ok: false, fieldErrors: { workEmail: email.message } };
  }

  return { ok: true, lead: { ...parsed.data, workEmail: email.email } };
}
