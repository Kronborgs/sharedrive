import crypto from 'node:crypto';
import net from 'node:net';
import { createDAVClient } from 'tsdav';
import {
  CalendarEventDTO,
  parseIcsToEvents,
  buildIcsFromEvent,
  AttendeeDTO,
  normalizeDanishText
} from './icalMapper.js';

export interface CalDavCredentials {
  serverUrl: string;
  username: string;
  password: string;
  clientIp?: string;
}

export interface CalendarInfoDTO {
  id: string;
  name: string;
  serverName?: string;
  localNameOverride?: string | null;
  color: string;
  serverColor: string;
  localColorOverride?: string | null;
  readOnly: boolean;
  isShared: boolean;
  sharePermission?: 'read' | 'write';
  userShareId?: string;
  isSubscribed?: boolean;
  isContactBirthdays?: boolean;
  subscriptionUrl?: string;
  owner?: string;
  ctag?: string;
  url: string;
  description?: string;
}

const FALLBACK_COLORS = [
  '#2563eb', // Blå
  '#059669', // Grøn
  '#d97706', // Amber
  '#7c3aed', // Lilla
  '#db2777', // Pink
  '#0891b2'  // Cyan
];

export function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Kanonisk nøgle til deduplikering af kalender-URL'er, så f.eks.
 * .../mail%40domæne.dk/Calendar/personal/ og .../mail@domæne.dk/Calendar/personal/
 * altid behandles som den nøjagtigt samme kalender.
 */
export function canonicalCalendarKey(rawUrl: string): string {
  try {
    const u = new URL(ensureTrailingSlash(rawUrl.trim()));
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
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Returnerer true hvis URL'en er en intern WebDAV/SOGo system-kollektion
 * (f.eks. calendar-proxy-read, calendar-proxy-write, inbox, outbox, freebusy),
 * som IKKE er en rigtig bruger-kalender.
 */
function isInternalNonCalendarUrl(rawUrl: string): boolean {
  const decoded = decodeURIComponent(rawUrl);
  return (
    /\/Calendar\/$/i.test(decoded) ||
    /\/(?:calendar-proxy-read|calendar-proxy-write|inbox|outbox|freebusy|notifications|trash)(?:\/|$)/i.test(decoded)
  );
}

/**
 * Udtrækker en specifik kalender-URL, hvis brugeren har indsat et direkte link
 * som f.eks. https://post2ko.bridgefarm.dk/SOGo/dav/mail@bridgefarm.dk/Calendar/personal/
 */
export function extractDirectCalendarUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const urlObj = new URL(withProtocol);
    // Matcher /SOGo/dav/<user>/Calendar/<calName>
    if (/\/SOGo\/dav\/[^/]+\/Calendar\/[^/]+/i.test(urlObj.pathname)) {
      urlObj.pathname = ensureTrailingSlash(urlObj.pathname);
      return urlObj.toString();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * SSRF-beskyttelse: Validerer at en CalDAV-server URL bruger http/https og ikke peger
 * på lokale loopback/metadata/link-local adresser (medmindre det er serverens egen DEFAULT_CALDAV_URL).
 */
export function assertSafeCalDavUrl(rawUrl: string): URL {
  const withProtocol = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
  const urlObj = new URL(withProtocol);

  if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
    throw new Error('Kun HTTP/HTTPS-protokoller er tilladt.');
  }

  // Hvis URL'en matcher den administrator-konfigurerede DEFAULT_CALDAV_URL, DEFAULT_MAIL_HOST eller DEFAULT_IMAP_HOST, er den altid tilladt
  const defaultEnvUrl = process.env.DEFAULT_CALDAV_URL?.trim();
  if (defaultEnvUrl) {
    try {
      const defObj = new URL(/^https?:\/\//i.test(defaultEnvUrl) ? defaultEnvUrl : `https://${defaultEnvUrl}`);
      if (urlObj.origin.toLowerCase() === defObj.origin.toLowerCase()) {
        return urlObj;
      }
    } catch {
      // ignorer ugyldig env-url
    }
  }

  const allowedMailHosts = [process.env.DEFAULT_MAIL_HOST, process.env.DEFAULT_IMAP_HOST]
    .filter(Boolean)
    .map((h) => String(h).trim().replace(/^[a-z0-9+.-]+:\/\//i, '').split('/')[0].split(':')[0].toLowerCase());
  if (allowedMailHosts.includes(urlObj.hostname.toLowerCase())) {
    return urlObj;
  }

  const host = urlObj.hostname.toLowerCase();
  const isBlockedHost =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('127.') ||
    host.startsWith('169.254.') ||
    host.endsWith('.internal') ||
    host.endsWith('.local');

  if (isBlockedHost) {
    throw new Error('Adgang til lokale eller interne adresser er blokeret af sikkerhedspolitikken.');
  }

  return urlObj;
}

/**
 * Sikrer at mål-URL'en (ved PUT/DELETE/PROPFIND) tilhører den samme origin som den autentificerede CalDAV-server.
 */
export function assertSameServerOrigin(targetUrl: string, creds: CalDavCredentials) {
  const serverOrigin = new URL(normalizeMailcowUrl(creds.serverUrl)).origin.toLowerCase();
  const targetOrigin = new URL(targetUrl).origin.toLowerCase();
  if (serverOrigin !== targetOrigin) {
    throw new Error('Sikkerhedsfejl: Mål-URL matcher ikke den autentificerede CalDAV-server.');
  }
}

/**
 * Normaliserer Mailcow/SOGo URL:
 * Understøtter både domæne-rod (https://mail.domæne.dk),
 * DAV-rod (https://mail.domæne.dk/SOGo/dav/)
 * OG direkte kalender-links!
 */
export function normalizeMailcowUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('Server URL mangler');
  }
  const urlObj = assertSafeCalDavUrl(trimmed);

  // Hvis URL'en peger dybt ind i /SOGo/dav/..., normaliseres rod-URL'en til /SOGo/dav/
  const sogoMatch = urlObj.pathname.match(/^(.*\/SOGo\/dav)(?:\/.*)?$/i);
  if (sogoMatch) {
    urlObj.pathname = `${sogoMatch[1]}/`;
    return urlObj.toString();
  }

  if (urlObj.pathname === '' || urlObj.pathname === '/') {
    urlObj.pathname = '/SOGo/dav/';
  } else if (!urlObj.pathname.endsWith('/')) {
    urlObj.pathname = `${urlObj.pathname}/`;
  }
  return urlObj.toString();
}

/**
 * Bygger brugerens direkte SOGo Calendar Home URL:
 * f.eks. https://post2ko.bridgefarm.dk/SOGo/dav/mail@bridgefarm.dk/Calendar/
 */
export function buildSogoUserCalendarHomeUrl(serverUrl: string, username: string): string {
  const base = normalizeMailcowUrl(serverUrl);
  return `${base}${ username.trim() }/Calendar/`;
}

/**
 * Læser en HTTP-response med intelligent detektion mellem UTF-8 og ISO-8859-1 / Windows-1252,
 * så danske tegn (æ, ø, å, Æ, Ø, Å) aldrig bliver til spørgsmålstegn () eller mojibake.
 */
export async function readResponseTextSmart(res: Response): Promise<string> {
  const arrayBuffer = await res.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(uint8);
  } catch {
    return new TextDecoder('windows-1252').decode(uint8);
  }
}

export function buildForwardedIpHeaders(clientIp?: string): Record<string, string> {
  const clean = (clientIp || '').trim().replace(/^::ffff:/i, '');
  if (!clean || net.isIP(clean) === 0) return {};
  return {
    'X-Forwarded-For': clean,
    'X-Real-IP': clean
  };
}

/**
 * Custom fetch-wrapper til tsdav så samtlige interne CalDAV/CardDAV-kald
 * (inkl. /.well-known discovery og redirects på samme origin) altid bærer klientens IP.
 */
export function createForwardedIpFetch(serverUrl: string, clientIp?: string): typeof fetch {
  const ipHeaders = buildForwardedIpHeaders(clientIp);
  if (Object.keys(ipHeaders).length === 0) {
    return globalThis.fetch.bind(globalThis);
  }

  let serverOrigin = '';
  try {
    serverOrigin = new URL(normalizeMailcowUrl(serverUrl)).origin.toLowerCase();
  } catch {
    return globalThis.fetch.bind(globalThis);
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    let sameOrigin = false;
    try {
      sameOrigin = Boolean(serverOrigin) && new URL(rawUrl).origin.toLowerCase() === serverOrigin;
    } catch {
      sameOrigin = false;
    }

    if (!sameOrigin) {
      return globalThis.fetch(input, init);
    }

    const mergedHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    for (const [key, value] of Object.entries(ipHeaders)) {
      mergedHeaders.set(key, value);
    }

    return globalThis.fetch(input, {
      ...init,
      headers: mergedHeaders
    });
  };
}

/**
 * Direkte, status-tjekket HTTP/DAV-request mod Mailcow/SOGo.
 */
export async function davRequest(
  creds: CalDavCredentials,
  method: string,
  url: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs?: number
): Promise<Response> {
  assertSameServerOrigin(url, creds);
  const auth = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Accept-Charset': 'utf-8, iso-8859-1;q=0.5',
      ...buildForwardedIpHeaders(creds.clientIp),
      ...extraHeaders
    },
    body: body !== undefined ? Buffer.from(body, 'utf8') : undefined,
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {})
  });

  if (!res.ok) {
    const text = (await readResponseTextSmart(res).catch(() => '')).slice(0, 300);
    throw new Error(`CalDAV ${method} mod ${url} fejlede (HTTP ${res.status} ${res.statusText})${text ? `: ${text}` : ''}`);
  }
  return res;
}

