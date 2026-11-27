import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  type CalDavCredentials,
  ensureTrailingSlash,
  assertSameServerOrigin
} from './davClient.js';
import {
  getProviderDataDir as getWritableDataDir,
  getCandidateProviderDirs as getCandidateDataDirs,
  encryptText,
  decryptText
} from './cryptoStore.js';

export type CalendarSharePermission = 'read' | 'write';

export interface UserCalendarShareRecord {
  id: string;
  ownerUsername: string;
  ownerServerUrl: string;
  ownerEncryptedPassword: string;
  calendarUrl: string;
  calendarName: string;
  calendarColor: string;
  recipientEmail: string;
  permission: CalendarSharePermission;
  mode?: 'sogo' | 'suite';
  createdAt: string;
  updatedAt: string;
}

export interface UserCalendarSharePublicInfo {
  id: string;
  ownerUsername: string;
  calendarUrl: string;
  calendarName: string;
  calendarColor: string;
  recipientEmail: string;
  permission: CalendarSharePermission;
  mode?: 'sogo' | 'suite';
  createdAt: string;
  updatedAt: string;
}

const VALID_EMAIL_REGEX =
  /^[^\s@/\\:<>()[\],;"]+@[^\s@/\\:<>()[\],;"]+\.[a-zA-Z0-9-]{2,}$/;


function readAllUserShares(): UserCalendarShareRecord[] {
  for (const dir of getCandidateDataDirs()) {
    const filePath = path.join(dir, 'user_shares.json');
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return [...parsed];
        }
      }
    } catch {
      // Ignorér læsefejl
    }
  }
  return [];
}

function writeAllUserShares(records: UserCalendarShareRecord[]) {
  try {
    const filePath = path.join(getWritableDataDir(), 'user_shares.json');
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
  } catch (err) {
    console.warn('Kunne ikke skrive user_shares.json til disk (bevares i hukommelse):', err);
  }
}

function toPublicInfo(rec: UserCalendarShareRecord): UserCalendarSharePublicInfo {
  return {
    id: rec.id,
    ownerUsername: rec.ownerUsername,
    calendarUrl: rec.calendarUrl,
    calendarName: rec.calendarName,
    calendarColor: rec.calendarColor,
    recipientEmail: rec.recipientEmail,
    permission: rec.permission,
    mode: rec.mode || 'suite',
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt
  };
}

function decodePathnameLower(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/')
    .toLowerCase();
}

function canonicalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(ensureTrailingSlash(rawUrl.trim()));
    return `${u.origin.toLowerCase()}${decodePathnameLower(u.pathname)}`;
  } catch {
    return ensureTrailingSlash(rawUrl.trim()).toLowerCase();
  }
}

export function isUrlInsideSharedCalendar(
  targetUrl: string,
  sharedCalendarUrl: string
): boolean {
  try {
    const targetObj = new URL(targetUrl.trim());
    const calObj = new URL(ensureTrailingSlash(sharedCalendarUrl.trim()));
    if (targetObj.origin.toLowerCase() !== calObj.origin.toLowerCase()) {
      return false;
    }

    const calPath = ensureTrailingSlash(decodePathnameLower(calObj.pathname));
    const targetPath = decodePathnameLower(targetObj.pathname);

    return (
      targetPath === calPath ||
      ensureTrailingSlash(targetPath) === calPath ||
      targetPath.startsWith(calPath)
    );
  } catch {
    return false;
  }
}

export function listOutgoingUserShares(ownerUsername: string): UserCalendarSharePublicInfo[] {
  const ownerLower = ownerUsername.toLowerCase().trim();
  return readAllUserShares()
    .filter((r) => r.mode !== 'sogo' && r.ownerUsername.toLowerCase().trim() === ownerLower)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(toPublicInfo);
}

export function listOutgoingSogoShareHints(ownerUsername: string): UserCalendarSharePublicInfo[] {
  const ownerLower = ownerUsername.toLowerCase().trim();
  return readAllUserShares()
    .filter((r) => r.mode === 'sogo' && r.ownerUsername.toLowerCase().trim() === ownerLower)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(toPublicInfo);
}

