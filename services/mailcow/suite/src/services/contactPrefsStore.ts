import fs from 'node:fs';
import path from 'node:path';
import { getWritableDataDir, getCandidateDataDirs } from './cryptoStore.js';

export interface UserContactPrefs {
  favoriteContacts: string[];
  unstarredOverrides: string[];
  calendarColor?: string;
  birthdayCalendarSyncEnabled?: boolean;
  birthdayCalendarUrl?: string;
  birthdayCalendarLastSyncedAt?: string;
}

type AllContactPrefs = Record<string, UserContactPrefs>;


export function canonicalContactPrefKey(rawId: string): string {
  return rawId.trim().toLowerCase();
}

function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => canonicalContactPrefKey(item))
    )
  );
}

function normalizePrefsEntry(raw: any): UserContactPrefs {
  const rawColor = typeof raw?.calendarColor === 'string' ? raw.calendarColor.trim() : '';
  const calendarColor = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor.toLowerCase() : undefined;
  const birthdayCalendarSyncEnabled =
    typeof raw?.birthdayCalendarSyncEnabled === 'boolean'
      ? raw.birthdayCalendarSyncEnabled
      : undefined;
  const birthdayCalendarUrl =
    typeof raw?.birthdayCalendarUrl === 'string' && raw.birthdayCalendarUrl.trim()
      ? raw.birthdayCalendarUrl.trim()
      : undefined;
  const birthdayCalendarLastSyncedAt =
    typeof raw?.birthdayCalendarLastSyncedAt === 'string' && raw.birthdayCalendarLastSyncedAt.trim()
      ? raw.birthdayCalendarLastSyncedAt.trim()
      : undefined;
  return {
    favoriteContacts: normalizeList(raw?.favoriteContacts),
    unstarredOverrides: normalizeList(raw?.unstarredOverrides),
    ...(calendarColor ? { calendarColor } : {}),
    ...(birthdayCalendarSyncEnabled !== undefined ? { birthdayCalendarSyncEnabled } : {}),
    ...(birthdayCalendarUrl ? { birthdayCalendarUrl } : {}),
    ...(birthdayCalendarLastSyncedAt ? { birthdayCalendarLastSyncedAt } : {})
  };
}

function cloneAllPrefs(data: AllContactPrefs): AllContactPrefs {
  const copy: AllContactPrefs = {};
  for (const [userKey, entry] of Object.entries(data)) {
    copy[userKey] = {
      favoriteContacts: [...entry.favoriteContacts],
      unstarredOverrides: [...entry.unstarredOverrides],
      ...(entry.calendarColor ? { calendarColor: entry.calendarColor } : {}),
      ...(entry.birthdayCalendarSyncEnabled !== undefined
        ? { birthdayCalendarSyncEnabled: entry.birthdayCalendarSyncEnabled }
        : {}),
      ...(entry.birthdayCalendarUrl ? { birthdayCalendarUrl: entry.birthdayCalendarUrl } : {}),
      ...(entry.birthdayCalendarLastSyncedAt
        ? { birthdayCalendarLastSyncedAt: entry.birthdayCalendarLastSyncedAt }
        : {})
    };
  }
  return copy;
}

function readAllPrefs(): AllContactPrefs {
  for (const dir of getCandidateDataDirs()) {
    const filePath = path.join(dir, 'contact_prefs.json');
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const normalized: AllContactPrefs = {};
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

function writeAllPrefs(data: AllContactPrefs): void {
  try {
    const filePath = path.join(getWritableDataDir(), 'contact_prefs.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Kunne ikke skrive contact_prefs.json til disk (bevares i hukommelse):', err);
  }
}

export function getUserContactPrefs(username: string): UserContactPrefs {
  const all = readAllPrefs();
  const userKey = username.toLowerCase().trim();
  return all[userKey] || { favoriteContacts: [], unstarredOverrides: [] };
}

export function setUserContactFavorite(
  username: string,
  contactId: string,
  starred: boolean
): void {
  const key = canonicalContactPrefKey(contactId);
  if (!key) return;
  const all = readAllPrefs();
  const userKey = username.toLowerCase().trim();
  const current = all[userKey] || { favoriteContacts: [], unstarredOverrides: [] };

  const favSet = new Set(current.favoriteContacts);
  const unstarSet = new Set(current.unstarredOverrides);

  if (starred) {
    favSet.add(key);
    unstarSet.delete(key);
  } else {
    favSet.delete(key);
    unstarSet.add(key);
  }

  all[userKey] = {
    ...current,
    favoriteContacts: Array.from(favSet),
    unstarredOverrides: Array.from(unstarSet)
  };
  writeAllPrefs(all);
}

export function setUserContactCalendarColor(username: string, color: string | null): string | null {
  const all = readAllPrefs();
  const userKey = username.toLowerCase().trim();
  const current = all[userKey] || { favoriteContacts: [], unstarredOverrides: [] };
  const clean = typeof color === 'string' ? color.trim().toLowerCase() : '';
  const validColor = /^#[0-9a-f]{6}$/.test(clean) ? clean : undefined;

  const next: UserContactPrefs = {
    ...current,
    favoriteContacts: current.favoriteContacts,
    unstarredOverrides: current.unstarredOverrides
  };
  if (validColor) {
    next.calendarColor = validColor;
  } else {
    delete next.calendarColor;
  }
  all[userKey] = next;
  writeAllPrefs(all);
  return validColor || null;
}

export function setUserBirthdayCalendarSync(
  username: string,
  patch: {
    enabled?: boolean;
    calendarUrl?: string | null;
    lastSyncedAt?: string | null;
  }
): UserContactPrefs {
  const all = readAllPrefs();
  const userKey = username.toLowerCase().trim();
  const current = all[userKey] || { favoriteContacts: [], unstarredOverrides: [] };
  const next: UserContactPrefs = { ...current };

  if (patch.enabled !== undefined) {
    next.birthdayCalendarSyncEnabled = Boolean(patch.enabled);
  }
  if (patch.calendarUrl !== undefined) {
    if (patch.calendarUrl && patch.calendarUrl.trim()) {
      next.birthdayCalendarUrl = patch.calendarUrl.trim();
    } else {
      delete next.birthdayCalendarUrl;
    }
  }
  if (patch.lastSyncedAt !== undefined) {
    if (patch.lastSyncedAt && patch.lastSyncedAt.trim()) {
      next.birthdayCalendarLastSyncedAt = patch.lastSyncedAt.trim();
    } else {
      delete next.birthdayCalendarLastSyncedAt;
    }
  }

  all[userKey] = next;
  writeAllPrefs(all);
  return next;
}

export function clearUserContactUnstarOverride(username: string, contactId: string): void {
  const key = canonicalContactPrefKey(contactId);
  if (!key) return;
  const all = readAllPrefs();
  const userKey = username.toLowerCase().trim();
  const current = all[userKey];
  if (!current) return;
  const nextUnstar = current.unstarredOverrides.filter((k) => k !== key);
  if (nextUnstar.length !== current.unstarredOverrides.length) {
    all[userKey] = {
      ...current,
      favoriteContacts: current.favoriteContacts,
      unstarredOverrides: nextUnstar
    };
    writeAllPrefs(all);
  }
}
