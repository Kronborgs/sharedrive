import { getWritableDataDir } from './cryptoStore.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CalDavCredentials, CalendarInfoDTO } from './davClient.js';
import { CalendarEventDTO, parseIcsToEvents, normalizeDanishText } from './icalMapper.js';

export interface SubscriptionRecord {
  id: string;
  userKey: string;
  name: string;
  subscriptionUrl: string;
  color: string;
  createdAt: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ICS_BYTES = 8 * 1024 * 1024;

interface FeedCacheEntry {
  fetchedAt: number;
  calendarName?: string;
  events: CalendarEventDTO[];
}

const feedCache = new Map<string, FeedCacheEntry>();


function getSubscriptionsFilePath(): string {
  return path.join(getWritableDataDir(), 'subscriptions.json');
}

function getUserKey(creds: CalDavCredentials): string {
  return `${creds.serverUrl.trim().toLowerCase()}::${creds.username.trim().toLowerCase()}`;
}

function readAllSubscriptions(): SubscriptionRecord[] {
  for (const dir of [getWritableDataDir()]) {
    const file = path.join(dir, 'subscriptions.json');
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return [...parsed];
        }
      }
    } catch {
      // Ignorér læsefejl og fald tilbage til hukommelse
    }
  }
  return [];
}

function writeAllSubscriptions(records: SubscriptionRecord[]) {
  try {
    const file = getSubscriptionsFilePath();
    fs.writeFileSync(file, JSON.stringify(records, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn('Kunne ikke skrive subscriptions.json til disk (bevares i hukommelse):', err);
  }
}

export function normalizeSubscriptionUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === 'builtin://dk-holidays' || trimmed.toLowerCase() === 'dk-holidays') {
    return 'builtin://dk-holidays';
  }
  let urlStr = trimmed;
  if (/^webcals?:\/\//i.test(urlStr)) {
    urlStr = urlStr.replace(/^webcals?:\/\//i, 'https://');
  } else if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = `https://${urlStr}`;
  }

  // Konvertér automatisk officeholidays.com landesider til deres tilsvarende iCal-feed
  const officeMatch = urlStr.match(/^https?:\/\/(?:www\.)?officeholidays\.com\/countries\/([a-z0-9_-]+)(?:\/\d{4})?\/?$/i);
  if (officeMatch && officeMatch[1]) {
    return `https://www.officeholidays.com/ics-local-name/${officeMatch[1].toLowerCase()}`;
  }

  return urlStr;
}

/**
 * SSRF-beskyttelse for eksterne kalender-abonnementer (Google, Microsoft, Apple osv.).
 * Blokerer loopback, link-local og private RFC-1918 IP-adresser.
 */
