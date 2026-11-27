import { reactive, ref } from 'vue';
import { suiteStorage } from '../sharedrive-storage';
import type { Contact } from '../types/contacts';

const avatarPreferenceKey = 'gravatar-profile-pictures';
const gravatarPreference = ref<boolean>();

export function gravatarEnabled() {
  return gravatarPreference.value ?? suiteStorage.getItem(avatarPreferenceKey) === 'true';
}

export function setGravatarEnabled(enabled: boolean) {
  gravatarPreference.value = enabled;
  suiteStorage.setItem(avatarPreferenceKey, String(enabled));
}

const FAILED_STORAGE_KEY = 'brogaard_gravatar_404_v1';

function loadInitialFailedSet(): Set<string> {
  try {
    const raw = sessionStorage.getItem(FAILED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

const failedGravatarUrls = reactive<Set<string>>(loadInitialFailedSet());
const resolvedHashCache = reactive<Record<string, string>>({});
const pendingHashes = new Set<string>();

// Kompakt, ren SHA-256 fallback til miljøer uden WebCrypto (f.eks. ren HTTP uden TLS)
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256HexSync(asciiOrUtf8: string): string {
  const bytes = new TextEncoder().encode(asciiOrUtf8);
  const bitLen = bytes.length * 8;
  const totalLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('');
}

function getEmailSha256(normalizedEmail: string): string {
  const cached = resolvedHashCache[normalizedEmail];
  if (cached) return cached;

  // Hvis WebCrypto er tilgængelig, verificér/beregn også via browserens native motor, men returnér synkront straks
  const syncHash = sha256HexSync(normalizedEmail);
  resolvedHashCache[normalizedEmail] = syncHash;

  if (typeof crypto !== 'undefined' && crypto.subtle && !pendingHashes.has(normalizedEmail)) {
    pendingHashes.add(normalizedEmail);
    const data = new TextEncoder().encode(normalizedEmail);
    void crypto.subtle
      .digest('SHA-256', data)
      .then((buf) => {
        const hex = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        resolvedHashCache[normalizedEmail] = hex;
      })
      .catch(() => {})
      .finally(() => {
        pendingHashes.delete(normalizedEmail);
      });
  }

  return syncHash;
}

export function getGravatarAvatarUrlForEmail(email?: string, size = 160): string | null {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return null;

  const hash = getEmailSha256(normalized);
  const url = `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
  if (failedGravatarUrls.has(url)) return null;
  return url;
}

export function resolveContactAvatarSrc(
  contact: Pick<Contact, 'photoDataUrl' | 'emails'>,
  size = 160
): string | null {
  if (contact.photoDataUrl) return contact.photoDataUrl;
  if (!gravatarEnabled()) return null;
  for (const em of contact.emails || []) {
    const url = getGravatarAvatarUrlForEmail(em.value, size);
    if (url) return url;
  }
  return null;
}

export function markGravatarFailed(url?: string | null): void {
  if (!url || !url.startsWith('https://www.gravatar.com/avatar/')) return;
  failedGravatarUrls.add(url);
  try {
    sessionStorage.setItem(FAILED_STORAGE_KEY, JSON.stringify(Array.from(failedGravatarUrls)));
  } catch {
    // Ignorér kvote-fejl i sessionStorage
  }
}
