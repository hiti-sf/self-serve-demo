/**
 * Public surface of the player.
 *
 * The editor imports this — never a re-implementation (SPEC §7) — and so do both build
 * targets. Anything the editor's live preview needs must be exported here.
 */
export { DemoPlayer } from './DemoPlayer.js';
export type { DemoPlayerProps } from './DemoPlayer.js';
export { SnapshotFrame } from './components/SnapshotFrame.js';
export { HotspotLayer } from './components/HotspotLayer.js';
export { EndScreen } from './components/EndScreen.js';
export { ErrorScreen } from './components/ErrorScreen.js';
export { MobileInterstitial } from './components/MobileInterstitial.js';
export { ProgressBar } from './components/ProgressBar.js';
export { ChapterMenu } from './components/ChapterMenu.js';
export { Tooltip } from './components/Tooltip.js';
export { Beacon } from './components/Beacon.js';

export {
  computeFit,
  fallbackRect,
  placeTooltip,
  toOverlayRect,
  isBelowDesktopFloor,
  DESKTOP_FLOOR_PX,
} from './geometry.js';
export type { Fit, Placement, Rect, Size, TooltipPosition, TooltipPreference } from './geometry.js';

export { loadDemo, loadSnapshotHtml, DemoLoadError } from './loader/loadDemo.js';
export type { DemoBundle } from './loader/loadDemo.js';

export {
  ConsoleTransport,
  HttpTransport,
  MultiTransport,
  NullTransport,
} from './analytics/transport.js';
export type { AnalyticsTransport, HttpTransportOptions } from './analytics/transport.js';
export { EventQueue, QueueTransport, syncQueue } from './analytics/queue.js';
export type { QueuedEvent, SyncResult } from './analytics/queue.js';
export { useAnalytics } from './analytics/useAnalytics.js';
export type { Analytics, UseAnalyticsOptions } from './analytics/useAnalytics.js';

export { useElementSize } from './hooks/useElementSize.js';
export { useKeyboardNav } from './hooks/useKeyboardNav.js';
export { useIdleReset } from './hooks/useIdleReset.js';