/**
 * XML-hjælpere til robust CalDAV/SOGo parsing
 */
function extractOkPropstatXml(responseBlock: string): string {
  const propstats =
    responseBlock.match(
      /<(?:[a-zA-Z0-9_-]+:)?propstat\b[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?propstat>/gi
    ) || [];
  if (propstats.length === 0) return responseBlock;

  const okBlocks = propstats.filter((ps) => {
    const statusMatch = ps.match(
      /<(?:[a-zA-Z0-9_-]+:)?status\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?status>/i
    );
    return Boolean(statusMatch && /\s200\b/.test(statusMatch[1]));
  });

  return okBlocks.join('\n');
}

function extractTagInnerXml(xml: string, localName: string): string | null {
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_-]+:)?${localName}(?:\\s[^>]*?)?(?<!/)>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9_-]+:)?${localName}>`,
    'i'
  );
  const m = xml.match(re);
  return m ? m[1] : null;
}

function extractHrefs(xml: string): string[] {
  const matches = xml.matchAll(
    /<(?:[a-zA-Z0-9_-]+:)?href(?:\s[^>]*?)?(?<!\/)>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?href>/gi
  );
  const hrefs: string[] = [];
  for (const m of matches) {
    const val = m[1].trim();
    if (val) hrefs.push(val);
  }
  return hrefs;
}

/**
 * Afkoder SOGo's mappe-slugs for abonnerede/delte kalendere i brugerens egen Calendar/-mappe,
 * f.eks. "anne_A_brogaard_D_dk_personal" -> { owner: "anne@brogaard.dk", slug: "personal" }.
 */
export function decodeSogoSharedSlugOwner(
  calUrl: string,
  normalizedUser: string
): { owner?: string; slug?: string } {
  let decoded = '';
  try {
    decoded = decodeURIComponent(calUrl || '');
  } catch {
    decoded = calUrl || '';
  }

  const calMatch = decoded.match(/\/SOGo\/dav\/[^/]+\/Calendar\/([^/]+)\/?$/i);
  if (!calMatch || !calMatch[1]) return {};

  const folderSlug = calMatch[1].trim();
  const unescapeSogoCss = (part: string): string =>
    part
      .replace(/^_(\d)/, '$1')
      .replace(/_D_/gi, '.')
      .replace(/_U_/gi, '_')
      .replace(/_P_/gi, '+');

  const sogoEncodedMatch = folderSlug.match(
    /^([a-z0-9._+-]+)_A_([a-z0-9-]+(?:_D_[a-z0-9-]+)+)_(.+)$/i
  );
  if (sogoEncodedMatch) {
    const owner = `${unescapeSogoCss(sogoEncodedMatch[1])}@${unescapeSogoCss(sogoEncodedMatch[2])}`.trim();
    const slug = sogoEncodedMatch[3].trim();
    if (owner.toLowerCase() !== normalizedUser && owner.toLowerCase() !== normalizedUser.split('@')[0]) {
      return { owner, slug };
    }
    return {};
  }

  const directAtMatch = folderSlug.match(/^([^\s/@]+@[^\s/@]+)_(.+)$/i);
  if (directAtMatch) {
    const owner = directAtMatch[1].trim();
    const slug = directAtMatch[2].trim();
    if (owner.toLowerCase() !== normalizedUser && owner.toLowerCase() !== normalizedUser.split('@')[0]) {
      return { owner, slug };
    }
  }

  return {};
}

/**
 * Bygger en kanonisk kalender-signatur på tværs af ejer-URL og modtagerens abonnerede slug-URL.
 */
export function canonicalSogoCalendarSignature(rawUrl: string, ownerHint?: string): string | null {
  let decoded = '';
  try {
    decoded = decodeURIComponent(rawUrl || '');
  } catch {
    decoded = rawUrl || '';
  }

  const calMatch = decoded.match(/\/SOGo\/dav\/([^/]+)\/Calendar\/([^/]+)\/?$/i);
  if (!calMatch || !calMatch[1] || !calMatch[2]) return null;

  const slugDecoded = decodeSogoSharedSlugOwner(rawUrl, '');
  if (slugDecoded.owner && slugDecoded.slug) {
    return `sogo-cal::${slugDecoded.owner.toLowerCase().trim()}::${slugDecoded.slug.toLowerCase().trim()}`;
  }

  const effOwner = (ownerHint || calMatch[1]).toLowerCase().trim();
  const slug = calMatch[2].toLowerCase().trim();
  return `sogo-cal::${effOwner}::${slug}`;
}

interface PropfindHints {
  defaultShared?: boolean;
  defaultOwner?: string;
  proxyAccess?: 'read' | 'write';
}

/**
 * Opretter en autentificeret tsdav klient mod Mailcow / SOGo.
 */
export async function connectCalDav(creds: CalDavCredentials) {
  const serverUrl = normalizeMailcowUrl(creds.serverUrl);
  const ipHeaders = buildForwardedIpHeaders(creds.clientIp);

  const client = await createDAVClient({
    serverUrl,
    credentials: {
      username: creds.username,
      password: creds.password
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    fetch: createForwardedIpFetch(serverUrl, creds.clientIp),
    ...(Object.keys(ipHeaders).length > 0 ? { fetchOptions: { headers: ipHeaders } } : {})
  });

  return { client, serverUrl };
}

/**
 * Direkte PROPFIND mod SOGo's Calendar-mappe inkl. <D:owner/> og <D:current-user-privilege-set/>.
 */
async function fetchCalendarsDirectPropfind(
  creds: CalDavCredentials,
  targetUrl: string,
  depth: '0' | '1' = '1',
  hints?: PropfindHints,
  timeoutMs = 8000
): Promise<CalendarInfoDTO[]> {
  const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <CS:getctag/>
    <A:calendar-color/>
    <C:calendar-description/>
    <C:supported-calendar-component-set/>
    <D:owner/>
    <D:current-user-privilege-set/>
  </D:prop>
</D:propfind>`;

  const res = await davRequest(
    creds,
    'PROPFIND',
    targetUrl,
    propfindXml,
    {
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: depth
    },
    timeoutMs
  );

  const xml = await readResponseTextSmart(res);
  const baseOrigin = new URL(targetUrl).origin;
  const normalizedUser = creds.username.toLowerCase().trim();

  const responseBlocks =
    xml.match(/<(?:[a-zA-Z0-9_-]+:)?response\b[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?response>/gi) || [];
  const results: CalendarInfoDTO[] = [];

  for (const block of responseBlocks) {
    const hrefMatch = block.match(
      /<(?:[a-zA-Z0-9_-]+:)?href(?:\s[^>]*?)?(?<!\/)>([^<]+)<\/(?:[a-zA-Z0-9_-]+:)?href>/i
    );
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[1].trim();
    const fullUrl = ensureTrailingSlash(new URL(rawHref, baseOrigin).toString());

    if (isInternalNonCalendarUrl(fullUrl)) {
      continue;
    }

    const okXml = extractOkPropstatXml(block);
    const resourceTypeXml = extractTagInnerXml(okXml, 'resourcetype') || '';

    // Skal have et <calendar/> eller <C:calendar/> tag (IKKE calendar-proxy-* / schedule-inbox;
    // bemærk at SOGo altid sætter <C:schedule-outbox/> på brugerens 'personal'-kalender, og ægte /outbox/ filtreres via URL)
    const isCalendarResource = /<(?:[a-zA-Z0-9_-]+:)?calendar(?:\s|>|\/)/i.test(resourceTypeXml);
    const isScheduleOrProxy = /schedule-inbox|calendar-proxy|vevent-collection-only-false/i.test(
      resourceTypeXml
    );

    if (!isCalendarResource || isScheduleOrProxy) {
      continue;
    }

    // Hvis den kun understøtter VTODO (opgaver) og ikke VEVENT, spring over
    const compSetXml = extractTagInnerXml(okXml, 'supported-calendar-component-set');
    if (compSetXml) {
      const compMatches = [...compSetXml.matchAll(/name=["']([A-Z]+)["']/gi)].map((m) =>
        m[1].toUpperCase()
      );
      if (compMatches.length > 0 && !compMatches.includes('VEVENT')) {
        continue;
      }
    }

    const rawDisplay = extractTagInnerXml(okXml, 'displayname');
    const rawName = rawDisplay
      ? normalizeDanishText(rawDisplay.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim())
      : '';

    const rawDesc = extractTagInnerXml(okXml, 'calendar-description');
    const description = rawDesc
      ? normalizeDanishText(rawDesc.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()) || undefined
      : undefined;

    const rawColorXml = extractTagInnerXml(okXml, 'calendar-color');
    const rawColor =
      extractHexColor(rawColorXml ? rawColorXml.trim() : undefined) ||
      FALLBACK_COLORS[results.length % FALLBACK_COLORS.length];

    const rawCtag = extractTagInnerXml(okXml, 'getctag');
    const ctag = rawCtag ? rawCtag.trim() : undefined;

    // Udtræk DAV <owner>
    const ownerXml = extractTagInnerXml(okXml, 'owner');
    const ownerHref = ownerXml ? extractHrefs(ownerXml)[0] : undefined;
    let davOwner: string | undefined;
    if (ownerHref) {
      let decodedOwnerHref = ownerHref;
      try {
        decodedOwnerHref = decodeURIComponent(ownerHref);
      } catch {
        decodedOwnerHref = ownerHref;
      }
      const ownerPathMatch = decodedOwnerHref.match(/\/SOGo\/dav\/([^/]+)\//i);
      if (ownerPathMatch && ownerPathMatch[1]) {
        davOwner = ownerPathMatch[1].trim();
      }
    }

    // Udtræk DAV <current-user-privilege-set>
    const privSetXml = extractTagInnerXml(okXml, 'current-user-privilege-set');
    let privReadOnly: boolean | undefined;
    if (privSetXml && /<(?:[a-zA-Z0-9_-]+:)?privilege\b/i.test(privSetXml)) {
      const hasWritePrivilege =
        /<(?:[a-zA-Z0-9_-]+:)?(?:write|write-content|all|bind|unbind|modify-public-records|modify-confidential-records|modify-private-records)(?:\s|>|\/)/i.test(
          privSetXml
        );
      privReadOnly = !hasWritePrivilege;
    }

    const urlPerms = detectCalendarPermissionsFromUrlAndName(fullUrl, rawName, normalizedUser);
    const slugPerms = decodeSogoSharedSlugOwner(fullUrl, normalizedUser);

    const candidateOwner = davOwner || slugPerms.owner || urlPerms.owner;
    let isShared = urlPerms.isShared;
    let owner = urlPerms.owner || slugPerms.owner;

    if (candidateOwner) {
      const candLower = candidateOwner.toLowerCase().trim();
      if (candLower !== normalizedUser && candLower !== normalizedUser.split('@')[0]) {
        isShared = true;
        owner = candidateOwner;
      }
    }

    if (!isShared && hints?.defaultShared) {
      isShared = true;
      owner = owner || hints.defaultOwner;
    } else if (isShared && !owner && hints?.defaultOwner) {
      owner = hints.defaultOwner;
    }

    let readOnly = false;
    if (isShared) {
      if (privReadOnly !== undefined) {
        readOnly = privReadOnly;
      } else if (hints?.proxyAccess) {
        readOnly = hints.proxyAccess === 'read';
      } else {
        readOnly = urlPerms.readOnly;
      }
    }

    results.push({
      id: fullUrl,
      url: fullUrl,
      name: rawName || 'Personlig kalender',
      color: rawColor,
      serverColor: rawColor,
      readOnly,
      isShared,
      sharePermission: isShared ? (readOnly ? 'read' : 'write') : undefined,
      owner,
      ctag,
      description
    });
  }

  return results;
}

function isSameUserPrincipal(principalUrl: string, normalizedUser: string): boolean {
  try {
    const decoded = decodeURIComponent(principalUrl);
    const m = decoded.match(/\/SOGo\/dav\/([^/]+)\//i);
    if (!m || !m[1]) return false;
    const owner = m[1].toLowerCase().trim();
    return owner === normalizedUser || owner === normalizedUser.split('@')[0];
  } catch {
    return false;
  }
}

async function discoverSogoPrincipalHomesAndDelegates(creds: CalDavCredentials): Promise<{
  ownHomeUrls: string[];
  delegatedPrincipals: Map<string, 'read' | 'write'>;
}> {
  const base = ensureTrailingSlash(normalizeMailcowUrl(creds.serverUrl));
  const baseOrigin = new URL(base).origin;
  const baseOriginLower = baseOrigin.toLowerCase();
  const normalizedUser = creds.username.toLowerCase().trim();
  const rawUser = creds.username.trim();
  const encodedUser = encodeURIComponent(rawUser);

  const ownHomeSet = new Set<string>();
  const defaultOwnHome = buildSogoUserCalendarHomeUrl(creds.serverUrl, creds.username);
  ownHomeSet.add(ensureTrailingSlash(defaultOwnHome));

  const delegatedPrincipals = new Map<string, 'read' | 'write'>();

  const addDelegate = (rawHref: string, access: 'read' | 'write') => {
    try {
      const resolved = new URL(rawHref.trim(), baseOrigin);
      if (resolved.origin.toLowerCase() !== baseOriginLower) return;
      resolved.pathname = ensureTrailingSlash(
        resolved.pathname.replace(/\/calendar-proxy-(?:read|write)\/?$/i, '/')
      );
      const urlStr = resolved.toString();
      if (!/\/SOGo\/dav\/[^/]+\/$/i.test(decodeURIComponent(urlStr))) return;
      if (isSameUserPrincipal(urlStr, normalizedUser)) return;
      const existing = delegatedPrincipals.get(urlStr);
      if (access === 'write' || !existing) {
        delegatedPrincipals.set(urlStr, access);
      }
    } catch {
      // Ignorer ugyldig href
    }
  };

  const principalPropfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <C:calendar-home-set/>
    <CS:calendar-proxy-read-for/>
    <CS:calendar-proxy-write-for/>
    <D:group-membership/>
  </D:prop>
</D:propfind>`;

  const principalCandidates = [`${base}${rawUser}/`];
  if (encodedUser !== rawUser) {
    principalCandidates.push(`${base}${encodedUser}/`);
  }

  let workingPrincipalUrl: string | null = null;
  let principalXml: string | null = null;

  for (const cand of principalCandidates) {
    try {
      const res = await davRequest(
        creds,
        'PROPFIND',
        cand,
        principalPropfindXml,
        { 'Content-Type': 'application/xml; charset=utf-8', Depth: '0' },
        6000
      );
      workingPrincipalUrl = cand;
      principalXml = await readResponseTextSmart(res);
      break;
    } catch {
      // Prøv næste principal-kandidat
    }
  }

  if (!principalXml) {
    try {
      const cupRes = await davRequest(
        creds,
        'PROPFIND',
        base,
        `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop><D:current-user-principal/></D:prop>
</D:propfind>`,
        { 'Content-Type': 'application/xml; charset=utf-8', Depth: '0' },
        6000
      );
      const cupXml = extractOkPropstatXml(await readResponseTextSmart(cupRes));
      const cupTag = extractTagInnerXml(cupXml, 'current-user-principal');
      const cupHref = cupTag ? extractHrefs(cupTag)[0] : undefined;
      if (cupHref) {
        const cupUrl = ensureTrailingSlash(new URL(cupHref, baseOrigin).toString());
        const res = await davRequest(
          creds,
          'PROPFIND',
          cupUrl,
          principalPropfindXml,
          { 'Content-Type': 'application/xml; charset=utf-8', Depth: '0' },
          6000
        );
        workingPrincipalUrl = cupUrl;
        principalXml = await readResponseTextSmart(res);
      }
    } catch {
      // Ignorer fallback-fejl
    }
  }

  if (principalXml) {
    const okXml = extractOkPropstatXml(principalXml);

    const homeSetXml = extractTagInnerXml(okXml, 'calendar-home-set');
    if (homeSetXml) {
      for (const href of extractHrefs(homeSetXml)) {
        try {
          const homeUrl = ensureTrailingSlash(new URL(href, baseOrigin).toString());
          if (new URL(homeUrl).origin.toLowerCase() === baseOriginLower) {
            ownHomeSet.add(homeUrl);
          }
        } catch {
          // Ignorer ugyldig home-set href
        }
      }
    }

    const writeForXml = extractTagInnerXml(okXml, 'calendar-proxy-write-for');
    if (writeForXml) {
      for (const href of extractHrefs(writeForXml)) {
        addDelegate(href, 'write');
      }
    }

    const readForXml = extractTagInnerXml(okXml, 'calendar-proxy-read-for');
    if (readForXml) {
      for (const href of extractHrefs(readForXml)) {
        addDelegate(href, 'read');
      }
    }

    const groupXml = extractTagInnerXml(okXml, 'group-membership');
    if (groupXml) {
      for (const href of extractHrefs(groupXml)) {
        if (/\/calendar-proxy-write(?:\/|$)/i.test(href)) {
          addDelegate(href, 'write');
        } else if (/\/calendar-proxy-read(?:\/|$)/i.test(href)) {
          addDelegate(href, 'read');
        }
      }
    }
  }

  // Hvis PROPFIND ikke gav proxy-delegationer, prøv RFC 3253 expand-property REPORT
  if (delegatedPrincipals.size === 0 && workingPrincipalUrl) {
    try {
      const expandXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:expand-property xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:property name="calendar-proxy-write-for" namespace="http://calendarserver.org/ns/">
    <D:property name="displayname"/>
    <C:calendar-home-set/>
  </D:property>
  <D:property name="calendar-proxy-read-for" namespace="http://calendarserver.org/ns/">
    <D:property name="displayname"/>
    <C:calendar-home-set/>
  </D:property>
  <D:property name="group-membership">
    <D:property name="displayname"/>
    <D:property name="calendar-proxy-write-for" namespace="http://calendarserver.org/ns/"/>
    <D:property name="calendar-proxy-read-for" namespace="http://calendarserver.org/ns/"/>
  </D:property>
</D:expand-property>`;

      const expandRes = await davRequest(
        creds,
        'REPORT',
        workingPrincipalUrl,
        expandXml,
        { 'Content-Type': 'application/xml; charset=utf-8', Depth: '0' },
        6000
      );
      const expandBody = await readResponseTextSmart(expandRes);
      const okExpand = extractOkPropstatXml(expandBody);

      const writeTag = extractTagInnerXml(okExpand, 'calendar-proxy-write-for');
      if (writeTag) {
        for (const href of extractHrefs(writeTag)) {
          if (/\/SOGo\/dav\/[^/]+\/(?:calendar-proxy-write\/)?$/i.test(href)) {
            addDelegate(href, 'write');
          }
        }
      }

      const readTag = extractTagInnerXml(okExpand, 'calendar-proxy-read-for');
      if (readTag) {
        for (const href of extractHrefs(readTag)) {
          if (/\/SOGo\/dav\/[^/]+\/(?:calendar-proxy-read\/)?$/i.test(href)) {
            addDelegate(href, 'read');
          }
        }
      }

      const grpTag = extractTagInnerXml(okExpand, 'group-membership');
      if (grpTag) {
        for (const href of extractHrefs(grpTag)) {
          if (/\/calendar-proxy-write(?:\/|$)/i.test(href)) {
            addDelegate(href, 'write');
          } else if (/\/calendar-proxy-read(?:\/|$)/i.test(href)) {
            addDelegate(href, 'read');
          }
        }
      }
    } catch {
      // Ignorer hvis serveren ikke understøtter expand-property REPORT
    }
  }

  return {
    ownHomeUrls: Array.from(ownHomeSet),
    delegatedPrincipals
  };
}

function parseCollectionQueryResponse(
  responseXml: string,
  baseOrigin: string,
  baseOriginLower: string,
  normalizedUser: string
): Array<{ url: string; owner?: string; displayName?: string }> {
  const userLocalPart = normalizedUser.split('@')[0];
  const items: Array<{ url: string; owner?: string; displayName?: string }> = [];

  const responseBlocks =
    responseXml.match(/<(?:[a-zA-Z0-9_-]+:)?response\b[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?response>/gi) ||
    [];

  for (const block of responseBlocks) {
    const hrefMatch = block.match(
      /<(?:[a-zA-Z0-9_-]+:)?href(?:\s[^>]*?)?(?<!\/)>([^<]+)<\/(?:[a-zA-Z0-9_-]+:)?href>/i
    );
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[1].trim();
    let fullUrl: string;
    try {
      const u = new URL(rawHref, baseOrigin);
      if (u.origin.toLowerCase() !== baseOriginLower) continue;
      fullUrl = ensureTrailingSlash(u.toString());
    } catch {
      continue;
    }

    if (isInternalNonCalendarUrl(fullUrl)) continue;

    let decodedUrl = fullUrl;
    try {
      decodedUrl = decodeURIComponent(fullUrl);
    } catch {
      decodedUrl = fullUrl;
    }

    const okXml = extractOkPropstatXml(block);
    const ownerTag = extractTagInnerXml(block, 'owner') || extractTagInnerXml(okXml, 'owner');
    let calOwner: string | undefined;
    if (ownerTag) {
      const ownerHref = extractHrefs(ownerTag)[0] || ownerTag;
      const m = decodeURIComponent(ownerHref).match(/\/SOGo\/dav\/([^/]+)/i);
      if (m && m[1]) calOwner = m[1].trim();
    }
    if (!calOwner) {
      const urlMatch = decodedUrl.match(/\/SOGo\/dav\/([^/]+)\/Calendar\//i);
      if (urlMatch && urlMatch[1]) calOwner = urlMatch[1].trim();
    }

    const ownerLower = (calOwner || '').toLowerCase().trim();
    if (!ownerLower || ownerLower === normalizedUser || ownerLower === userLocalPart) {
      continue;
    }

    const rawDisplay =
      extractTagInnerXml(okXml, 'displayname') || extractTagInnerXml(block, 'displayname');
    const displayName = rawDisplay
      ? normalizeDanishText(rawDisplay.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()) ||
        undefined
      : undefined;

    items.push({ url: fullUrl, owner: calOwner, displayName });
  }

  return items;
}

async function runSogoCollectionQuery(
  creds: CalDavCredentials,
  ownerFilter: string,
  timeoutMs = 4000
): Promise<Array<{ url: string; owner?: string; displayName?: string }>> {
  const base = ensureTrailingSlash(normalizeMailcowUrl(creds.serverUrl));
  const baseOrigin = new URL(base).origin;
  const baseOriginLower = baseOrigin.toLowerCase();
  const normalizedUser = creds.username.toLowerCase().trim();
  const rawUser = creds.username.trim();
  const encodedUser = encodeURIComponent(rawUser);

  const principalCandidates = [`${base}${rawUser}/`];
  if (encodedUser !== rawUser) {
    principalCandidates.push(`${base}${encodedUser}/`);
  }

  const body = `<?xml version="1.0" encoding="utf-8"?><collection-query xmlns="urn:inverse:params:xml:ns:inverse-dav"><prop-match name="resource-type">calendar</prop-match><prop-match name="owner">/SOGo/dav/${escapeXml(ownerFilter)}/</prop-match></collection-query>`;

  for (const cand of principalCandidates) {
    try {
      const res = await davRequest(
        creds,
        'REPORT',
        cand,
        body,
        { 'Content-Type': 'application/xml; charset=utf-8' },
        timeoutMs
      );
      const responseXml = await readResponseTextSmart(res);
      return parseCollectionQueryResponse(responseXml, baseOrigin, baseOriginLower, normalizedUser);
    } catch {
      // Prøv næste principal-kandidat
    }
  }

  return [];
}

/**
 * Finder delte SOGo-kalendere via Inverse-DAV <collection-query> på brugerens principal,
 * så også delinger der endnu ikke er abonneret i SOGo Webmail opdages automatisk.
 */
async function discoverSogoSharedCalendarsViaCollectionQuery(
  creds: CalDavCredentials
): Promise<Array<{ url: string; owner?: string; displayName?: string }>> {
  const normalizedUser = creds.username.toLowerCase().trim();
  const userDomain = normalizedUser.includes('@') ? normalizedUser.split('@')[1] : '';
  const ownerFilters = Array.from(new Set([...(userDomain ? [userDomain] : []), '@']));
  const discovered = new Map<string, { url: string; owner?: string; displayName?: string }>();

  const settled = await Promise.allSettled(
    ownerFilters.map((ownerFilter) => runSogoCollectionQuery(creds, ownerFilter, 4000))
  );

  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      const key = canonicalCalendarKey(item.url);
      if (!discovered.has(key)) {
        discovered.set(key, item);
      }
    }
  }

  return Array.from(discovered.values());
}

/**
 * Søger delte kalendere via Inverse-DAV <collection-query> ud fra et ejer-navn eller e-mailstump.
 */
export async function searchSogoSharedCalendarsByOwnerQuery(
  creds: CalDavCredentials,
  ownerQuery: string
): Promise<Array<{ url: string; owner?: string; displayName?: string }>> {
  const cleanQuery = ownerQuery.trim();
  if (!cleanQuery) return [];
  const items = await runSogoCollectionQuery(creds, cleanQuery, 4500);
  const discovered = new Map<string, { url: string; owner?: string; displayName?: string }>();
  for (const item of items) {
    const key = canonicalCalendarKey(item.url);
    if (!discovered.has(key)) {
      discovered.set(key, item);
    }
  }
  return Array.from(discovered.values());
}

function canonicalSharedCalendarSignature(
  cal: CalendarInfoDTO,
  normalizedUser: string
): string | null {
  let decoded = '';
  try {
    decoded = decodeURIComponent(cal.url || '');
  } catch {
    decoded = cal.url || '';
  }

  const calMatch = decoded.match(/\/SOGo\/dav\/([^/]+)\/Calendar\/([^/]+)\/?$/i);
  if (calMatch) {
    const pathUser = calMatch[1].toLowerCase().trim();
    const rawSlug = calMatch[2].trim();
    const slugDecoded = decodeSogoSharedSlugOwner(cal.url, normalizedUser);
    if (slugDecoded.owner && slugDecoded.slug) {
      return `shared::${slugDecoded.owner.toLowerCase().trim()}::${slugDecoded.slug.toLowerCase().trim()}`;
    }
    if (cal.isShared && (cal.owner || (pathUser !== normalizedUser && pathUser !== normalizedUser.split('@')[0]))) {
      const effOwner = (cal.owner || pathUser).toLowerCase().trim();
      return `shared::${effOwner}::${rawSlug.toLowerCase()}`;
    }
  }
  return null;
}

/**
 * Hurtig hentning af brugerens egne kalendere via direkte PROPFIND Depth: 1 på brugerens egen Calendar/-mappe
 * (udføres på < 200 ms uden langsom collection-query eller tsdav-discovery).
 */
export async function fetchOwnCalendarsFast(creds: CalDavCredentials): Promise<CalendarInfoDTO[]> {
  const base = ensureTrailingSlash(normalizeMailcowUrl(creds.serverUrl));
  const rawUser = creds.username.trim();
  const encodedUser = encodeURIComponent(rawUser);

  const candidates = [ensureTrailingSlash(buildSogoUserCalendarHomeUrl(creds.serverUrl, creds.username))];
  if (encodedUser !== rawUser) {
    candidates.push(`${base}${encodedUser}/Calendar/`);
  }

  let lastErr: unknown;
  for (const homeUrl of candidates) {
    try {
      const cals = await fetchCalendarsDirectPropfind(creds, homeUrl, '1', undefined, 5000);
      return cals.filter((c) => !c.isShared);
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr) {
    throw lastErr;
  }
  return [];
}

/**
 * Henter alle brugerens egne og delte SOGo-kalendere inkl. serverfarver og Read-Only status.
 */
export async function fetchCalendars(creds: CalDavCredentials): Promise<CalendarInfoDTO[]> {
  const normalizedUser = creds.username.toLowerCase().trim();
  const directCalUrl = extractDirectCalendarUrl(creds.serverUrl);
  const discoveredByKey = new Map<string, CalendarInfoDTO>();
  const sharedSignatures = new Set<string>();
  const ownerCtagKeys = new Set<string>();

  const tryAddCalendar = (cal: CalendarInfoDTO) => {
    const key = canonicalCalendarKey(cal.url);
    if (discoveredByKey.has(key)) return;

    const sig = canonicalSharedCalendarSignature(cal, normalizedUser);
    if (sig && sharedSignatures.has(sig)) return;

    const ownerCtagKey =
      cal.isShared && cal.owner && cal.ctag
        ? `${cal.owner.toLowerCase().trim()}::ctag::${cal.ctag}`
        : null;
    if (ownerCtagKey && ownerCtagKeys.has(ownerCtagKey)) return;

    discoveredByKey.set(key, cal);
    if (sig) sharedSignatures.add(sig);
    if (ownerCtagKey) ownerCtagKeys.add(ownerCtagKey);
  };

  // 1. Opdag brugerens calendar-home-set + delegerede/delte SOGo-principals
  const { ownHomeUrls, delegatedPrincipals } = await discoverSogoPrincipalHomesAndDelegates(creds).catch(
    () => ({
      ownHomeUrls: [ensureTrailingSlash(buildSogoUserCalendarHomeUrl(creds.serverUrl, creds.username))],
      delegatedPrincipals: new Map<string, 'read' | 'write'>()
    })
  );

  // 2. Hent ALTID direkte PROPFIND på brugerens egne home-sets (inkl. abonnerede delte kalendere + privileges)
  await Promise.allSettled(
    ownHomeUrls.map(async (homeUrl) => {
      try {
        const directCals = await fetchCalendarsDirectPropfind(creds, homeUrl, '1');
        for (const cal of directCals) {
          tryAddCalendar(cal);
        }
      } catch (err) {
        console.warn(`Direkte PROPFIND mod SOGo homeUrl (${homeUrl}) fejlede:`, err);
      }
    })
  );

  // 3. Hent eventuelle delte/delegerede kalendere fra andre brugeres principals
  if (delegatedPrincipals.size > 0) {
    const baseOrigin = new URL(normalizeMailcowUrl(creds.serverUrl)).origin;
    const baseOriginLower = baseOrigin.toLowerCase();

    await Promise.allSettled(
      Array.from(delegatedPrincipals.entries()).map(async ([principalUrl, proxyAccess]) => {
        let defaultOwner: string | undefined;
        try {
          const ownerMatch = decodeURIComponent(principalUrl).match(/\/SOGo\/dav\/([^/]+)\//i);
          defaultOwner = ownerMatch?.[1]?.trim();
        } catch {
          defaultOwner = undefined;
        }

        const hints: PropfindHints = {
          defaultShared: true,
          defaultOwner,
          proxyAccess
        };

        const guessedHome = `${ensureTrailingSlash(principalUrl)}Calendar/`;
        try {
          const cals = await fetchCalendarsDirectPropfind(creds, guessedHome, '1', hints);
          if (cals.length > 0) {
            for (const cal of cals) tryAddCalendar(cal);
            return;
          }
        } catch {
          // Prøv eksplicit calendar-home-set opslag på delegate principal
        }

        try {
          const homeRes = await davRequest(
            creds,
            'PROPFIND',
            principalUrl,
            `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-home-set/></D:prop>
</D:propfind>`,
            { 'Content-Type': 'application/xml; charset=utf-8', Depth: '0' },
            6000
          );
          const homeXml = extractOkPropstatXml(await readResponseTextSmart(homeRes));
          const homeSetTag = extractTagInnerXml(homeXml, 'calendar-home-set');
          if (!homeSetTag) return;

          for (const href of extractHrefs(homeSetTag)) {
            const targetHome = ensureTrailingSlash(new URL(href, baseOrigin).toString());
            if (new URL(targetHome).origin.toLowerCase() !== baseOriginLower) continue;
            const cals = await fetchCalendarsDirectPropfind(creds, targetHome, '1', hints);
            for (const cal of cals) tryAddCalendar(cal);
          }
        } catch (err) {
          console.warn(`Kunne ikke hente delte kalendere fra ${principalUrl}:`, err);
        }
      })
    );
  }

  // 3.5. Opdag delte SOGo-kalendere via Inverse-DAV <collection-query> (finder også delinger uden bruger-abonnement)
  try {
    const collectionShared = await discoverSogoSharedCalendarsViaCollectionQuery(creds);
    const toFetch = collectionShared.filter((item) => {
      const key = canonicalCalendarKey(item.url);
      if (discoveredByKey.has(key)) return false;
      const sig = canonicalSogoCalendarSignature(item.url, item.owner);
      if (sig && sharedSignatures.has(`shared::${sig.slice('sogo-cal::'.length)}`)) return false;
      return true;
    });

    if (toFetch.length > 0) {
      const fetched = await Promise.allSettled(
        toFetch.map((item) =>
          fetchCalendarsDirectPropfind(creds, item.url, '0', {
            defaultShared: true,
            defaultOwner: item.owner
          })
        )
      );
      for (const r of fetched) {
        if (r.status === 'fulfilled') {
          for (const cal of r.value) {
            tryAddCalendar(cal);
          }
        }
      }
    }
  } catch (err) {
    console.warn('SOGo collection-query delingsopdagelse fejlede:', err);
  }

  // 4. Supplerende tsdav standard discovery mod /SOGo/dav/
  try {
    const { client } = await connectCalDav(creds);
    const davCalendars = await client.fetchCalendars();

    for (let idx = 0; idx < davCalendars.length; idx++) {
      const cal = davCalendars[idx];
      const comps = Array.isArray(cal.components) ? cal.components : [];
      if (comps.length > 0 && !comps.some((c) => String(c).toUpperCase() === 'VEVENT')) {
        continue;
      }

      const fullUrl = ensureTrailingSlash(cal.url);
      if (isInternalNonCalendarUrl(fullUrl)) {
        continue;
      }

      const rawColor =
        extractHexColor((cal as any).calendarColor) ||
        FALLBACK_COLORS[discoveredByKey.size % FALLBACK_COLORS.length];
      const displayName =
        typeof cal.displayName === 'string' && cal.displayName.trim()
          ? normalizeDanishText(cal.displayName.trim())
          : `Kalender ${discoveredByKey.size + 1}`;

      const urlPerms = detectCalendarPermissionsFromUrlAndName(fullUrl, displayName, normalizedUser);
      const slugPerms = decodeSogoSharedSlugOwner(fullUrl, normalizedUser);
      const isShared = urlPerms.isShared || Boolean(slugPerms.owner);
      const owner = urlPerms.owner || slugPerms.owner;

      tryAddCalendar({
        id: fullUrl,
        url: fullUrl,
        name: displayName,
        color: rawColor,
        serverColor: rawColor,
        readOnly: isShared ? urlPerms.readOnly : false,
        isShared,
        owner,
        ctag: cal.ctag,
        description: cal.description
      });
    }
  } catch (err) {
    console.warn('tsdav discovery fejlede (supplerende trin):', err);
  }

  // 5. Hvis brugeren indtastede et direkte link (f.eks. .../Calendar/personal/), sikre at den er med
  if (directCalUrl && !discoveredByKey.has(canonicalCalendarKey(directCalUrl))) {
    try {
      const directCals = await fetchCalendarsDirectPropfind(creds, directCalUrl, '0');
      for (const cal of directCals) {
        tryAddCalendar(cal);
      }
    } catch (err) {
      console.warn('Direkte PROPFIND mod specifik kalender-URL fejlede:', err);
    }
  }

  // 6. Sidste fallback: Hvis listen stadig er tom, men auth virkede, tilføj standard SOGo personal-kalender
  if (discoveredByKey.size === 0) {
    const fallbackUrl =
      directCalUrl || `${buildSogoUserCalendarHomeUrl(creds.serverUrl, creds.username)}personal/`;
    await davRequest(creds, 'PROPFIND', fallbackUrl, undefined, { Depth: '0' }, 8000);
    tryAddCalendar({
      id: fallbackUrl,
      url: fallbackUrl,
      name: 'Personlig Kalender (SOGo)',
      color: FALLBACK_COLORS[0],
      serverColor: FALLBACK_COLORS[0],
      readOnly: false,
      isShared: false
    });
  }

  // Sortér egne kalendere først, derefter delte kalendere efter ejer og navn
  const all = Array.from(discoveredByKey.values());
  const own = all.filter((c) => !c.isShared);
  const shared = all
    .filter((c) => c.isShared)
    .sort((a, b) => {
      const ownerCmp = (a.owner || '').localeCompare(b.owner || '', 'da');
      return ownerCmp !== 0 ? ownerCmp : a.name.localeCompare(b.name, 'da');
    });

  return [...own, ...shared];
}

/**
 * Henter et enkelt kalender-info objekt ud fra en specifik CalDAV-URL (bruges ved "Tilføj kalender via link").
 */
export async function fetchSingleCalendarByUrl(
  creds: CalDavCredentials,
  calendarUrl: string,
  customName?: string,
  customColor?: string
): Promise<CalendarInfoDTO> {
  const normalizedCalUrl = ensureTrailingSlash(calendarUrl.trim());
  const found = await fetchCalendarsDirectPropfind(creds, normalizedCalUrl, '0');
  if (found.length > 0) {
    const cal = found[0];
    return {
      ...cal,
      name: customName?.trim() || cal.name,
      color: customColor || cal.color,
      serverColor: cal.serverColor || customColor || FALLBACK_COLORS[0]
    };
  }

  const normalizedUser = creds.username.toLowerCase().trim();
  const { isShared, readOnly, owner } = detectCalendarPermissionsFromUrlAndName(
    normalizedCalUrl,
    customName || 'SOGo Kalender',
    normalizedUser
  );

  return {
    id: normalizedCalUrl,
    url: normalizedCalUrl,
    name: customName?.trim() || 'SOGo Kalender',
    color: customColor || FALLBACK_COLORS[0],
    serverColor: customColor || FALLBACK_COLORS[0],
    readOnly,
    isShared,
    owner
  };
}

/**
 * Verificerer og henter metadata for en delt kalender med modtagerens egne legitimationsoplysninger.
 * Kaster HTTP 401/403/404 videre ved tilbagekaldt adgang.
 */
export async function verifyAndFetchSharedCalendar(
  creds: CalDavCredentials,
  calendarUrl: string,
  fallbackName?: string,
  fallbackColor?: string
): Promise<CalendarInfoDTO | null> {
  const normalizedCalUrl = ensureTrailingSlash(calendarUrl.trim());
  const found = await fetchCalendarsDirectPropfind(creds, normalizedCalUrl, '0', {
    defaultShared: true
  });
  if (found.length === 0) return null;
  const cal = found[0];
  return {
    ...cal,
    name: cal.name || fallbackName?.trim() || 'Delt kalender',
    color: cal.color || fallbackColor || FALLBACK_COLORS[0],
    serverColor: cal.serverColor || fallbackColor || FALLBACK_COLORS[0],
    isShared: true
  };
}

/**
 * Henter alle kalendere som en anden bruger (f.eks. bruger@domæne.dk) har delt med den loggede bruger,
 * via direkte PROPFIND mod ejerens /Calendar/-mappe med modtagerens eget login (virker også på tværs af domæner).
 */
export async function fetchUserSharedCalendarsForOwner(
  creds: CalDavCredentials,
  ownerIdentifier: string
): Promise<CalendarInfoDTO[]> {
  const cleanOwner = ownerIdentifier.trim();
  if (!cleanOwner || /[/\\?#\s]/.test(cleanOwner)) {
    return [];
  }

  const normalizedUser = creds.username.toLowerCase().trim();
  const ownerLower = cleanOwner.toLowerCase();
  if (ownerLower === normalizedUser || ownerLower === normalizedUser.split('@')[0]) {
    return [];
  }

  const base = ensureTrailingSlash(normalizeMailcowUrl(creds.serverUrl));
  const origin = new URL(base).origin;
  const encodedOwner = encodeURIComponent(cleanOwner);
  const homeCandidates = [`${base}${cleanOwner}/Calendar/`];
  if (encodedOwner !== cleanOwner) {
    homeCandidates.push(`${base}${encodedOwner}/Calendar/`);
  }

  const discovered = new Map<string, CalendarInfoDTO>();
  const recordCals = (cals: CalendarInfoDTO[]) => {
    for (const cal of cals) {
      const normalizedCal: CalendarInfoDTO = {
        ...cal,
        isShared: true,
        owner: cal.owner || cleanOwner,
        sharePermission: cal.readOnly ? 'read' : 'write'
      };
      const key = canonicalCalendarKey(normalizedCal.url);
      const existing = discovered.get(key);
      if (!existing || (existing.readOnly && !normalizedCal.readOnly)) {
        discovered.set(key, normalizedCal);
      }
    }
  };

  for (const homeUrl of homeCandidates) {
    try {
      const cals = await fetchCalendarsDirectPropfind(
        creds,
        homeUrl,
        '1',
        { defaultShared: true, defaultOwner: cleanOwner },
        5000
      );
      if (cals.length > 0) {
        recordCals(cals);
        break;
      }
    } catch {
      // Prøv næste kandidat eller fallback
    }
  }

  if (discovered.size === 0) {
    const personalCandidates = [`${base}${cleanOwner}/Calendar/personal/`];
    if (encodedOwner !== cleanOwner) {
      personalCandidates.push(`${base}${encodedOwner}/Calendar/personal/`);
    }
    for (const personalUrl of personalCandidates) {
      try {
        const cals = await fetchCalendarsDirectPropfind(
          creds,
          personalUrl,
          '0',
          { defaultShared: true, defaultOwner: cleanOwner },
          4000
        );
        if (cals.length > 0) {
          recordCals(cals);
          break;
        }
      } catch {
        // Ignorer 401/403/404 for kandidater uden adgang
      }
    }
  }

  if (discovered.size === 0) {
    try {
      const foldersUrl = `${origin}/SOGo/so/${encodeURIComponent(cleanOwner)}/foldersSearch?type=calendar`;
      assertSameServerOrigin(foldersUrl, creds);
      const auth = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');
      const res = await fetch(foldersUrl, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json, text/plain, */*',
          ...buildForwardedIpHeaders(creds.clientIp)
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(4500)
      });

      if (res.ok) {
        const rawText = (await readResponseTextSmart(res)).trim();
        if (rawText && !rawText.startsWith('<')) {
          const parsed = JSON.parse(rawText) as {
            folders?: Array<{
              name?: string;
              displayName?: string;
              owner?: string;
              type?: string;
            }>;
          };
          const folders = Array.isArray(parsed?.folders) ? parsed.folders : [];
          await Promise.allSettled(
            folders.map(async (f, idx) => {
              const rawPath = String(f?.name || '').trim();
              if (!rawPath || !rawPath.toLowerCase().startsWith('/calendar/') || rawPath.includes('..')) {
                return;
              }
              const folderOwner = String(f?.owner || cleanOwner).trim() || cleanOwner;
              if (folderOwner.toLowerCase() === normalizedUser || /[/\\?#\s]/.test(folderOwner)) {
                return;
              }
              const folderDavUrl = ensureTrailingSlash(
                `${base}${folderOwner}/${rawPath.replace(/^\/+/, '')}`
              );
              assertSameServerOrigin(folderDavUrl, creds);
              if (isInternalNonCalendarUrl(folderDavUrl)) return;

              try {
                const cals = await fetchCalendarsDirectPropfind(
                  creds,
                  folderDavUrl,
                  '0',
                  { defaultShared: true, defaultOwner: folderOwner },
                  4000
                );
                if (cals.length > 0) {
                  recordCals(cals);
                  return;
                }
              } catch {
                // Fallback til metadata fra foldersSearch JSON
              }

              const fallbackColor = FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
              recordCals([
                {
                  id: folderDavUrl,
                  url: folderDavUrl,
                  name: normalizeDanishText(String(f?.displayName || '').trim()) || 'Delt kalender',
                  color: fallbackColor,
                  serverColor: fallbackColor,
                  readOnly: true,
                  isShared: true,
                  sharePermission: 'read',
                  owner: folderOwner
                }
              ]);
            })
          );
        }
      }
    } catch {
      // Best-effort JSON fallback
    }
  }

  return Array.from(discovered.values());
}

/**
 * Henter alle VEVENTs fra en enkelt kalender via direkte CalDAV REPORT (calendar-query).
 */
async function fetchEventsFromCalendarDirectReport(
  creds: CalDavCredentials,
  cal: Pick<CalendarInfoDTO, 'id' | 'url' | 'isContactBirthdays'>,
  uid?: string
): Promise<CalendarEventDTO[]> {
  const uidFilter = uid
    ? `<C:prop-filter name="UID"><C:text-match>${escapeXml(uid)}</C:text-match></C:prop-filter>`
    : '';
  const reportXml = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">${uidFilter}</C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

  const calUrl = ensureTrailingSlash(cal.url);
  const res = await davRequest(creds, 'REPORT', calUrl, reportXml, {
    'Content-Type': 'application/xml; charset=utf-8',
    Depth: '1'
  });

  const xml = await readResponseTextSmart(res);
  const baseOrigin = new URL(calUrl).origin;
  const responseBlocks = xml.match(/<(?:[a-zA-Z0-9]+:)?response\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?response>/gi) || [];
  const events: CalendarEventDTO[] = [];

  for (const block of responseBlocks) {
    const hrefMatch = block.match(/<(?:[a-zA-Z0-9]+:)?href[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?href>/i);
    const dataMatch = block.match(/<(?:[a-zA-Z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?calendar-data>/i);
    if (!dataMatch) continue;

    const rawIcs = normalizeDanishText(
      dataMatch[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .trim()
    );

    if (!rawIcs.includes('BEGIN:VCALENDAR')) continue;

    const objectUrl = hrefMatch
      ? new URL(hrefMatch[1].trim(), baseOrigin).toString()
      : undefined;

    const etagMatch = block.match(/<(?:[a-zA-Z0-9]+:)?getetag[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?getetag>/i);
    const etag = etagMatch ? etagMatch[1].trim().replace(/^["']|["']$/g, '') : undefined;

    const parsed = parseIcsToEvents(rawIcs, cal.id, objectUrl, etag, Boolean(uid), !uid);
    events.push(...parsed);
  }

  return events;
}

export async function findCalendarEventByUid(creds: CalDavCredentials, calendarUrl: string, uid: string) {
  const events = await fetchEventsFromCalendarDirectReport(creds, { id: calendarUrl, url: calendarUrl }, uid);
  return events.find(event => event.uid === uid);
}

const CTAG_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutter (invalideres automatisk ved ctag-ændring eller skrivning)
const calendarEventsCache = new Map<
  string,
  { ctag: string; fetchedAt: number; events: CalendarEventDTO[] }
>();

function getEventCacheKey(creds: CalDavCredentials, calUrl: string): string {
  return `${creds.serverUrl.trim().toLowerCase()}::${creds.username.trim().toLowerCase()}::${canonicalCalendarKey(calUrl)}`;
}

export function invalidateUserEventCache(creds: CalDavCredentials) {
  const prefix = `${creds.serverUrl.trim().toLowerCase()}::${creds.username.trim().toLowerCase()}::`;
  for (const key of calendarEventsCache.keys()) {
    if (key.startsWith(prefix)) {
      calendarEventsCache.delete(key);
    }
  }
}

/**
 * Henter alle VEVENTs fra de angivne kalendere.
 * Bruger CalDAV ctag-cache, så uændrede kalendere med tusindvis af events returneres på 0 ms.
 */
export async function fetchAllEvents(
  creds: CalDavCredentials,
  calendars: CalendarInfoDTO[],
  _timeRange?: { start: string; end: string }
): Promise<CalendarEventDTO[]> {
  const allEvents: CalendarEventDTO[] = [];

  await Promise.all(
    calendars.map(async (cal) => {
      try {
        const cacheKey = getEventCacheKey(creds, cal.url);
        const cached = calendarEventsCache.get(cacheKey);
        if (
          cal.ctag &&
          cached &&
          cached.ctag === cal.ctag &&
          Date.now() - cached.fetchedAt < CTAG_CACHE_TTL_MS
        ) {
          allEvents.push(...cached.events);
          return;
        }

        const calEvents = await fetchEventsFromCalendarDirectReport(creds, cal);
        if (cal.ctag) {
          calendarEventsCache.set(cacheKey, {
            ctag: cal.ctag,
            fetchedAt: Date.now(),
            events: calEvents
          });
        }
        allEvents.push(...calEvents);
      } catch (err) {
        console.warn(`Kunne ikke hente events fra kalender ${cal.name} (${cal.url}):`, err);
      }
    })
  );

  return allEvents;
}

/**
 * Opretter eller opdaterer et VEVENT på Mailcow/SOGo via CalDAV PUT.
 */
export async function saveCalDavEvent(
  creds: CalDavCredentials,
  eventDto: CalendarEventDTO,
  options?: { createOnly?: boolean; invitationSeries?: string }
): Promise<CalendarEventDTO> {
  const uid = eventDto.uid || crypto.randomUUID();
  const icsString = options?.invitationSeries ?? buildIcsFromEvent({ ...eventDto, uid }, { saveInvitation: options?.createOnly });
  const isUpdate = Boolean(eventDto.caldavUrl);
  const objectName = options?.createOnly ? crypto.createHash('sha256').update(uid).digest('hex') : encodeURIComponent(uid);
  const objectUrl = isUpdate
    ? (eventDto.caldavUrl as string)
    : `${ensureTrailingSlash(eventDto.calendarId)}${objectName}.ics`;

  const headers: Record<string, string> = {
    'Content-Type': 'text/calendar; charset=utf-8'
  };

  if (options?.createOnly) headers['If-None-Match'] = '*';
  const res = await davRequest(creds, 'PUT', objectUrl, icsString, headers);
  const newEtag = res.headers.get('etag') || undefined;
  invalidateUserEventCache(creds);

  return {
    ...eventDto,
    uid,
    id: `${eventDto.calendarId}::${uid}`,
    caldavUrl: objectUrl,
    etag: newEtag
  };
}

/**
 * Sletter et VEVENT fra Mailcow/SOGo via CalDAV DELETE.
 */
export async function deleteCalDavEvent(
  creds: CalDavCredentials,
  caldavUrl: string,
  _etag?: string
): Promise<void> {
  try {
    await davRequest(creds, 'DELETE', caldavUrl);
    invalidateUserEventCache(creds);
  } catch (err: any) {
    if (String(err?.message || '').includes('HTTP 404')) return;
    throw err;
  }
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Opretter en ny kalender på Mailcow/SOGo via CalDAV MKCALENDAR,
 * ELLER tilføjer et eksisterende kalenderlink hvis calendarUrl er angivet.
 */
export async function createCalDavCalendar(
  creds: CalDavCredentials,
  name: string,
  color: string,
  existingCalendarUrl?: string
): Promise<CalendarInfoDTO> {
  if (existingCalendarUrl && existingCalendarUrl.trim()) {
    return fetchSingleCalendarByUrl(creds, existingCalendarUrl.trim(), name, color);
  }

  const home = buildSogoUserCalendarHomeUrl(creds.serverUrl, creds.username);
  const slug = crypto.randomUUID().toUpperCase();
  const calendarUrl = `${home}${slug}/`;
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : FALLBACK_COLORS[0];

  const body = `<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
  <D:set>
    <D:prop>
      <D:displayname>${escapeXml(name)}</D:displayname>
      <A:calendar-color>${safeColor}FF</A:calendar-color>
      <C:supported-calendar-component-set>
        <C:comp name="VEVENT"/>
      </C:supported-calendar-component-set>
    </D:prop>
  </D:set>
</C:mkcalendar>`;

  await davRequest(creds, 'MKCALENDAR', calendarUrl, body, {
    'Content-Type': 'application/xml; charset=utf-8'
  });

  return {
    id: calendarUrl,
    url: calendarUrl,
    name,
    color: safeColor,
    serverColor: safeColor,
    readOnly: false,
    isShared: false
  };
}

/**
 * Sletter en (egen) kalender og alle dens begivenheder på Mailcow/SOGo.
 */
export async function deleteCalDavCalendar(
  creds: CalDavCredentials,
  calendarUrl: string
): Promise<void> {
  await davRequest(creds, 'DELETE', ensureTrailingSlash(calendarUrl));
}

/**
 * Omdøber en af brugerens egne kalendere direkte på Mailcow/SOGo via CalDAV PROPPATCH.
 */
export async function renameCalDavCalendar(
  creds: CalDavCredentials,
  calendarUrl: string,
  newName: string
): Promise<void> {
  const cleanName = newName.trim().slice(0, 80);
  if (!cleanName) {
    throw new Error('Kalendernavnet må ikke være tomt.');
  }

  const targetUrl = ensureTrailingSlash(calendarUrl.trim());
  assertSameServerOrigin(targetUrl, creds);

  let decoded = targetUrl;
  try {
    decoded = decodeURIComponent(targetUrl);
  } catch {
    decoded = targetUrl;
  }

  if (/_shared_/i.test(decoded) || /\/Calendar\/public(?:\/|$)/i.test(decoded)) {
    throw new Error('Delte eller offentlige kalendere kan ikke omdøbes på serveren.');
  }

  const sogoOwnerMatch = decoded.match(/\/SOGo\/dav\/([^/]+)\//i);
  if (sogoOwnerMatch && sogoOwnerMatch[1]) {
    const urlOwner = sogoOwnerMatch[1].toLowerCase().trim();
    const userLower = creds.username.toLowerCase().trim();
    if (urlOwner !== userLower && urlOwner !== userLower.split('@')[0]) {
      throw new Error('Du kan kun omdøbe dine egne kalendere på serveren.');
    }
  }

  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:">
  <D:set>
    <D:prop>
      <D:displayname>${escapeXml(cleanName)}</D:displayname>
    </D:prop>
  </D:set>
</D:propertyupdate>`;

  const res = await davRequest(creds, 'PROPPATCH', targetUrl, body, {
    'Content-Type': 'application/xml; charset=utf-8'
  });

  if (res.status === 207) {
    const xml = await readResponseTextSmart(res);
    if (/<(?:[a-zA-Z0-9_-]+:)?propstat\b/i.test(xml) && !extractOkPropstatXml(xml).trim()) {
      throw new Error('CalDAV-serveren afviste omdøbning af kalenderen.');
    }
  }
}

/**
 * Opdaterer kalenderfarven (calendar-color) på brugerens egen kalender via CalDAV PROPPATCH.
 */
export async function updateCalDavCalendarColor(
  creds: CalDavCredentials,
  calendarUrl: string,
  color: string
): Promise<void> {
  const safeColor = /^#[0-9a-fA-F]{6}$/.test(color.trim())
    ? color.trim().toLowerCase()
    : FALLBACK_COLORS[0];
  const targetUrl = ensureTrailingSlash(calendarUrl.trim());
  assertSameServerOrigin(targetUrl, creds);

  let decoded = targetUrl;
  try {
    decoded = decodeURIComponent(targetUrl);
  } catch {
    decoded = targetUrl;
  }

  const candidateUrls: string[] = [];
  const sogoCalMatch = decoded.match(/\/SOGo\/dav\/([^/]+)\/Calendar\/([^/]+)\/?$/i);
  if (sogoCalMatch && sogoCalMatch[1] && sogoCalMatch[2]) {
    const urlOwner = sogoCalMatch[1].toLowerCase().trim();
    const slug = sogoCalMatch[2].trim();
    const userLower = creds.username.toLowerCase().trim();

    if (urlOwner === userLower || urlOwner === userLower.split('@')[0]) {
      candidateUrls.push(targetUrl);
    } else {
      const home = ensureTrailingSlash(buildSogoUserCalendarHomeUrl(creds.serverUrl, creds.username));
      const sanitizedOwner = urlOwner.replace(/[^a-z0-9]/gi, '_');
      const localOwner = urlOwner.split('@')[0].replace(/[^a-z0-9]/gi, '_');
      candidateUrls.push(`${home}${sanitizedOwner}_${slug}/`);
      if (localOwner && localOwner !== sanitizedOwner) {
        candidateUrls.push(`${home}${localOwner}_${slug}/`);
      }
    }
  } else {
    candidateUrls.push(targetUrl);
  }

  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:A="http://apple.com/ns/ical/">
  <D:set>
    <D:prop>
      <A:calendar-color>${safeColor}FF</A:calendar-color>
    </D:prop>
  </D:set>
</D:propertyupdate>`;

  let lastErr: unknown = null;
  for (const url of candidateUrls) {
    try {
      const res = await davRequest(creds, 'PROPPATCH', url, body, {
        'Content-Type': 'application/xml; charset=utf-8'
      });
      if (res.status === 207) {
        const xml = await readResponseTextSmart(res);
        if (/<(?:[a-zA-Z0-9_-]+:)?propstat\b/i.test(xml) && !extractOkPropstatXml(xml).trim()) {
          throw new Error('CalDAV-serveren afviste ændring af kalenderfarven.');
        }
      }
      return;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error('Kunne ikke opdatere kalenderfarven på serveren.');
}

/**
 * Opdaterer brugerens RSVP-status (ACCEPTED, TENTATIVE, DECLINED) på en mødeinvitation.
 */
export async function updateEventRsvp(
  creds: CalDavCredentials,
  eventDto: CalendarEventDTO,
  partstat: AttendeeDTO['partstat']
): Promise<CalendarEventDTO> {
  const userEmail = creds.username.toLowerCase().trim();
  const updatedAttendees: AttendeeDTO[] = (eventDto.attendees || []).map((att) => {
    if (att.email.toLowerCase() === userEmail) {
      return { ...att, partstat };
    }
    return att;
  });

  if (!updatedAttendees.some((a) => a.email.toLowerCase() === userEmail)) {
    updatedAttendees.push({
      email: creds.username,
      name: creds.username.split('@')[0],
      partstat
    });
  }

  return saveCalDavEvent(creds, {
    ...eventDto,
    attendees: updatedAttendees
  });
}

function extractHexColor(raw?: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.trim().match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
  if (match) {
    return `#${match[1]}`;
  }
  return null;
}

/**
 * Analyserer SOGo kalender-URL og visningsnavn for at registrere
 * delte kalendere og hvorvidt de er Read-Only.
 * Brugerens egne kalendere er ALDRIG Read-Only.
 */
function detectCalendarPermissionsFromUrlAndName(
  calUrl: string,
  displayName: string,
  normalizedUser: string
): { isShared: boolean; readOnly: boolean; owner?: string } {
  let urlDecoded = calUrl || '';
  try {
    urlDecoded = decodeURIComponent(calUrl || '');
  } catch {
    urlDecoded = calUrl || '';
  }
  let isShared = false;
  let owner: string | undefined;

  const sogoUserMatch = urlDecoded.match(/\/SOGo\/dav\/([^/]+)\//i);
  if (sogoUserMatch && sogoUserMatch[1]) {
    const pathOwner = sogoUserMatch[1].toLowerCase().trim();
    if (pathOwner !== normalizedUser && pathOwner !== normalizedUser.split('@')[0]) {
      isShared = true;
      owner = sogoUserMatch[1];
    }
  }

  if (
    /_shared_/i.test(urlDecoded) ||
    /\/Calendar\/public(?:\/|$)/i.test(urlDecoded) ||
    /\((?:delt|shared|read-only|skrivebeskyttet)/i.test(displayName)
  ) {
    isShared = true;
  }

  const readOnly =
    isShared &&
    (/read[-_\s]?only|skrivebeskyttet|kun\s+læs/i.test(displayName) ||
      /readonly/i.test(urlDecoded) ||
      /\/Calendar\/public(?:\/|$)/i.test(urlDecoded));

  return { isShared, readOnly, owner };
}
