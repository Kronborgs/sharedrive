import fs from 'node:fs';
import path from 'node:path';
import { getWritableDataDir, getCandidateDataDirs } from './cryptoStore.js';
import { ensureTrailingSlash, canonicalSogoCalendarSignature } from './davClient.js';

export interface UserCalendarPrefs {
  nameOverrides: Record<string, string>;
  colorOverrides: Record<string, string>;
  dismissedSharedCalendars: string[];
}

type AllCalendarPrefs = Record<string, UserCalendarPrefs>;


function normalizePrefsEntry(raw: any): UserCalendarPrefs {
  const nameOverrides: Record<string, string> = {};
  if (raw && typeof raw.nameOverrides === 'object' && raw.nameOverrides !== null) {
    for (const [k, v] of Object.entries(raw.nameOverrides)) {
      if (typeof k === 'string' && typeof v === 'string' && v.trim()) {
        nameOverrides[k] = v.trim();
      }
    }
  }
  const colorOverrides: Record<string, string> = {};
  if (raw && typeof raw.colorOverrides === 'object' && raw.colorOverrides !== null) {
    for (const [k, v] of Object.entries(raw.colorOverrides)) {
      if (typeof k === 'string' && typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())) {
        colorOverrides[k] = v.trim().toLowerCase();
      }
    }
  }
  const dismissedSharedCalendars: string[] = Array.isArray(raw?.dismissedSharedCalendars)
    ? Array.from(
        new Set(
          raw.dismissedSharedCalendars
            .filter((item: unknown): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item: string) => canonicalCalendarPrefKey(item))
        )
      )
    : [];
  return { nameOverrides, colorOverrides, dismissedSharedCalendars };
}

function cloneAllPrefs(data: AllCalendarPrefs): AllCalendarPrefs {
  const copy: AllCalendarPrefs = {};
  for (const [userKey, entry] of Object.entries(data)) {
    copy[userKey] = {
      nameOverrides: { ...entry.nameOverrides },
      colorOverrides: { ...entry.colorOverrides },
      dismissedSharedCalendars: [...entry.dismissedSharedCalendars]
    };
  }
  return copy;
}

function readAllPrefs(): AllCalendarPrefs {
  for (const dir of getCandidateDataDirs()) {
    const filePath = path.join(dir, 'calendar_prefs.json');
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const normalized: AllCalendarPrefs = {};
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof k === 'string' && k.trim()) {
              normalized[k.toLowerCase().trim()] = normalizePrefsEntry(v);
            }
          }
          return cloneAllPrefs(normalized);
        }
      }
    } catch {
      // Ignorér læsefejl
    }
  }
  return {};
}

function writeAllPrefs(data: AllCalendarPrefs): void {
  try {
    const filePath = path.join(getWritableDataDir(), 'calendar_prefs.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Kunne ikke skrive calendar_prefs.json til disk (bevares i hukommelse):', err);
  }
}

function getOrCreateUserPrefs(all: AllCalendarPrefs, username: string): { userKey: string; prefs: UserCalendarPrefs } {
  const userKey = username.toLowerCase().trim();
  if (!all[userKey]) {
    all[userKey] = { nameOverrides: {}, colorOverrides: {}, dismissedSharedCalendars: [] };
  }
  return { userKey, prefs: all[userKey] };
}

export function canonicalCalendarPrefKey(idOrUrl: string): string {
  const raw = (idOrUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(ensureTrailingSlash(raw));
      const decodedPath = u.pathname
        .split('/')
        .map((seg) => {
          try {
            return decodeURIComponent(seg);
          } catch {
            return seg;
          }
        })
        .join('/');
      return `${u.origin.toLowerCase()}${decodedPath.toLowerCase()}`;
    } catch {
      return raw.toLowerCase();
    }
  }
  return raw.toLowerCase();
}

function buildCalendarPrefCandidates(calendarId?: string, calendarUrl?: string): string[] {
  const rawValues = [calendarUrl, calendarId].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  );
  const candidates = new Set<string>();

  for (const val of rawValues) {
    const canon = canonicalCalendarPrefKey(val);
    if (canon) candidates.add(canon);
    const sig = canonicalSogoCalendarSignature(val);
    if (sig) candidates.add(sig);
    candidates.add(val.trim());
  }

  return Array.from(candidates);
}

export function getCalendarNameOverrides(username: string): Record<string, string> {
  const userKey = username.toLowerCase().trim();
  if (!userKey) return {};
  const all = readAllPrefs();
  return all[userKey] ? { ...all[userKey].nameOverrides } : {};
}