export function assertSafeExternalFeedUrl(rawUrl: string): URL {
  const normalized = normalizeSubscriptionUrl(rawUrl);
  const urlObj = new URL(normalized);

  if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
    throw new Error('Kun HTTP/HTTPS og webcal:// links er tilladt.');
  }

  const host = urlObj.hostname.toLowerCase();
  const isBlocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.') ||
    host.startsWith('169.254.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.startsWith('[fc') ||
    host.startsWith('[fd') ||
    host.startsWith('[fe80') ||
    host.endsWith('.internal') ||
    host.endsWith('.local');

  if (isBlocked) {
    throw new Error('Abonnements-URL må ikke pege på lokale eller interne netværksadresser.');
  }

  return urlObj;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatYmd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Beregner Påskedag for et givent år (Gregoriansk Meeus/Jones/Butcher algoritme).
 */
function getEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function getLastSundayOfMonth(year: number, monthIndex: number): Date {
  const lastDay = new Date(year, monthIndex + 1, 0);
  const dayOfWeek = lastDay.getDay();
  lastDay.setDate(lastDay.getDate() - dayOfWeek);
  return lastDay;
}

/**
 * Genererer officielle danske helligdage og mærkedage for [currentYear - 1 .. currentYear + 3].
 */
export function generateDanishHolidayEvents(calendarId: string): CalendarEventDTO[] {
  const currentYear = new Date().getFullYear();
  const events: CalendarEventDTO[] = [];

  for (let year = currentYear - 1; year <= currentYear + 3; year++) {
    const easter = getEasterSunday(year);
    const holidays: Array<{ date: Date; title: string; description: string }> = [
      { date: new Date(year, 0, 1), title: 'Nytårsdag', description: 'Officiel dansk helligdag' },
      { date: addDays(easter, -49), title: 'Fastelavn', description: 'Dansk mærkedag (7 uger før Påskedag)' },
      { date: addDays(easter, -7), title: 'Palmesøndag', description: 'Officiel dansk helligdag' },
      { date: addDays(easter, -3), title: 'Skærtorsdag', description: 'Officiel dansk helligdag' },
      { date: addDays(easter, -2), title: 'Langfredag', description: 'Officiel dansk helligdag' },
      { date: easter, title: 'Påskedag', description: 'Officiel dansk helligdag' },
      { date: addDays(easter, 1), title: '2. Påskedag', description: 'Officiel dansk helligdag' },
      { date: new Date(year, 4, 1), title: '1. Maj', description: 'Arbejdernes internationale kampdag' },
      { date: addDays(easter, 39), title: 'Kristi Himmelfartsdag', description: 'Officiel dansk helligdag' },
      { date: addDays(easter, 49), title: 'Pinsedag', description: 'Officiel dansk helligdag' },
      { date: addDays(easter, 50), title: '2. Pinsedag', description: 'Officiel dansk helligdag' },
      { date: new Date(year, 5, 5), title: 'Grundlovsdag', description: 'Dansk national mærkedag (5. juni)' },
      { date: new Date(year, 5, 23), title: 'Sankt Hans Aften', description: 'Dansk mærkedag (23. juni)' },
      { date: getLastSundayOfMonth(year, 2), title: 'Sommertid starter (+1 time)', description: 'Urene stilles 1 time frem kl. 02:00' },
      { date: getLastSundayOfMonth(year, 9), title: 'Vintertid starter (-1 time)', description: 'Urene stilles 1 time tilbage kl. 03:00' },
      { date: new Date(year, 10, 10), title: 'Mortensaften', description: 'Dansk mærkedag (10. november)' },
      { date: new Date(year, 11, 24), title: 'Juleaften', description: 'Dansk mærkedag (24. december)' },
      { date: new Date(year, 11, 25), title: 'Juledag', description: 'Officiel dansk helligdag' },
      { date: new Date(year, 11, 26), title: '2. Juledag', description: 'Officiel dansk helligdag' },
      { date: new Date(year, 11, 31), title: 'Nytårsaften', description: 'Dansk mærkedag (31. december)' }
    ];

    for (const h of holidays) {
      const startYmd = formatYmd(h.date);
      const endYmd = formatYmd(addDays(h.date, 1));
      const slug = h.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const uid = `dk-holiday-${year}-${slug}`;
      events.push({
        id: `${calendarId}::${uid}`,
        uid,
        calendarId,
        title: h.title,
        start: startYmd,
        end: endYmd,
        allDay: true,
        description: h.description,
        location: 'Danmark',
        timezone: 'Europe/Copenhagen',
        attendees: [],
        reminderMinutes: null
      });
    }
  }

  return events;
}

async function decodeFeedBytes(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_ICS_BYTES) {
    throw new Error('Kalender-feedet overstiger maksimal tilladt størrelse (8 MB).');
  }
  const bytes = new Uint8Array(buf);
  const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    return normalizeDanishText(utf8Decoder.decode(bytes));
  } catch {
    const latin1Decoder = new TextDecoder('iso-8859-1');
    return normalizeDanishText(latin1Decoder.decode(bytes));
  }
}

function extractIcsCalendarName(rawIcs: string): string | undefined {
  const match = rawIcs.match(/^X-WR-CALNAME(?:;[^:]*)?:(.+)$/im);
  if (match && match[1]) {
    return normalizeDanishText(match[1].trim());
  }
  return undefined;
}

/**
 * Udtrækker et .ics / webcal:// link fra en HTML-side, hvis brugeren kom til at indsætte selve websiden.
 */
