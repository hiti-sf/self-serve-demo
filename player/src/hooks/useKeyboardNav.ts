import { useEffect } from 'react';

export interface KeyboardNavHandlers {
  enabled: boolean;
  onNext: () => void;
  onBack: () => void;
  onToggleChapterMenu: () => void;
  onEscape?: () => void;
}

/**
 * Keyboard navigation (SPEC §6): arrows move through the demo, Esc opens the chapter
 * menu. Bound on the document because focus usually sits inside the snapshot iframe.
 */
export function useKeyboardNav({
  enabled,
  onNext,
  onBack,
  onToggleChapterMenu,
  onEscape,
}: KeyboardNavHandlers): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Never hijack a key the visitor is using to type (the gate form, kiosk admin).
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
          event.preventDefault();
          onNext();
          break;
        case ' ':
        case 'Enter':
          // Space/Enter advance, but not when a control has focus and will handle it.
          if (target && /^(BUTTON|A)$/.test(target.tagName)) return;
          event.preventDefault();
          onNext();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          event.preventDefault();
          onBack();
          break;
        case 'Escape':
          event.preventDefault();
          if (onEscape) onEscape();
          else onToggleChapterMenu();
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled, onBack, onEscape, onNext, onToggleChapterMenu]);
}