export function resolveCalendarNameOverride(
  overrides: Record<string, string>,
  calendarId: string,
  calendarUrl?: string
): string | undefined {
  if (!overrides) return undefined;
  for (const cand of buildCalendarPrefCandidates(calendarId, calendarUrl)) {
    if (overrides[cand]) return overrides[cand];
  }
  return undefined;
}

export function setCalendarNameOverride(
  username: string,
  calendarIdOrUrl: string,
  aliasName: string | null,
  secondaryIdOrUrl?: string
): Record<string, string> {
  const userKey = username.toLowerCase().trim();
  if (!userKey) return {};
  const primaryKey = canonicalCalendarPrefKey(calendarIdOrUrl);
  if (!primaryKey) return getCalendarNameOverrides(username);

  const secondaryKey = secondaryIdOrUrl ? canonicalCalendarPrefKey(secondaryIdOrUrl) : '';
  const primarySig = canonicalSogoCalendarSignature(calendarIdOrUrl) || '';
  const secondarySig = secondaryIdOrUrl ? canonicalSogoCalendarSignature(secondaryIdOrUrl) || '' : '';
  const rawPrimary = calendarIdOrUrl.trim();
  const rawSecondary = secondaryIdOrUrl ? secondaryIdOrUrl.trim() : '';
  const clean = typeof aliasName === 'string' ? aliasName.trim().slice(0, 80) : '';

  const all = readAllPrefs();
  const { prefs } = getOrCreateUserPrefs(all, userKey);

  if (!clean) {
    delete prefs.nameOverrides[primaryKey];
    if (primarySig) delete prefs.nameOverrides[primarySig];
    if (rawPrimary && rawPrimary !== primaryKey) delete prefs.nameOverrides[rawPrimary];
    if (secondaryKey) delete prefs.nameOverrides[secondaryKey];
    if (secondarySig) delete prefs.nameOverrides[secondarySig];
    if (rawSecondary && rawSecondary !== secondaryKey) delete prefs.nameOverrides[rawSecondary];
  } else {
    prefs.nameOverrides[primaryKey] = clean;
    if (primarySig && primarySig !== primaryKey) delete prefs.nameOverrides[primarySig];
    if (rawPrimary && rawPrimary !== primaryKey) delete prefs.nameOverrides[rawPrimary];
    if (secondaryKey && secondaryKey !== primaryKey) delete prefs.nameOverrides[secondaryKey];
    if (secondarySig && secondarySig !== primaryKey) delete prefs.nameOverrides[secondarySig];
    if (rawSecondary && rawSecondary !== primaryKey && rawSecondary !== secondaryKey) {
      delete prefs.nameOverrides[rawSecondary];
    }
  }

  writeAllPrefs(all);
  return { ...prefs.nameOverrides };
}

export function getCalendarColorOverrides(username: string): Record<string, string> {
  const userKey = username.toLowerCase().trim();
  if (!userKey) return {};
  const all = readAllPrefs();
  return all[userKey] ? { ...all[userKey].colorOverrides } : {};
}

export function resolveCalendarColorOverride(
  overrides: Record<string, string>,
  calendarId: string,
  calendarUrl?: string
): string | undefined {
  if (!overrides) return undefined;
  for (const cand of buildCalendarPrefCandidates(calendarId, calendarUrl)) {
    if (overrides[cand]) return overrides[cand];
  }
  return undefined;
}

export function setCalendarColorOverride(
  username: string,
  calendarIdOrUrl: string,
  color: string | null,
  secondaryIdOrUrl?: string
): Record<string, string> {
  const userKey = username.toLowerCase().trim();
  if (!userKey) return {};
  const primaryKey = canonicalCalendarPrefKey(calendarIdOrUrl);
  if (!primaryKey) return getCalendarColorOverrides(username);

  const secondaryKey = secondaryIdOrUrl ? canonicalCalendarPrefKey(secondaryIdOrUrl) : '';
  const primarySig = canonicalSogoCalendarSignature(calendarIdOrUrl) || '';
  const secondarySig = secondaryIdOrUrl ? canonicalSogoCalendarSignature(secondaryIdOrUrl) || '' : '';
  const rawPrimary = calendarIdOrUrl.trim();
  const rawSecondary = secondaryIdOrUrl ? secondaryIdOrUrl.trim() : '';
  const clean =
    typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color.trim())
      ? color.trim().toLowerCase()
      : '';

  const all = readAllPrefs();
  const { prefs } = getOrCreateUserPrefs(all, userKey);

  if (!clean) {
    delete prefs.colorOverrides[primaryKey];
    if (primarySig) delete prefs.colorOverrides[primarySig];
    if (rawPrimary && rawPrimary !== primaryKey) delete prefs.colorOverrides[rawPrimary];
    if (secondaryKey) delete prefs.colorOverrides[secondaryKey];
    if (secondarySig) delete prefs.colorOverrides[secondarySig];
    if (rawSecondary && rawSecondary !== secondaryKey) delete prefs.colorOverrides[rawSecondary];
  } else {
    prefs.colorOverrides[primaryKey] = clean;
    if (primarySig && primarySig !== primaryKey) delete prefs.colorOverrides[primarySig];
    if (rawPrimary && rawPrimary !== primaryKey) delete prefs.colorOverrides[rawPrimary];
    if (secondaryKey && secondaryKey !== primaryKey) delete prefs.colorOverrides[secondaryKey];
    if (secondarySig && secondarySig !== primaryKey) delete prefs.colorOverrides[secondarySig];
    if (rawSecondary && rawSecondary !== primaryKey && rawSecondary !== secondaryKey) {
      delete prefs.colorOverrides[rawSecondary];
    }
  }

  writeAllPrefs(all);
  return { ...prefs.colorOverrides };
}