function discoverIcsUrlFromHtml(html: string, baseUrl: URL): string | null {
  const webcalMatch = html.match(/webcals?:\/\/[^"'\s<>]+/i);
  if (webcalMatch) {
    return normalizeSubscriptionUrl(webcalMatch[0]);
  }
  const hrefMatch = html.match(/href=["']([^"']+(?:\.ics|\/ics-local-name\/[^"']+|\/ics\/[^"']+))["']/i);
  if (hrefMatch && hrefMatch[1]) {
    try {
      return new URL(hrefMatch[1], baseUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchUrlWithSafeRedirects(startUrl: URL): Promise<{ res: Response; finalUrl: URL }> {
  let currentUrlObj = startUrl;
  let res: Response | null = null;

  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(currentUrlObj.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'text/calendar, application/ics, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (compatible; DAV-Sync-Cal/1.0)'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) break;
      const redirectedUrl = new URL(location, currentUrlObj).toString();
      currentUrlObj = assertSafeExternalFeedUrl(redirectedUrl);
      continue;
    }
    break;
  }

  if (!res || !res.ok) {
    throw new Error(`Kunne ikke hente kalender-feed (HTTP ${res?.status || 'ukendt'}). Kontrollér at linket er tilgængeligt.`);
  }

  return { res, finalUrl: currentUrlObj };
}

async function fetchExternalIcsFeed(
  subscriptionId: string,
  rawUrl: string,
  forceRefresh = false
): Promise<{ calendarName?: string; events: CalendarEventDTO[] }> {
  const normalizedUrl = normalizeSubscriptionUrl(rawUrl);

  if (normalizedUrl === 'builtin://dk-holidays') {
    return {
      calendarName: 'Danske Helligdage',
      events: generateDanishHolidayEvents(subscriptionId)
    };
  }

  const cacheKey = `${subscriptionId}::${normalizedUrl}`;
  const cached = feedCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { calendarName: cached.calendarName, events: cached.events };
  }

  const initialUrlObj = assertSafeExternalFeedUrl(normalizedUrl);
  const { res, finalUrl } = await fetchUrlWithSafeRedirects(initialUrlObj);
  let rawText = await decodeFeedBytes(res);

  // Hvis URL'en returnerede en HTML-side i stedet for en .ics-fil, prøv at finde .ics-linket i HTML'en
  if (!rawText.includes('BEGIN:VCALENDAR')) {
    const discovered = discoverIcsUrlFromHtml(rawText, finalUrl);
    if (discovered) {
      const discoveredUrlObj = assertSafeExternalFeedUrl(discovered);
      const second = await fetchUrlWithSafeRedirects(discoveredUrlObj);
      rawText = await decodeFeedBytes(second.res);
    }
  }

  if (!rawText.includes('BEGIN:VCALENDAR')) {
    throw new Error('Linket returnerede en HTML-webside i stedet for en iCalendar (.ics) fil. Kontrollér at du bruger kalenderens direkte iCal / .ics link.');
  }

  const calendarName = extractIcsCalendarName(rawText);
  const events = parseIcsToEvents(rawText, subscriptionId, undefined, undefined, false, true);

  feedCache.set(cacheKey, {
    fetchedAt: Date.now(),
    calendarName,
    events
  });

  return { calendarName, events };
}

function toCalendarInfoDTO(rec: SubscriptionRecord): CalendarInfoDTO {
  return {
    id: rec.id,
    url: rec.subscriptionUrl,
    subscriptionUrl: rec.subscriptionUrl,
    name: rec.name,
    color: rec.color,
    serverColor: rec.color,
    readOnly: true,
    isShared: false,
    isSubscribed: true,
    owner: rec.subscriptionUrl === 'builtin://dk-holidays' ? 'Indbygget abonnement' : 'Eksternt abonnement (.ics)',
    description: rec.subscriptionUrl
  };
}

export async function addUserSubscription(
  creds: CalDavCredentials,
  input: { name?: string; subscriptionUrl: string; color?: string }
): Promise<{ calendar: CalendarInfoDTO; events: CalendarEventDTO[] }> {
  const userKey = getUserKey(creds);
  const normalizedUrl = normalizeSubscriptionUrl(input.subscriptionUrl);
  const all = readAllSubscriptions();

  const existing = all.find(
    (item) => item.userKey === userKey && item.subscriptionUrl.toLowerCase() === normalizedUrl.toLowerCase()
  );
  if (existing) {
    if (input.name?.trim()) existing.name = input.name.trim();
    if (input.color?.trim()) existing.color = input.color.trim();
    writeAllSubscriptions(all);
    const fetched = await fetchExternalIcsFeed(existing.id, existing.subscriptionUrl, true);
    return {
      calendar: toCalendarInfoDTO(existing),
      events: fetched.events
    };
  }

  const id = normalizedUrl === 'builtin://dk-holidays'
    ? 'sub::dk-holidays'
    : `sub::${crypto.randomUUID()}`;

  const fetched = await fetchExternalIcsFeed(id, normalizedUrl, true);
  const resolvedName =
    (input.name || '').trim() ||
    fetched.calendarName ||
    (normalizedUrl === 'builtin://dk-holidays' ? 'Danske Helligdage' : 'Abonneret Kalender');

  const record: SubscriptionRecord = {
    id,
    userKey,
    name: resolvedName,
    subscriptionUrl: normalizedUrl,
    color: input.color || (normalizedUrl === 'builtin://dk-holidays' ? '#e11d48' : '#7c3aed'),
    createdAt: new Date().toISOString()
  };

  all.push(record);
  writeAllSubscriptions(all);

  return {
    calendar: toCalendarInfoDTO(record),
    events: fetched.events
  };
}

export function removeUserSubscription(creds: CalDavCredentials, subscriptionId: string): boolean {
  const userKey = getUserKey(creds);
  const all = readAllSubscriptions();
  const filtered = all.filter((item) => !(item.userKey === userKey && item.id === subscriptionId));
  if (filtered.length === all.length) {
    return false;
  }
  writeAllSubscriptions(filtered);
  return true;
}

export function updateUserSubscriptionColor(
  creds: CalDavCredentials,
  subscriptionId: string,
  color: string
): boolean {
  const safeColor = /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : '';
  if (!safeColor) return false;
  const userKey = getUserKey(creds);
  const all = readAllSubscriptions();
  const target = all.find((item) => item.userKey === userKey && item.id === subscriptionId);
  if (!target) return false;
  target.color = safeColor;
  writeAllSubscriptions(all);
  return true;
}

export interface ClientSubscriptionHint {
  id?: string;
  name?: string;
  subscriptionUrl: string;
  color?: string;
}

export async function syncUserSubscriptions(
  creds: CalDavCredentials,
  clientHints?: ClientSubscriptionHint[],
  forceRefresh = false
): Promise<{ calendars: CalendarInfoDTO[]; events: CalendarEventDTO[] }> {
  const userKey = getUserKey(creds);
  const all = readAllSubscriptions();

  // Gendan eventuelle abonnementer gemt i browserens localStorage, hvis containeren har været genstartet
  if (Array.isArray(clientHints) && clientHints.length > 0) {
    let changed = false;
    for (const hint of clientHints) {
      if (!hint?.subscriptionUrl) continue;
      const normUrl = normalizeSubscriptionUrl(hint.subscriptionUrl);
      const exists = all.some(
        (item) => item.userKey === userKey && item.subscriptionUrl.toLowerCase() === normUrl.toLowerCase()
      );
      if (!exists) {
        all.push({
          id: normUrl === 'builtin://dk-holidays' ? 'sub::dk-holidays' : (hint.id || `sub::${crypto.randomUUID()}`),
          userKey,
          name: hint.name || (normUrl === 'builtin://dk-holidays' ? 'Danske Helligdage' : 'Abonneret Kalender'),
          subscriptionUrl: normUrl,
          color: hint.color || (normUrl === 'builtin://dk-holidays' ? '#e11d48' : '#7c3aed'),
          createdAt: new Date().toISOString()
        });
        changed = true;
      }
    }
    if (changed) {
      writeAllSubscriptions(all);
    }
  }

  const subs = all.filter((item) => item.userKey === userKey);
  if (subs.length === 0) {
    return { calendars: [], events: [] };
  }

  const calendars: CalendarInfoDTO[] = subs.map((s) => toCalendarInfoDTO(s));
  const settled = await Promise.allSettled(
    subs.map((s) => fetchExternalIcsFeed(s.id, s.subscriptionUrl, forceRefresh))
  );

  const events: CalendarEventDTO[] = [];
  for (const res of settled) {
    if (res.status === 'fulfilled') {
      events.push(...res.value.events);
    }
  }

  return { calendars, events };
}
