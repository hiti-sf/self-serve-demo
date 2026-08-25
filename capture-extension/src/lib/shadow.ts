import type { CaptureWarning } from '@demo-platform/shared';

/**
 * Shadow roots → declarative shadow DOM (SPEC §5).
 *
 * rrweb faithfully captures open shadow roots, and the rebuild re-creates them by
 * calling `attachShadow`. But a snapshot is serialised with `outerHTML`, and
 * `outerHTML` does not include shadow content — so every web component in the page
 * came out as an empty custom element. Design systems built on shadow DOM would have
 * captured as blank boxes.
 *
 * The fix is to move each shadow root's children into a
 * `<template shadowrootmode="open">` before serialisation. The HTML parser reinstates
 * it as a real shadow root when the player loads the snapshot, with no script involved,
 * which is the only mechanism that satisfies the script-free guarantee.
 *
 * This runs immediately after the rebuild so every later pass — sanitise, resource
 * embedding, PII scan, redaction — sees the content, all of which already descend into
 * `<template>`.
 */
export interface FlattenResult {
  flattened: number;
  warnings: CaptureWarning[];
}

/** `mode` is not exposed on a rebuilt root in every engine; open is the only mode rrweb can capture. */
const SHADOW_MODE = 'open';

export function flattenShadowRoots(doc: Document): FlattenResult {
  const warnings: CaptureWarning[] = [];
  let flattened = 0;

  // Hosts are collected depth-first and processed from the deepest outwards: moving an
  // outer root into a template would otherwise detach inner hosts before their turn,
  // and `querySelectorAll` cannot see into a shadow root to find them again.
  const hosts: Element[] = [];
  const visit = (root: Document | DocumentFragment | Element): void => {
    for (const element of Array.from(root.querySelectorAll('*'))) {
      const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (!shadow) continue;
      hosts.push(element);
      visit(shadow);
    }
  };
  visit(doc);

  for (const host of hosts.reverse()) {
    const shadow = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (!shadow) continue;

    const template = doc.createElement('template');
    template.setAttribute('shadowrootmode', SHADOW_MODE);
    // Chrome ≤ 123 only understood the pre-standard spelling. Carrying both costs a few
    // bytes and means a kiosk laptop on an older browser still renders the component.
    template.setAttribute('shadowroot', SHADOW_MODE);
    while (shadow.firstChild) template.content.append(shadow.firstChild);

    // A declarative template must be the host's first child, and a host that already has
    // light-DOM children keeps them after it — that is how slots find their content.
    host.prepend(template);
    flattened += 1;
  }

  if (flattened > 0) {
    warnings.push({
      kind: 'shadow-dom-flattened',
      detail: `Rewrote ${flattened} shadow root(s) as declarative shadow DOM so they render without script.`,
    });
  }

  return { flattened, warnings };
}
