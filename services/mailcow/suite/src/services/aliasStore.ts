import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getWritableDataDir, getCandidateDataDirs } from './cryptoStore.js';

export interface SenderAliasRecord {
  id: string;
  email: string;
  displayName: string;
  signature: string;
  isDefault: boolean;
  source?: 'primary' | 'mailcow' | 'manual';
  createdAt: string;
}

interface UserAliasesFile {
  [usernameLower: string]: SenderAliasRecord[];
}

interface DismissedAliasesFile {
  [usernameLower: string]: string[];
}

function readAllAliases(): UserAliasesFile {
  for (const dir of getCandidateDataDirs()) {
    const aliasesFile = path.join(dir, 'aliases.json');
    try {
      if (fs.existsSync(aliasesFile)) {
        const raw = fs.readFileSync(aliasesFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return parsed as UserAliasesFile;
        }
      }
    } catch {
      // Prøv næste mappe
    }
  }
  return {};
}

function writeAllAliases(data: UserAliasesFile) {
  try {
    const aliasesFile = path.join(getWritableDataDir(), 'aliases.json');
    fs.writeFileSync(aliasesFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Kunne ikke skrive aliases.json til disk:', err);
  }
}

function readAllDismissedAliases(): DismissedAliasesFile {
  for (const dir of getCandidateDataDirs()) {
    const file = path.join(dir, 'aliases_dismissed.json');
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return parsed as DismissedAliasesFile;
        }
      }
    } catch {
      // Prøv næste mappe
    }
  }
  return {};
}

function writeAllDismissedAliases(data: DismissedAliasesFile) {
  try {
    const file = path.join(getWritableDataDir(), 'aliases_dismissed.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Kunne ikke skrive aliases_dismissed.json til disk:', err);
  }
}

function addDismissedAlias(usernameLower: string, emailLower: string) {
  const all = readAllDismissedAliases();
  const list = Array.isArray(all[usernameLower]) ? all[usernameLower] : [];
  if (!list.includes(emailLower)) {
    all[usernameLower] = [...list, emailLower];
    writeAllDismissedAliases(all);
  }
}

function removeDismissedAlias(usernameLower: string, emailLower: string) {
  const all = readAllDismissedAliases();
  const list = Array.isArray(all[usernameLower]) ? all[usernameLower] : [];
  if (list.includes(emailLower)) {
    all[usernameLower] = list.filter((e) => e !== emailLower);
    writeAllDismissedAliases(all);
  }
}

function clearDismissedAliases(usernameLower: string) {
  const all = readAllDismissedAliases();
  if (Array.isArray(all[usernameLower]) && all[usernameLower].length > 0) {
    delete all[usernameLower];
    writeAllDismissedAliases(all);
  }
}

const VALID_ALIAS_EMAIL_REGEX =
  /^[^\s@/\\:<>()[\],;"]+@[^\s@/\\:<>()[\],;"]+\.[a-zA-Z0-9-]{2,}$/;

export function getAliasesForUser(username: string): SenderAliasRecord[] {
  const key = username.toLowerCase().trim();
  const all = readAllAliases();
  const rawList = Array.isArray(all[key]) ? all[key] : [];

  // Fjern eventuelle tidligere gemte ugyldige poster (f.eks. "/SOGo/dav/...")
  let list = rawList.filter((a) => VALID_ALIAS_EMAIL_REGEX.test(String(a?.email || '').trim()));
  let changed = list.length !== rawList.length;

  const hasPrimary = list.some((a) => a.email.toLowerCase().trim() === key);
  if (!hasPrimary && VALID_ALIAS_EMAIL_REGEX.test(username.trim())) {
    const primaryAlias: SenderAliasRecord = {
      id: `primary::${key}`,
      email: username.trim(),
      displayName: '',
      signature: '',
      isDefault: list.length === 0,
      source: 'primary',
      createdAt: new Date().toISOString()
    };
    list = [primaryAlias, ...list];
    changed = true;
  }

  if (list.length > 0 && !list.some((a) => a.isDefault)) {
    list[0] = { ...list[0], isDefault: true };
    changed = true;
  }

  if (changed) {
    all[key] = list;
    writeAllAliases(all);
  }

  return list;
}