export function upsertUserCalendarShare(params: {
  ownerCreds: CalDavCredentials;
  calendarUrl: string;
  calendarName: string;
  calendarColor?: string;
  recipientEmail: string;
  permission: CalendarSharePermission;
}): UserCalendarSharePublicInfo {
  const ownerUsername = params.ownerCreds.username.trim();
  const ownerLower = ownerUsername.toLowerCase();
  const recipientEmail = params.recipientEmail.trim();
  const recipientLower = recipientEmail.toLowerCase();

  if (!recipientEmail || !VALID_EMAIL_REGEX.test(recipientEmail)) {
    throw new Error('Angiv en gyldig modtager e-mailadresse.');
  }

  if (recipientLower === ownerLower) {
    throw new Error('Du kan ikke dele en kalender med dig selv.');
  }

  const permission: CalendarSharePermission = params.permission === 'write' ? 'write' : 'read';
  const calendarUrl = ensureTrailingSlash(params.calendarUrl.trim());
  assertSameServerOrigin(calendarUrl, params.ownerCreds);

  let decodedCalUrl = calendarUrl;
  try {
    decodedCalUrl = decodeURIComponent(calendarUrl);
  } catch {
    decodedCalUrl = calendarUrl;
  }

  const sogoOwnerMatch = decodedCalUrl.match(/\/SOGo\/dav\/([^/]+)\//i);
  if (sogoOwnerMatch && sogoOwnerMatch[1]) {
    const urlOwner = sogoOwnerMatch[1].toLowerCase().trim();
    if (urlOwner !== ownerLower && urlOwner !== ownerLower.split('@')[0]) {
      throw new Error('Du kan kun dele dine egne kalendere med andre brugere.');
    }
  }

  if (/_shared_/i.test(decodedCalUrl) || /\/Calendar\/public(?:\/|$)/i.test(decodedCalUrl)) {
    throw new Error('Delte eller offentlige kalendere kan ikke videredeles.');
  }

  const canonicalCal = canonicalizeUrl(calendarUrl);
  const now = new Date().toISOString();
  const all = readAllUserShares();
  const existingIdx = all.findIndex(
    (r) =>
      r.ownerUsername.toLowerCase().trim() === ownerLower &&
      canonicalizeUrl(r.calendarUrl) === canonicalCal &&
      r.recipientEmail.toLowerCase().trim() === recipientLower
  );

  const safeColor = /^#[0-9a-fA-F]{6}$/.test(params.calendarColor || '')
    ? (params.calendarColor as string)
    : '#2563eb';
  const cleanName = params.calendarName.trim() || 'Delt kalender';

  if (existingIdx >= 0) {
    const updated: UserCalendarShareRecord = {
      ...all[existingIdx],
      ownerServerUrl: params.ownerCreds.serverUrl,
      ownerEncryptedPassword: encryptText(params.ownerCreds.password),
      calendarUrl,
      calendarName: cleanName,
      calendarColor: safeColor,
      permission,
      updatedAt: now
    };
    all[existingIdx] = updated;
    writeAllUserShares(all);
    return toPublicInfo(updated);
  }

  const record: UserCalendarShareRecord = {
    id: crypto.randomUUID(),
    ownerUsername,
    ownerServerUrl: params.ownerCreds.serverUrl,
    ownerEncryptedPassword: encryptText(params.ownerCreds.password),
    calendarUrl,
    calendarName: cleanName,
    calendarColor: safeColor,
    recipientEmail,
    permission,
    createdAt: now,
    updatedAt: now
  };
  all.push(record);
  writeAllUserShares(all);
  return toPublicInfo(record);
}

export function updateUserCalendarSharePermission(
  ownerUsername: string,
  shareId: string,
  permission: CalendarSharePermission
): UserCalendarSharePublicInfo | null {
  const ownerLower = ownerUsername.toLowerCase().trim();
  const cleanId = shareId.trim();
  const all = readAllUserShares();
  const idx = all.findIndex(
    (r) => r.id === cleanId && r.ownerUsername.toLowerCase().trim() === ownerLower
  );
  if (idx === -1) return null;

  all[idx] = {
    ...all[idx],
    permission: permission === 'write' ? 'write' : 'read',
    updatedAt: new Date().toISOString()
  };
  writeAllUserShares(all);
  return toPublicInfo(all[idx]);
}

export function deleteUserCalendarShare(ownerUsername: string, shareId: string): boolean {
  const ownerLower = ownerUsername.toLowerCase().trim();
  const cleanId = shareId.trim();
  const all = readAllUserShares();
  const filtered = all.filter(
    (r) => !(r.id === cleanId && r.ownerUsername.toLowerCase().trim() === ownerLower)
  );
  if (filtered.length === all.length) return false;
  writeAllUserShares(filtered);
  return true;
}

export function removeUserCalendarShareByTarget(
  ownerUsername: string,
  calendarUrl: string,
  recipientEmail: string
): boolean {
  const ownerLower = ownerUsername.toLowerCase().trim();
  const targetCanonical = canonicalizeUrl(calendarUrl);
  const recipLower = recipientEmail.toLowerCase().trim();
  if (!ownerLower || !targetCanonical || !recipLower) return false;

  const all = readAllUserShares();
  const filtered = all.filter(
    (r) =>
      !(
        r.ownerUsername.toLowerCase().trim() === ownerLower &&
        canonicalizeUrl(r.calendarUrl) === targetCanonical &&
        r.recipientEmail.toLowerCase().trim() === recipLower
      )
  );

  if (filtered.length === all.length) return false;
  writeAllUserShares(filtered);
  return true;
}

/**
 * Lader en modtager forlade en delt kalender og fjerner vedkommendes adgangsrettigheder permanent.
 */
export function leaveIncomingUserCalendarShare(
  recipientEmails: string[],
  params: { shareId?: string; calendarUrl?: string }
): { removedCount: number; removedOwners: string[] } {
  const recipientSet = new Set(
    recipientEmails.map((e) => e.toLowerCase().trim()).filter(Boolean)
  );
  if (recipientSet.size === 0) {
    return { removedCount: 0, removedOwners: [] };
  }

  const cleanShareId = (params.shareId || '').trim();
  const targetCanonical = params.calendarUrl ? canonicalizeUrl(params.calendarUrl) : '';
  if (!cleanShareId && !targetCanonical) {
    return { removedCount: 0, removedOwners: [] };
  }

  const all = readAllUserShares();
  const removed: UserCalendarShareRecord[] = [];
  const kept: UserCalendarShareRecord[] = [];

  for (const r of all) {
    const isMyIncomingShare = recipientSet.has(r.recipientEmail.toLowerCase().trim());
    const matchesTarget =
      (cleanShareId && r.id === cleanShareId) ||
      (targetCanonical && canonicalizeUrl(r.calendarUrl) === targetCanonical);

    if (isMyIncomingShare && matchesTarget) {
      removed.push(r);
    } else {
      kept.push(r);
    }
  }

  if (removed.length > 0) {
    writeAllUserShares(kept);
  }

  return {
    removedCount: removed.length,
    removedOwners: Array.from(new Set(removed.map((r) => r.ownerUsername)))
  };
}

export function resolveIncomingSharesForRecipient(
  recipientEmails: string[]
): Array<{ share: UserCalendarSharePublicInfo; ownerCreds: CalDavCredentials }> {
  const recipientSet = new Set(
    recipientEmails.map((e) => e.toLowerCase().trim()).filter(Boolean)
  );
  if (recipientSet.size === 0) return [];

  const byCalendarKey = new Map<
    string,
    { share: UserCalendarSharePublicInfo; ownerCreds: CalDavCredentials }
  >();

  for (const rec of readAllUserShares()) {
    if (rec.mode === 'sogo' || !rec.ownerEncryptedPassword) {
      continue;
    }
    const recRecipient = rec.recipientEmail.toLowerCase().trim();
    const recOwner = rec.ownerUsername.toLowerCase().trim();
    if (!recipientSet.has(recRecipient) || recipientSet.has(recOwner)) {
      continue;
    }

    try {
      const password = decryptText(rec.ownerEncryptedPassword);
      const entry = {
        share: toPublicInfo(rec),
        ownerCreds: {
          serverUrl: rec.ownerServerUrl,
          username: rec.ownerUsername,
          password
        }
      };

      const key = canonicalizeUrl(rec.calendarUrl);
      const existing = byCalendarKey.get(key);
      if (!existing || (existing.share.permission !== 'write' && entry.share.permission === 'write')) {
        byCalendarKey.set(key, entry);
      }
    } catch {
      // Ignorér ugyldig eller udløbet kryptering
    }
  }

  return Array.from(byCalendarKey.values());
}

export function findAuthorizedIncomingShareForUrl(
  recipientEmails: string[],
  targetUrl: string
): { share: UserCalendarSharePublicInfo; ownerCreds: CalDavCredentials } | null {
  const incoming = resolveIncomingSharesForRecipient(recipientEmails);
  let bestMatch: { share: UserCalendarSharePublicInfo; ownerCreds: CalDavCredentials } | null = null;

  for (const item of incoming) {
    if (!isUrlInsideSharedCalendar(targetUrl, item.share.calendarUrl)) {
      continue;
    }
    if (
      !bestMatch ||
      (bestMatch.share.permission !== 'write' && item.share.permission === 'write')
    ) {
      bestMatch = item;
    }
  }

  return bestMatch;
}

export function refreshUserShareOwnerPassword(
  ownerUsername: string,
  newPassword: string
): void {
  const ownerLower = ownerUsername.toLowerCase().trim();
  if (!ownerLower || !newPassword) return;
  const all = readAllUserShares();
  const now = new Date().toISOString();
  let changed = false;

  const updated = all.map((r) => {
    if (r.ownerUsername.toLowerCase().trim() === ownerLower && r.mode !== 'sogo') {
      changed = true;
      return {
        ...r,
        ownerEncryptedPassword: encryptText(newPassword),
        updatedAt: now
      };
    }
    return r;
  });

  if (changed) {
    writeAllUserShares(updated);
  }
}

/**
 * Gemmer/opdaterer en kodeordsfri opdagelseshint til modtager ved direkte SOGo-deling.
 */
export function upsertSogoShareHint(params: {
  ownerUsername: string;
  ownerServerUrl: string;
  calendarUrl: string;
  calendarName: string;
  calendarColor?: string;
  recipientEmail: string;
  permission: CalendarSharePermission;
}): void {
  const ownerUsername = params.ownerUsername.trim();
  const ownerLower = ownerUsername.toLowerCase();
  const recipientEmail = params.recipientEmail.trim();
  const recipientLower = recipientEmail.toLowerCase();
  if (!ownerUsername || !recipientEmail) return;

  const calendarUrl = ensureTrailingSlash(params.calendarUrl.trim());
  const canonicalCal = canonicalizeUrl(calendarUrl);
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(params.calendarColor || '')
    ? (params.calendarColor as string)
    : '#2563eb';
  const cleanName = params.calendarName.trim() || 'Delt kalender';
  const permission: CalendarSharePermission = params.permission === 'write' ? 'write' : 'read';
  const now = new Date().toISOString();

  const all = readAllUserShares().filter(
    (r) =>
      !(
        r.ownerUsername.toLowerCase().trim() === ownerLower &&
        canonicalizeUrl(r.calendarUrl) === canonicalCal &&
        r.recipientEmail.toLowerCase().trim() === recipientLower
      )
  );

  all.push({
    id: crypto.randomUUID(),
    ownerUsername,
    ownerServerUrl: params.ownerServerUrl,
    ownerEncryptedPassword: '',
    calendarUrl,
    calendarName: cleanName,
    calendarColor: safeColor,
    recipientEmail,
    permission,
    mode: 'sogo',
    createdAt: now,
    updatedAt: now
  });

  writeAllUserShares(all);
}

export function updateSogoShareHintPermission(
  ownerUsername: string,
  calendarUrl: string,
  recipientEmail: string,
  permission: CalendarSharePermission
): void {
  const ownerLower = ownerUsername.toLowerCase().trim();
  const targetCanonical = canonicalizeUrl(calendarUrl);
  const recipLower = recipientEmail.toLowerCase().trim();
  if (!ownerLower || !targetCanonical || !recipLower) return;

  const all = readAllUserShares();
  const now = new Date().toISOString();
  let changed = false;

  const updated = all.map((r) => {
    if (
      r.mode === 'sogo' &&
      r.ownerUsername.toLowerCase().trim() === ownerLower &&
      canonicalizeUrl(r.calendarUrl) === targetCanonical &&
      r.recipientEmail.toLowerCase().trim() === recipLower
    ) {
      changed = true;
      return {
        ...r,
        permission: permission === 'write' ? ('write' as const) : ('read' as const),
        updatedAt: now
      };
    }
    return r;
  });

  if (changed) {
    writeAllUserShares(updated);
  }
}

export function resolveIncomingSogoHintsForRecipient(
  recipientEmails: string[]
): UserCalendarSharePublicInfo[] {
  const recipientSet = new Set(
    recipientEmails.map((e) => e.toLowerCase().trim()).filter(Boolean)
  );
  if (recipientSet.size === 0) return [];

  const byCalendarKey = new Map<string, UserCalendarSharePublicInfo>();
  for (const rec of readAllUserShares()) {
    if (rec.mode !== 'sogo') continue;
    const recRecipient = rec.recipientEmail.toLowerCase().trim();
    const recOwner = rec.ownerUsername.toLowerCase().trim();
    if (!recipientSet.has(recRecipient) || recipientSet.has(recOwner)) {
      continue;
    }

    const key = canonicalizeUrl(rec.calendarUrl);
    const info = toPublicInfo(rec);
    const existing = byCalendarKey.get(key);
    if (!existing || (existing.permission !== 'write' && info.permission === 'write')) {
      byCalendarKey.set(key, info);
    }
  }

  return Array.from(byCalendarKey.values());
}
