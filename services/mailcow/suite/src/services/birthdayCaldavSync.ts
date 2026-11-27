import crypto from 'node:crypto';
import ICAL from 'ical.js';
import {
  type CalDavCredentials,
  type CalendarInfoDTO,
  buildSogoUserCalendarHomeUrl,
  canonicalCalendarKey,
  createCalDavCalendar,
  davRequest,
  deleteCalDavCalendar,
  ensureTrailingSlash,
  escapeXml,
  fetchOwnCalendarsFast,
  invalidateUserEventCache,
  readResponseTextSmart,
  updateCalDavCalendarColor
} from './davClient.js';
import { fetchAddressBooks, fetchAllContacts } from './carddavClient.js';
import {
  getUserContactPrefs,
  setUserBirthdayCalendarSync
} from './contactPrefsStore.js';
import { normalizeDanishText } from './icalMapper.js';

export const BIRTHDAY_CALENDAR_SLUG = 'brogaard-birthdays';
export const BIRTHDAY_CALENDAR_DEFAULT_NAME = 'Fødselsdage & Mærkedage';
export const DEFAULT_BIRTHDAY_CALENDAR_COLOR = '#ec4899';

export interface BirthdaySyncResult {
  synced: boolean;
  skipped?: boolean;
  calendarUrl: string | null;
  totalContactsEvents: number;
  createdOrUpdated: number;
  deleted: number;
  unchanged: number;
  lastSyncedAt: string | null;
}