export function getDismissedSharedCalendars(username: string): string[] {
  const userKey = username.toLowerCase().trim();
  if (!userKey) return [];
  const all = readAllPrefs();
  return all[userKey] ? [...all[userKey].dismissedSharedCalendars] : [];
}

export function isSharedCalendarDismissed(
  username: string,
  calendarId: string,
  calendarUrl?: string
): boolean {
  const dismissed = getDismissedSharedCalendars(username);
  if (dismissed.length === 0) return false;
  const dismissedSet = new Set(dismissed.map((k) => canonicalCalendarPrefKey(k)));
  for (const cand of buildCalendarPrefCandidates(calendarId, calendarUrl)) {
    if (dismissedSet.has(canonicalCalendarPrefKey(cand))) {
      return true;
    }
  }
  return false;
}

export function addDismissedSharedCalendar(username: string, calendarIdOrUrl: string): void {
  const userKey = username.toLowerCase().trim();
  const key = canonicalCalendarPrefKey(calendarIdOrUrl);
  const sig = canonicalSogoCalendarSignature(calendarIdOrUrl);
  if (!userKey || !key) return;

  const all = readAllPrefs();
  const { prefs } = getOrCreateUserPrefs(all, userKey);
  let changed = false;

  if (!prefs.dismissedSharedCalendars.includes(key)) {
    prefs.dismissedSharedCalendars.push(key);
    changed = true;
  }
  if (sig && !prefs.dismissedSharedCalendars.includes(sig)) {
    prefs.dismissedSharedCalendars.push(sig);
    changed = true;
  }

  if (changed) {
    writeAllPrefs(all);
  }
}

export function removeDismissedSharedCalendar(username: string, calendarIdOrUrl: string): void {
  const userKey = username.toLowerCase().trim();
  const key = canonicalCalendarPrefKey(calendarIdOrUrl);
  const sig = canonicalSogoCalendarSignature(calendarIdOrUrl);
  if (!userKey || !key) return;

  const all = readAllPrefs();
  const entry = all[userKey];
  if (!entry) return;

  const targetKeys = new Set([key, ...(sig ? [sig] : [])]);
  const filtered = entry.dismissedSharedCalendars.filter((item) => !targetKeys.has(item));
  if (filtered.length !== entry.dismissedSharedCalendars.length) {
    entry.dismissedSharedCalendars = filtered;
    writeAllPrefs(all);
  }
}

export function removeDismissedSharedCalendarForEmails(
  emails: string[],
  calendarIdOrUrl: string
): void {
  const key = canonicalCalendarPrefKey(calendarIdOrUrl);
  const sig = canonicalSogoCalendarSignature(calendarIdOrUrl);
  const emailSet = new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean));
  if (!key || emailSet.size === 0) return;

  const targetKeys = new Set([key, ...(sig ? [sig] : [])]);
  const all = readAllPrefs();
  let changed = false;

  for (const userKey of Object.keys(all)) {
    if (!emailSet.has(userKey.toLowerCase().trim())) continue;
    const entry = all[userKey];
    const filtered = entry.dismissedSharedCalendars.filter((item) => !targetKeys.has(item));
    if (filtered.length !== entry.dismissedSharedCalendars.length) {
      entry.dismissedSharedCalendars = filtered;
      changed = true;
    }
  }

  if (changed) {
    writeAllPrefs(all);
  }
}

export function clearDismissedSharedCalendars(username: string): void {
  const userKey = username.toLowerCase().trim();
  if (!userKey) return;
  const all = readAllPrefs();
  const entry = all[userKey];
  if (!entry || entry.dismissedSharedCalendars.length === 0) return;
  entry.dismissedSharedCalendars = [];
  writeAllPrefs(all);
}
