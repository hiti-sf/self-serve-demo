import type { DemoIndex } from './config.js';

export interface DemoPickerProps {
  index: DemoIndex;
  kioskLabel: string;
  onSelect: (path: string) => void;
  onOpenAdmin: () => void;
}

/**
 * Demo selection screen — the kiosk's home, and where the attract loop returns to
 * (SPEC §8.2).
 */
export function DemoPicker({ index, kioskLabel, onSelect, onOpenAdmin }: DemoPickerProps): React.ReactElement {
  const byProduct = new Map<string, DemoIndex['demos']>();
  for (const demo of index.demos) {
    byProduct.set(demo.product, [...(byProduct.get(demo.product) ?? []), demo]);
  }

  return (
    <div className="kiosk">
      <header className="kiosk-header">
        <p className="kiosk-eyebrow">Pivot Path</p>
        <h1>See the product, not the slides</h1>
        <p className="kiosk-sub">
          Pick a workflow. Every demo runs entirely on this machine — no network needed.
        </p>
      </header>

      <main className="kiosk-grid">
        {[...byProduct.entries()].map(([product, demos]) => (
          <section key={product} className="kiosk-product">
            <h2>{product}</h2>
            <ul>
              {demos.map((demo) => (
                <li key={demo.demoId}>
                  <button type="button" className="kiosk-card" onClick={() => onSelect(demo.path)}>
                    <span className="kiosk-card-title">{demo.title}</span>
                    <span className="kiosk-card-desc">{demo.description}</span>
                    <span className="kiosk-card-cta">Start →</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {index.demos.length === 0 ? (
          <p className="kiosk-empty">
            This bundle contains no demos. Rebuild it with <code>--demo &lt;id&gt;</code> or{' '}
            <code>--all</code>.
          </p>
        ) : null}
      </main>

      <footer className="kiosk-footer">
        <span>
          {kioskLabel ? `${kioskLabel} · ` : ''}
          {index.demos.length} demo{index.demos.length === 1 ? '' : 's'} on this machine
          {index.buildId ? ` · build ${index.buildId}` : ''}
        </span>
        {/* Admin corner: deliberately unlabelled so a visitor never finds it (§8.2). */}
        <button
          type="button"
          className="kiosk-admin-corner"
          onClick={onOpenAdmin}
          aria-label="Kiosk admin"
          title=""
        />
      </footer>
    </div>
  );
}