export function upsertAliasForUser(
  username: string,
  input: {
    id?: string;
    email: string;
    displayName?: string;
    signature?: string;
    isDefault?: boolean;
  }
): SenderAliasRecord[] {
  const key = username.toLowerCase().trim();
  const emailClean = input.email.trim();
  const emailLower = emailClean.toLowerCase();
  if (!emailClean || !VALID_ALIAS_EMAIL_REGEX.test(emailClean)) {
    throw new Error('Ugyldig e-mailadresse for alias.');
  }

  removeDismissedAlias(key, emailLower);

  const all = readAllAliases();
  let list = getAliasesForUser(username);

  const existingIdx = list.findIndex(
    (a) =>
      (input.id && a.id === input.id) ||
      a.email.toLowerCase().trim() === emailLower
  );

  const shouldBeDefault = Boolean(input.isDefault) || list.length === 0;
  if (shouldBeDefault) {
    list = list.map((a) => ({ ...a, isDefault: false }));
  }

  if (existingIdx >= 0) {
    const existing = list[existingIdx];
    list[existingIdx] = {
      ...existing,
      email: emailClean,
      displayName: input.displayName !== undefined ? input.displayName.trim() : existing.displayName,
      signature: input.signature !== undefined ? input.signature : existing.signature,
      isDefault: shouldBeDefault ? true : existing.isDefault,
      source: existing.source || (emailLower === key ? 'primary' : 'manual')
    };
  } else {
    const record: SenderAliasRecord = {
      id: crypto.randomUUID(),
      email: emailClean,
      displayName: (input.displayName || '').trim(),
      signature: input.signature || '',
      isDefault: shouldBeDefault,
      source: emailLower === key ? 'primary' : 'manual',
      createdAt: new Date().toISOString()
    };
    list.push(record);
  }

  if (!list.some((a) => a.isDefault) && list.length > 0) {
    list[0].isDefault = true;
  }

  all[key] = list;
  writeAllAliases(all);
  return list;
}

export function deleteAliasForUser(username: string, aliasId: string): SenderAliasRecord[] {
  const key = username.toLowerCase().trim();
  const all = readAllAliases();
  let list = getAliasesForUser(username);

  const target = list.find((a) => a.id === aliasId);
  if (!target) {
    return list;
  }

  if (target.email.toLowerCase().trim() === key && list.length <= 1) {
    throw new Error('Hovedadressen kan ikke fjernes, når der ikke er andre aliaser.');
  }

  if (target.source === 'mailcow') {
    addDismissedAlias(key, target.email.toLowerCase().trim());
  }

  list = list.filter((a) => a.id !== aliasId);
  if (!list.some((a) => a.isDefault) && list.length > 0) {
    list[0].isDefault = true;
  }

  all[key] = list;
  writeAllAliases(all);
  return list;
}

export function mergeDiscoveredAliasesForUser(
  username: string,
  discovered: { emails: string[]; displayName?: string },
  options?: { clearDismissed?: boolean }
): SenderAliasRecord[] {
  const key = username.toLowerCase().trim();
  if (options?.clearDismissed) {
    clearDismissedAliases(key);
  }

  const allDismissed = readAllDismissedAliases();
  const dismissedSet = new Set(
    (Array.isArray(allDismissed[key]) ? allDismissed[key] : []).map((e) => e.toLowerCase().trim())
  );

  const all = readAllAliases();
  let list = getAliasesForUser(username).map((a) => ({ ...a }));
  let changed = false;

  const cleanDisplayName = (discovered.displayName || '').trim();
  if (cleanDisplayName) {
    const primaryIdx = list.findIndex((a) => a.email.toLowerCase().trim() === key);
    if (primaryIdx >= 0 && !list[primaryIdx].displayName) {
      list[primaryIdx].displayName = cleanDisplayName;
      if (!list[primaryIdx].source) {
        list[primaryIdx].source = 'primary';
      }
      changed = true;
    }
  }

  for (const rawEmail of discovered.emails || []) {
    const emailClean = rawEmail.trim();
    const emailLower = emailClean.toLowerCase();
    if (!emailClean || !VALID_ALIAS_EMAIL_REGEX.test(emailClean)) {
      continue;
    }

    const existingIdx = list.findIndex((a) => a.email.toLowerCase().trim() === emailLower);
    if (existingIdx >= 0) {
      const existing = list[existingIdx];
      if (!existing.source) {
        list[existingIdx].source = emailLower === key ? 'primary' : 'mailcow';
        changed = true;
      }
      if (!existing.displayName && cleanDisplayName) {
        list[existingIdx].displayName = cleanDisplayName;
        changed = true;
      }
      continue;
    }

    if (dismissedSet.has(emailLower)) {
      continue;
    }

    list.push({
      id: `mailcow::${emailLower}`,
      email: emailClean,
      displayName: cleanDisplayName,
      signature: '',
      isDefault: false,
      source: 'mailcow',
      createdAt: new Date().toISOString()
    });
    changed = true;
  }

  if (changed) {
    all[key] = list;
    writeAllAliases(all);
  }

  return list;
}

export function findUsernamesOwningEmail(email: string): string[] {
  const target = (email || '').toLowerCase().trim();
  if (!target) return [];
  const all = readAllAliases();
  const owners = new Set<string>([target]);

  for (const [usernameLower, list] of Object.entries(all)) {
    const cleanOwner = usernameLower.toLowerCase().trim();
    if (!cleanOwner) continue;
    if (
      cleanOwner === target ||
      (Array.isArray(list) &&
        list.some((a) => String(a?.email || '').toLowerCase().trim() === target))
    ) {
      owners.add(cleanOwner);
    }
  }

  return Array.from(owners);
}
