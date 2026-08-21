/**
 * Gate state lives in sessionStorage (SPEC §8.1): the visitor should not re-fill the
 * form on a reload, and it should not persist beyond the browser session either.
 */

const KEY_PREFIX = 'demo-gate:';

export interface GateState {
  leadId: string;
  sessionId: string;
}

export function readGateState(demoId: string): GateState | null {
  try {
    const raw = sessionStorage.getItem(`${KEY_PREFIX}${demoId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GateState>;
    if (typeof parsed.leadId !== 'string' || typeof parsed.sessionId !== 'string') return null;
    return { leadId: parsed.leadId, sessionId: parsed.sessionId };
  } catch {
    // Private mode, blocked storage: the visitor sees the gate again, which is
    // annoying but correct. Never let storage break the demo.
    return null;
  }
}

export function writeGateState(demoId: string, state: GateState): void {
  try {
    sessionStorage.setItem(`${KEY_PREFIX}${demoId}`, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function clearGateState(demoId: string): void {
  try {
    sessionStorage.removeItem(`${KEY_PREFIX}${demoId}`);
  } catch {
    /* ignore */
  }
}
