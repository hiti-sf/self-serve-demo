/**
 * The pulse that tells a prospect where to click (SPEC §6). CSS-only, so it costs
 * nothing on a kiosk laptop and keeps working with JS animations disabled.
 */
export function Beacon(): React.ReactElement {
  return (
    <span className="dp-beacon" aria-hidden="true">
      <span className="dp-beacon-pulse" />
      <span className="dp-beacon-dot" />
    </span>
  );
}
