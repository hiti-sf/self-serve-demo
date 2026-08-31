import type { Manifest } from '@demo-platform/shared';

export interface MobileInterstitialProps {
  manifest: Manifest;
  resolve: (path: string) => string;
  onContinueAnyway: () => void;
}

/**
 * Responsive floor (SPEC §6): below 1024px the guided interaction is not usable, so the
 * visitor gets the same story as a mobile-friendly image walkthrough instead of a broken
 * demo. Full mobile interaction is explicitly out of scope for v1 (§13).
 */
export function MobileInterstitial({
  manifest,
  resolve,
  onContinueAnyway,
}: MobileInterstitialProps): React.ReactElement {
  const orderedSteps = manifest.chapters.flatMap((chapter) =>
    chapter.steps.flatMap((stepId) => {
      const step = manifest.steps.find((candidate) => candidate.stepId === stepId);
      return step ? [{ step, chapter }] : [];
    }),
  );

  return (
    <div className="dp-mobile" style={{ ['--dp-primary' as string]: manifest.theme.primaryColor }}>
      <header className="dp-mobile-header">
        <h1>{manifest.title}</h1>
        <p>
          This interactive demo is best viewed on a desktop screen. Here is the same
          walkthrough as images — or continue anyway.
        </p>
        <button type="button" className="dp-button dp-button--outline" onClick={onContinueAnyway}>
          Continue anyway
        </button>
      </header>

      <ol className="dp-mobile-steps">
        {orderedSteps.map(({ step, chapter }, index) => {
          const caption = step.hotspots[0]?.tooltip;
          return (
            <li key={step.stepId}>
              <span className="dp-mobile-chapter">{chapter.title}</span>
              <h2>
                {index + 1}. {caption?.title || step.stepId}
              </h2>
              {caption?.body ? <p>{caption.body}</p> : null}
              <img src={resolve(step.fallbackImage)} alt={caption?.title ?? `Step ${index + 1}`} loading="lazy" />
            </li>
          );
        })}
      </ol>

      <footer className="dp-mobile-footer">
        <a
          className="dp-button dp-button--primary dp-button--lg"
          href={manifest.endScreen.cta.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          {manifest.endScreen.cta.label}
        </a>
      </footer>
    </div>
  );
}
