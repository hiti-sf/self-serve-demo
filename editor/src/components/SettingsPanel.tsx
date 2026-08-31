import type { EndScreen, Settings, Theme } from '@demo-platform/shared';
import type { EditorProject } from '../state/project.js';

export interface SettingsPanelProps {
  project: EditorProject;
  onMeta: (patch: Partial<Pick<EditorProject, 'demoId' | 'product' | 'title' | 'description'>>) => void;
  onTheme: (patch: Partial<Theme>) => void;
  onSettings: (patch: Partial<Settings>) => void;
  onEndScreen: (patch: Partial<EndScreen>) => void;
}

/** Demo metadata, theme, settings and end-screen configuration (SPEC §7). */
export function SettingsPanel({
  project,
  onMeta,
  onTheme,
  onSettings,
  onEndScreen,
}: SettingsPanelProps): React.ReactElement {
  return (
    <div className="settings">
      <section>
        <h3>Demo</h3>
        <div className="field-row">
          <label className="field">
            <span>Demo id (folder name)</span>
            <input value={project.demoId} onChange={(event) => onMeta({ demoId: event.target.value })} />
          </label>
          <label className="field">
            <span>Product</span>
            <input value={project.product} onChange={(event) => onMeta({ product: event.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>Title</span>
          <input value={project.title} onChange={(event) => onMeta({ title: event.target.value })} />
        </label>
        <label className="field">
          <span>Description (shown on the gate)</span>
          <textarea
            rows={3}
            value={project.description}
            onChange={(event) => onMeta({ description: event.target.value })}
          />
        </label>
      </section>

      <section>
        <h3>Theme</h3>
        <div className="field-row">
          <label className="field">
            <span>Primary colour</span>
            <input
              type="color"
              value={project.theme.primaryColor}
              onChange={(event) => onTheme({ primaryColor: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Accent colour</span>
            <input
              type="color"
              value={project.theme.accentColor ?? project.theme.primaryColor}
              onChange={(event) => onTheme({ accentColor: event.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>Logo path (inside the demo folder)</span>
          <input
            value={project.theme.logo ?? ''}
            placeholder="assets/logo.svg"
            onChange={(event) => onTheme({ logo: event.target.value || undefined })}
          />
        </label>
      </section>

      <section>
        <h3>Playback</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={project.settings.gated}
            onChange={(event) => onSettings({ gated: event.target.checked })}
          />
          <span>
            Gate this demo behind the lead form <em>(web only — kiosk builds strip gating)</em>
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={project.settings.showProgress}
            onChange={(event) => onSettings({ showProgress: event.target.checked })}
          />
          <span>Show the progress bar</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={project.settings.showChapterMenu}
            onChange={(event) => onSettings({ showChapterMenu: event.target.checked })}
          />
          <span>Show the chapter menu</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={project.settings.keyboardNav}
            onChange={(event) => onSettings({ keyboardNav: event.target.checked })}
          />
          <span>Allow keyboard navigation</span>
        </label>
      </section>

      <section>
        <h3>End screen</h3>
        <label className="field">
          <span>Headline</span>
          <input
            value={project.endScreen.headline}
            onChange={(event) => onEndScreen({ headline: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Body</span>
          <textarea
            rows={2}
            value={project.endScreen.body ?? ''}
            onChange={(event) => onEndScreen({ body: event.target.value })}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Primary CTA label</span>
            <input
              value={project.endScreen.cta.label}
              onChange={(event) =>
                onEndScreen({ cta: { ...project.endScreen.cta, label: event.target.value } })
              }
            />
          </label>
          <label className="field">
            <span>Primary CTA URL</span>
            <input
              value={project.endScreen.cta.url}
              onChange={(event) => onEndScreen({ cta: { ...project.endScreen.cta, url: event.target.value } })}
            />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Secondary CTA label</span>
            <input
              value={project.endScreen.secondaryCta?.label ?? ''}
              onChange={(event) =>
                onEndScreen({
                  secondaryCta: event.target.value
                    ? { label: event.target.value, url: project.endScreen.secondaryCta?.url ?? '' }
                    : undefined,
                })
              }
            />
          </label>
          <label className="field">
            <span>Secondary CTA URL</span>
            <input
              value={project.endScreen.secondaryCta?.url ?? ''}
              onChange={(event) =>
                onEndScreen({
                  secondaryCta: project.endScreen.secondaryCta
                    ? { ...project.endScreen.secondaryCta, url: event.target.value }
                    : undefined,
                })
              }
            />
          </label>
        </div>
      </section>
    </div>
  );
}
