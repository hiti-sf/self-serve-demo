import { useState } from 'react';
import { validateLeadInput, validateWorkEmail, type Manifest } from '@demo-platform/shared';

/**
 * Lead gate (SPEC §8.1).
 *
 * The demo sits behind this form, with the first frame blurred behind it — enough to
 * motivate the fill without giving the whole thing away. No analytics event fires until
 * consent is given and the lead is created (§11), which is why this component owns the
 * consent checkbox rather than the player.
 */

export interface GateFormProps {
  manifest: Manifest;
  sessionId: string;
  /** First-frame image, rendered blurred behind the form. */
  previewImageUrl: string;
  privacyUrl: string;
  onUnlocked: (leadId: string) => void;
  /** Injected in tests. */
  submitLead?: (payload: unknown) => Promise<{ leadId?: string; fieldErrors?: Record<string, string>; error?: string }>;
}

const ROLES = [
  'Procurement / Sourcing',
  'Supply chain',
  'Finance',
  'Quality / Regulatory',
  'IT / Digital',
  'Operations',
  'Other',
];

async function postLead(payload: unknown) {
  const response = await fetch('/api/lead', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as { leadId?: string; fieldErrors?: Record<string, string>; error?: string };
}

export function GateForm({
  manifest,
  sessionId,
  previewImageUrl,
  privacyUrl,
  onUnlocked,
  submitLead = postLead,
}: GateFormProps): React.ReactElement {
  const [values, setValues] = useState({
    name: '',
    workEmail: '',
    company: '',
    role: ROLES[0]!,
    // Pre-filled from demo context (§8.1) but editable.
    productInterest: manifest.product,
  });
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (field: keyof typeof values) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setValues((previous) => ({ ...previous, [field]: event.target.value }));
    setErrors((previous) => {
      if (!previous[field]) return previous;
      const { [field]: _removed, ...rest } = previous;
      return rest;
    });
  };

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    const payload = {
      ...values,
      consent,
      demoId: manifest.demoId,
      sessionId,
      referrer: typeof document !== 'undefined' ? document.referrer : '',
    };

    // Validate with the same schema the server uses, so the visitor sees the error
    // before a round trip and the server still has the last word.
    const local = validateLeadInput(payload);
    if (!local.ok) {
      setErrors(local.fieldErrors);
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitLead(payload);
      if (result.leadId) {
        onUnlocked(result.leadId);
        return;
      }
      if (result.fieldErrors) setErrors(result.fieldErrors);
      setFormError(result.error ?? 'Something went wrong. Please try again.');
    } catch {
      setFormError('We could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // Live hint once there is enough to judge, so a free-mail address is caught before
  // the visitor commits to the form.
  const emailCheck = values.workEmail.trim().length > 4 ? validateWorkEmail(values.workEmail) : null;
  const emailHint = emailCheck && !emailCheck.ok ? emailCheck.message : undefined;

  return (
    <div className="gate" style={{ ['--dp-primary' as string]: manifest.theme.primaryColor }}>
      <div
        className="gate-preview"
        style={{ backgroundImage: `url(${previewImageUrl})` }}
        aria-hidden="true"
        data-testid="gate-preview"
      />
      <div className="gate-scrim" aria-hidden="true" />

      <form className="gate-card" onSubmit={onSubmit} noValidate data-testid="gate-form">
        <p className="gate-eyebrow">{manifest.product} · interactive demo</p>
        <h1 className="gate-title">{manifest.title}</h1>
        <p className="gate-sub">{manifest.description}</p>

        <label className="gate-field">
          <span>Full name</span>
          <input value={values.name} onChange={set('name')} autoComplete="name" required />
          {errors.name ? <em>{errors.name}</em> : null}
        </label>

        <label className="gate-field">
          <span>Work email</span>
          <input
            type="email"
            value={values.workEmail}
            onChange={set('workEmail')}
            autoComplete="email"
            required
          />
          {errors.workEmail ?? emailHint ? <em>{errors.workEmail ?? emailHint}</em> : null}
        </label>

        <div className="gate-row">
          <label className="gate-field">
            <span>Company</span>
            <input value={values.company} onChange={set('company')} autoComplete="organization" required />
            {errors.company ? <em>{errors.company}</em> : null}
          </label>

          <label className="gate-field">
            <span>Role</span>
            <select value={values.role} onChange={set('role')}>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="gate-field">
          <span>Product interest</span>
          <input value={values.productInterest} onChange={set('productInterest')} />
        </label>

        <label className="gate-consent">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            data-testid="gate-consent"
          />
          <span>
            I agree that Pivot Path may contact me about {manifest.product} and may record how I use
            this demo, as described in the{' '}
            <a href={privacyUrl} target="_blank" rel="noreferrer noopener">
              privacy notice
            </a>
            .
          </span>
        </label>
        {errors.consent ? <em className="gate-error">{errors.consent}</em> : null}
        {formError ? (
          <p className="gate-error" role="alert">
            {formError}
          </p>
        ) : null}

        <button className="gate-submit" type="submit" disabled={submitting}>
          {submitting ? 'Starting the demo…' : 'Start the demo'}
        </button>
        <p className="gate-note">
          Nothing is recorded until you agree. The demo runs on synthetic data.
        </p>
      </form>
    </div>
  );
}
