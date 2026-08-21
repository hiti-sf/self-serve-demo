import type { EndScreen as EndScreenConfig, Theme } from '@demo-platform/shared';

export interface EndScreenProps {
  endScreen: EndScreenConfig;
  theme: Theme;
  logoUrl?: string;
  onCtaClick: (label: string, url: string) => void;
  onReplay: () => void;
}

/** Terminal screen with the CTAs the demo exists to earn (SPEC §4). */
export function EndScreen({
  endScreen,
  theme,
  logoUrl,
  onCtaClick,
  onReplay,
}: EndScreenProps): React.ReactElement {
  return (
    <div className="dp-end" style={{ ['--dp-primary' as string]: theme.primaryColor }}>
      <div className="dp-end-card">
        {logoUrl ? <img className="dp-end-logo" src={logoUrl} alt="" /> : null}
        <h1 className="dp-end-headline">{endScreen.headline}</h1>
        {endScreen.body ? <p className="dp-end-body">{endScreen.body}</p> : null}
        <div className="dp-end-actions">
          <a
            className="dp-button dp-button--primary dp-button--lg"
            href={endScreen.cta.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={() => onCtaClick(endScreen.cta.label, endScreen.cta.url)}
          >
            {endScreen.cta.label}
          </a>
          {endScreen.secondaryCta ? (
            <a
              className="dp-button dp-button--outline dp-button--lg"
              href={endScreen.secondaryCta.url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() =>
                onCtaClick(endScreen.secondaryCta!.label, endScreen.secondaryCta!.url)
              }
            >
              {endScreen.secondaryCta.label}
            </a>
          ) : null}
        </div>
        <button type="button" className="dp-button dp-button--ghost" onClick={onReplay}>
          Replay the demo
        </button>
      </div>
    </div>
  );
}