export function isBrogaardBirthdayCalendarUrl(calUrl: string, savedUrl?: string): boolean {
  if (!calUrl) return false;
  if (savedUrl && canonicalCalendarKey(calUrl) === canonicalCalendarKey(savedUrl)) {
    return true;
  }
  try {
    const decoded = decodeURIComponent(calUrl);
    return /\/Calendar\/brogaard-birthdays\/?$/i.test(decoded);
  } catch {
    return /\/Calendar\/brogaard-birthdays\/?$/i.test(calUrl);
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function extractFirstName(firstName?: string, fullName?: string): string {
  const fromFirst = (firstName || '').trim().split(/\s+/).filter(Boolean)[0];
  if (fromFirst) return fromFirst;
  const fromFull = (fullName || '').trim().split(/\s+/).filter(Boolean)[0];
  return fromFull || 'Kontakt';
}

function addOneDayDateOnly(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate()
  ).padStart(2, '0')}`;
}

function sanitizeUidSegment(rawUid: string): string {
  const clean = rawUid.trim().replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (clean) return clean;
  return crypto.createHash('sha256').update(rawUid || String(Date.now())).digest('hex').slice(0, 16);
}

interface DesiredBirthdayEvent {
  uid: string;
  hash: string;
  ics: string;
}

function buildRollingSpecialDateEvents(params: {
  uidPrefix: string;
  firstName: string;
  fullName: string;
  rawDate: string;
  kind: 'birthday' | 'anniversary';
  customLabel?: string;
}): DesiredBirthdayEvent[] {
  const match = params.rawDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return [];

  const parsedYear = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return [];

  const currentYear = new Date().getFullYear();
  const hasOriginYear = parsedYear >= 1900 && parsedYear <= currentYear + 5;
  const label = (params.customLabel || 'Bryllupsdag').trim() || 'Bryllupsdag';
  const formattedOriginDate = `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${hasOriginYear ? parsedYear : ''}`.replace(/-$/, '');

  const events: DesiredBirthdayEvent[] = [];
  for (let y = currentYear - 1; y <= currentYear + 5; y++) {
    const effDay = month === 2 && day === 29 && !isLeapYear(y) ? 28 : day;
    const startYmd = `${String(y).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(effDay).padStart(2, '0')}`;
    const endYmd = addOneDayDateOnly(startYmd);

    const diffYears = hasOriginYear ? y - parsedYear : -1;
    const yearsSuffix = diffYears > 0 && diffYears <= 130 ? ` (${diffYears} år)` : '';

    const summary =
      params.kind === 'birthday'
        ? `🎂 ${params.firstName}${yearsSuffix}`
        : `💍 ${params.firstName} – ${label}${yearsSuffix}`;

    const description =
      params.kind === 'birthday'
        ? `Fødselsdag for ${params.fullName}${hasOriginYear ? ` (${formattedOriginDate})` : ''} — auto-synkroniseret fra Sharedrive Kontakter.`
        : `${label} for ${params.fullName}${hasOriginYear ? ` (${formattedOriginDate})` : ''} — auto-synkroniseret fra Sharedrive Kontakter.`;

    const uid = `${params.uidPrefix}-${y}`;
    const hashPayload = JSON.stringify({
      uid,
      summary,
      description,
      startYmd
    });
    const hash = crypto.createHash('sha256').update(hashPayload, 'utf8').digest('hex').slice(0, 16);

    const vcalendar = new ICAL.Component(['vcalendar', [], []]);
    vcalendar.updatePropertyWithValue('prodid', '-//Sharedrive//Kontakt Kalender Sync//DA');
    vcalendar.updatePropertyWithValue('version', '2.0');
    vcalendar.updatePropertyWithValue('calscale', 'GREGORIAN');

    const vevent = new ICAL.Component('vevent');
    const nowStamp = ICAL.Time.fromJSDate(new Date(), true);
    vevent.updatePropertyWithValue('uid', uid);
    vevent.updatePropertyWithValue('dtstamp', nowStamp);
    vevent.updatePropertyWithValue('last-modified', nowStamp);
    vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromDateString(startYmd));
    vevent.updatePropertyWithValue('dtend', ICAL.Time.fromDateString(endYmd));
    vevent.updatePropertyWithValue('summary', summary);
    vevent.updatePropertyWithValue('description', description);
    vevent.updatePropertyWithValue('transp', 'TRANSPARENT');
    vevent.updatePropertyWithValue('categories', params.kind === 'birthday' ? 'Fødselsdag' : 'Mærkedag');
    vevent.updatePropertyWithValue('x-brogaard-managed', 'TRUE');
    vevent.updatePropertyWithValue('x-brogaard-kind', params.kind);
    vevent.updatePropertyWithValue('x-brogaard-name', params.fullName);
    if (params.kind === 'anniversary') {
      vevent.updatePropertyWithValue('x-brogaard-label', label);
    }
    if (hasOriginYear) {
      vevent.updatePropertyWithValue('x-brogaard-origin-year', String(parsedYear));
    }
    vevent.updatePropertyWithValue('x-brogaard-hash', hash);

    vcalendar.addSubcomponent(vevent);
    events.push({
      uid,
      hash,
      ics: vcalendar.toString()
    });
  }

  return events;
}

async function ensureBirthdayCalDavCalendar(
  creds: CalDavCredentials,
  color: string
): Promise<CalendarInfoDTO> {
  const prefs = getUserContactPrefs(creds.username);
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(color.trim())
    ? color.trim().toLowerCase()
    : DEFAULT_BIRTHDAY_CALENDAR_COLOR;

  const ownCals = await fetchOwnCalendarsFast(creds).catch(() => []);
  const existing = ownCals.find((c) =>
    isBrogaardBirthdayCalendarUrl(c.url, prefs.birthdayCalendarUrl)
  );
  if (existing) {
    if (existing.color?.toLowerCase() !== safeColor) {
      await updateCalDavCalendarColor(creds, existing.url, safeColor).catch(() => {});
      existing.color = safeColor;
      existing.serverColor = safeColor;
    }
    setUserBirthdayCalendarSync(creds.username, { calendarUrl: existing.url });
    return {
      ...existing,
      isContactBirthdays: true
    };
  }

  const home = buildSogoUserCalendarHomeUrl(creds.serverUrl, creds.username);
  const slugUrl = `${home}${BIRTHDAY_CALENDAR_SLUG}/`;
  const mkBody = `<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <D:set>
    <D:prop>
      <D:displayname>${escapeXml(BIRTHDAY_CALENDAR_DEFAULT_NAME)}</D:displayname>
      <A:calendar-color>${safeColor}FF</A:calendar-color>
      <C:supported-calendar-component-set>
        <C:comp name="VEVENT"/>
      </C:supported-calendar-component-set>
    </D:prop>
  </D:set>
</C:mkcalendar>`;

  let createdCal: CalendarInfoDTO;
  try {
    await davRequest(creds, 'MKCALENDAR', slugUrl, mkBody, {
      'Content-Type': 'application/xml; charset=utf-8'
    });
    createdCal = {
      id: slugUrl,
      url: slugUrl,
      name: BIRTHDAY_CALENDAR_DEFAULT_NAME,
      color: safeColor,
      serverColor: safeColor,
      readOnly: true,
      isShared: false,
      isContactBirthdays: true
    };
  } catch {
    const fallback = await createCalDavCalendar(creds, BIRTHDAY_CALENDAR_DEFAULT_NAME, safeColor);
    createdCal = {
      ...fallback,
      readOnly: true,
      isContactBirthdays: true
    };
  }

  setUserBirthdayCalendarSync(creds.username, { calendarUrl: createdCal.url });
  return createdCal;
}

interface ExistingRemoteEvent {
  uid: string;
  objectUrl: string;
  hash: string;
  isManaged: boolean;
}

async function fetchExistingCalendarEventsMeta(
  creds: CalDavCredentials,
  calendarUrl: string
): Promise<ExistingRemoteEvent[]> {
  const reportXml = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const calUrl = ensureTrailingSlash(calendarUrl);
  const res = await davRequest(creds, 'REPORT', calUrl, reportXml, {
    'Content-Type': 'application/xml; charset=utf-8',
    Depth: '1'
  });
  const xml = await readResponseTextSmart(res);
  const baseOrigin = new URL(calUrl).origin;
  const responseBlocks =
    xml.match(/<(?:[a-zA-Z0-9]+:)?response\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?response>/gi) || [];

  const existing: ExistingRemoteEvent[] = [];
  for (const block of responseBlocks) {
    const hrefMatch = block.match(/<(?:[a-zA-Z0-9]+:)?href[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?href>/i);
    const dataMatch = block.match(
      /<(?:[a-zA-Z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?calendar-data>/i
    );
    if (!hrefMatch || !dataMatch) continue;

    const rawIcs = normalizeDanishText(
      dataMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
    );
    if (!rawIcs.includes('BEGIN:VCALENDAR')) continue;

    try {
      const comp = new ICAL.Component(ICAL.parse(rawIcs));
      const vevent = comp.getFirstSubcomponent('vevent');
      if (!vevent) continue;
      const uid = String(vevent.getFirstPropertyValue('uid') || '').trim();
      if (!uid) continue;
      const hash = String(vevent.getFirstPropertyValue('x-brogaard-hash') || '').trim();
      const managedFlag =
        String(vevent.getFirstPropertyValue('x-brogaard-managed') || '').toUpperCase() === 'TRUE';
      const isManaged =
        managedFlag || uid.startsWith('brogaard-bday-') || uid.startsWith('brogaard-anniv-');

      existing.push({
        uid,
        objectUrl: new URL(hrefMatch[1].trim(), baseOrigin).toString(),
        hash,
        isManaged
      });
    } catch {
      // Ignorér korrupt enkelt-ICS
    }
  }
  return existing;
}

export async function syncContactBirthdaysToCalDav(
  creds: CalDavCredentials,
  options?: { enable?: boolean; color?: string }
): Promise<BirthdaySyncResult> {
  const prefs = getUserContactPrefs(creds.username);
  if (!options?.enable && !prefs.birthdayCalendarSyncEnabled) {
    return {
      synced: false,
      skipped: true,
      calendarUrl: prefs.birthdayCalendarUrl || null,
      totalContactsEvents: 0,
      createdOrUpdated: 0,
      deleted: 0,
      unchanged: 0,
      lastSyncedAt: prefs.birthdayCalendarLastSyncedAt || null
    };
  }

  const effectiveColor =
    options?.color || prefs.calendarColor || DEFAULT_BIRTHDAY_CALENDAR_COLOR;
  const targetCal = await ensureBirthdayCalDavCalendar(creds, effectiveColor);
  const calUrl = ensureTrailingSlash(targetCal.url);

  const addressBooks = await fetchAddressBooks(creds);
  const contacts = await fetchAllContacts(creds, addressBooks);

  const desired = new Map<string, DesiredBirthdayEvent>();
  let uniqueSpecialDates = 0;
  for (const c of contacts) {
    const baseUid = sanitizeUidSegment(c.uid || c.id || c.fullName || 'contact');
    const fullName =
      (c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ')).trim() || 'Kontakt';
    const firstName = extractFirstName(c.firstName, fullName);

    if (c.birthday) {
      const builtList = buildRollingSpecialDateEvents({
        uidPrefix: `brogaard-bday-${baseUid}`,
        firstName,
        fullName,
        rawDate: c.birthday,
        kind: 'birthday'
      });
      if (builtList.length > 0) uniqueSpecialDates += 1;
      for (const item of builtList) {
        desired.set(item.uid, item);
      }
    }

    if (c.anniversary) {
      const builtList = buildRollingSpecialDateEvents({
        uidPrefix: `brogaard-anniv-${baseUid}`,
        firstName,
        fullName,
        rawDate: c.anniversary,
        kind: 'anniversary',
        customLabel: c.anniversaryLabel
      });
      if (builtList.length > 0) uniqueSpecialDates += 1;
      for (const item of builtList) {
        desired.set(item.uid, item);
      }
    }
  }

  const remoteEvents = await fetchExistingCalendarEventsMeta(creds, calUrl);
  const remoteByUid = new Map<string, ExistingRemoteEvent>();
  const staleToDelete: ExistingRemoteEvent[] = [];

  for (const rem of remoteEvents) {
    if (!desired.has(rem.uid)) {
      if (rem.isManaged) {
        staleToDelete.push(rem);
      }
      continue;
    }
    // Hvis samme UID findes dubleret med forskellige filnavne, behold én og fjern dublet
    if (remoteByUid.has(rem.uid) && rem.isManaged) {
      staleToDelete.push(rem);
      continue;
    }
    remoteByUid.set(rem.uid, rem);
  }

  const toUpsert: Array<{ objectUrl: string; ics: string }> = [];
  let unchanged = 0;

  for (const [uid, item] of desired.entries()) {
    const existing = remoteByUid.get(uid);
    if (existing && existing.hash === item.hash) {
      unchanged += 1;
      continue;
    }
    const objectUrl = existing?.objectUrl || `${calUrl}${encodeURIComponent(uid)}.ics`;
    toUpsert.push({ objectUrl, ics: item.ics });
  }

  const CONCURRENCY = 6;
  let createdOrUpdated = 0;
  for (let i = 0; i < toUpsert.length; i += CONCURRENCY) {
    const batch = toUpsert.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (entry) => {
        await davRequest(creds, 'PUT', entry.objectUrl, entry.ics, {
          'Content-Type': 'text/calendar; charset=utf-8'
        });
        createdOrUpdated += 1;
      })
    );
  }

  let deleted = 0;
  for (let i = 0; i < staleToDelete.length; i += CONCURRENCY) {
    const batch = staleToDelete.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (entry) => {
        try {
          await davRequest(creds, 'DELETE', entry.objectUrl);
          deleted += 1;
        } catch (err: any) {
          if (!String(err?.message || '').includes('HTTP 404')) {
            throw err;
          }
        }
      })
    );
  }

  invalidateUserEventCache(creds);
  const nowIso = new Date().toISOString();
  setUserBirthdayCalendarSync(creds.username, {
    enabled: true,
    calendarUrl: calUrl,
    lastSyncedAt: nowIso
  });

  return {
    synced: true,
    calendarUrl: calUrl,
    totalContactsEvents: uniqueSpecialDates,
    createdOrUpdated,
    deleted,
    unchanged,
    lastSyncedAt: nowIso
  };
}

const autoSyncInFlight = new Set<string>();

export async function maybeAutoSyncContactBirthdays(
  creds: CalDavCredentials,
  minIntervalMs = 10 * 60 * 1000
): Promise<void> {
  const userKey = creds.username.toLowerCase().trim();
  const prefs = getUserContactPrefs(creds.username);
  if (!prefs.birthdayCalendarSyncEnabled || autoSyncInFlight.has(userKey)) {
    return;
  }

  const lastMs = prefs.birthdayCalendarLastSyncedAt
    ? new Date(prefs.birthdayCalendarLastSyncedAt).getTime()
    : 0;
  const lastYear = lastMs > 0 ? new Date(lastMs).getFullYear() : 0;
  const currentYear = new Date().getFullYear();

  if (lastMs > 0 && lastYear === currentYear && Date.now() - lastMs < minIntervalMs) {
    return;
  }

  autoSyncInFlight.add(userKey);
  try {
    await syncContactBirthdaysToCalDav(creds);
  } catch (err: any) {
    console.warn('Auto-synk af fødselsdagskalender fejlede:', err?.message || err);
  } finally {
    autoSyncInFlight.delete(userKey);
  }
}

export async function disableContactBirthdaysCalDavSync(
  creds: CalDavCredentials,
  deleteRemoteCalendar = false
): Promise<{ disabled: boolean; deletedCalendar: boolean }> {
  const prefs = getUserContactPrefs(creds.username);
  let deletedCalendar = false;

  if (deleteRemoteCalendar && prefs.birthdayCalendarUrl) {
    try {
      await deleteCalDavCalendar(creds, prefs.birthdayCalendarUrl);
      deletedCalendar = true;
      invalidateUserEventCache(creds);
    } catch (err: any) {
      if (!String(err?.message || '').includes('HTTP 404')) {
        throw err;
      }
      deletedCalendar = true;
    }
  }

  setUserBirthdayCalendarSync(creds.username, {
    enabled: false,
    ...(deleteRemoteCalendar ? { calendarUrl: null } : {})
  });

  return { disabled: true, deletedCalendar };
}
