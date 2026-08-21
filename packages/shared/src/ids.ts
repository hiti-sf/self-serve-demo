/**
 * Id + timestamp helpers. Deliberately dependency-free: these run inside the
 * capture extension, the player, the kiosk bundle and the server routes.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(out);
    return out;
  }
  // Kiosk fallback for exotic runtimes without WebCrypto. Ids are correlation
  // handles, never secrets, so a weaker source is acceptable here.
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function randomId(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[(bytes[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

export function newEventId(): string {
  return `evt_${randomId(20)}`;
}

export function newSessionId(): string {
  return `ses_${randomId(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string, fallback = 'untitled'): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}
