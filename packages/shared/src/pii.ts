/**
 * Capture-time PII detection (SPEC §5, §11).
 *
 * Demo data must be synthetic. This is a guard against slips, not a compliance
 * control: it flags candidates and the author decides what to redact. Detection is
 * deliberately eager — a false positive costs one click, a miss ships PII into a
 * demo that gets copied to a USB stick.
 */

export type PiiKind =
  | 'email'
  | 'phone'
  | 'patient-id'
  | 'case-id'
  | 'national-id'
  | 'date-of-birth'
  | 'credit-card';

export interface PiiPattern {
  kind: PiiKind;
  label: string;
  regex: RegExp;
}

export const PII_PATTERNS: readonly PiiPattern[] = [
  {
    kind: 'email',
    label: 'Email address',
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    kind: 'phone',
    label: 'Phone number',
    regex: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,5}[\s.-]?\d{3,4}[\s.-]?\d{0,4}(?!\d)/g,
  },
  {
    kind: 'patient-id',
    label: 'Patient identifier',
    regex: /\b(?:patient|subject|pt|mrn|nhs)[\s._#:-]*(?:id|no\.?|number)?[\s._#:-]*[A-Z0-9-]{4,}\b/gi,
  },
  {
    kind: 'case-id',
    label: 'Case / AER identifier',
    regex: /\b(?:case|aer|icsr|safety[\s-]?report)[\s._#:-]*(?:id|no\.?|number)?[\s._#:-]*[A-Z0-9-]{4,}\b/gi,
  },
  {
    kind: 'national-id',
    label: 'National identifier',
    regex: /\b(?:\d{3}-\d{2}-\d{4}|[A-Z]{5}\d{4}[A-Z]|\d{4}\s?\d{4}\s?\d{4})\b/g,
  },
  {
    kind: 'date-of-birth',
    label: 'Date of birth',
    regex: /\b(?:dob|d\.o\.b\.?|date of birth)[\s:.-]*\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/gi,
  },
  {
    kind: 'credit-card',
    label: 'Payment card number',
    regex: /\b(?:\d{4}[\s-]?){3}\d{3,4}\b/g,
  },
];

export interface PiiFinding {
  kind: PiiKind;
  label: string;
  match: string;
  /** Offset within the scanned string. */
  start: number;
  end: number;
}

/** Phone-shaped noise that is almost always a price, quantity or PO number. */
function isProbablyNotPhone(match: string): boolean {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 7) return true;
  if (digits.length > 15) return true;
  return false;
}

export function scanText(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];
  for (const pattern of PII_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      if (pattern.kind === 'phone' && isProbablyNotPhone(match[0])) continue;
      findings.push({
        kind: pattern.kind,
        label: pattern.label,
        match: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return dedupeOverlapping(findings);
}

/**
 * Keep the longest match when patterns overlap: "case CASE-2291" should be reported
 * once as a case id, not also as a bare phone-shaped number.
 */
function dedupeOverlapping(findings: PiiFinding[]): PiiFinding[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: PiiFinding[] = [];
  for (const finding of sorted) {
    const last = kept[kept.length - 1];
    if (last && finding.start < last.end) continue;
    kept.push(finding);
  }
  return kept;
}

export function hasPii(text: string): boolean {
  return scanText(text).length > 0;
}

export const DEFAULT_REDACTION = '[redacted]';

/** Replace every finding in a string. Used by the extension's redaction pass. */
export function redactText(text: string, replacement = DEFAULT_REDACTION): string {
  const findings = scanText(text);
  if (findings.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const finding of findings) {
    out += text.slice(cursor, finding.start) + replacement;
    cursor = finding.end;
  }
  return out + text.slice(cursor);
}

/** Redact only the findings the author selected, addressed by exact match string. */
export function redactMatches(
  text: string,
  matches: readonly string[],
  replacement = DEFAULT_REDACTION,
): string {
  let out = text;
  for (const match of [...matches].sort((a, b) => b.length - a.length)) {
    if (!match) continue;
    out = out.split(match).join(replacement);
  }
  return out;
}
