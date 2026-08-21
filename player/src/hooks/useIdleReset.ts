import { useEffect, useRef } from 'react';

/**
 * Kiosk attract loop (SPEC §8.2): after `idleMs` with no interaction, return to the demo
 * selection screen so the next visitor at the booth starts from the top.
 */
export function useIdleReset(idleMs: number, onIdle: () => void): void {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (idleMs <= 0 || typeof window === 'undefined') return;

    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => onIdleRef.current(), idleMs);
    };

    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const event of events) window.addEventListener(event, reset, { passive: true });
    reset();

    return () => {
      clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, reset);
    };
  }, [idleMs]);
}
