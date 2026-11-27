import {
  type CalDavCredentials,
  normalizeMailcowUrl,
  assertSafeCalDavUrl,
  assertSameServerOrigin,
  readResponseTextSmart,
  ensureTrailingSlash,
  buildForwardedIpHeaders
} from './davClient.js';
import { normalizeDanishText } from './icalMapper.js';
import {
  type SenderAliasRecord,
  getAliasesForUser,
  mergeDiscoveredAliasesForUser
} from './aliasStore.js';

export interface MailcowAliasDiscoveryResult {
  emails: string[];
  displayName?: string;
  sources: { sogoDav: boolean; mailcowApi: boolean };
}

const ALIAS_CACHE_TTL_MS = 5 * 60 * 1000;
const aliasDiscoveryCache = new Map<
  string,
  { fetchedAt: number; result: MailcowAliasDiscoveryResult }
>();

const EMAIL_REGEX = /^[^\s@/\\:<>()[\],;"]+@[^\s@/\\:<>()[\],;"]+\.[a-zA-Z0-9-]{2,}$/;

function extractOkPropstatXml(xml: string): string {
  const propstats =
    xml.match(
      /<(?:[a-zA-Z0-9_-]+:)?propstat\b[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_-]+:)?propstat>/gi
    ) || [];
  if (propstats.length === 0) return xml;

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

async function propfindDav(
  creds: CalDavCredentials,
  url: string,
  xmlBody: string
): Promise<string> {
  assertSameServerOrigin(url, creds);
  const auth = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/xml; charset=utf-8',
      'Accept-Charset': 'utf-8, iso-8859-1;q=0.5',
      Depth: '0',
      ...buildForwardedIpHeaders(creds.clientIp)
    },
    body: Buffer.from(xmlBody, 'utf8'),
    signal: AbortSignal.timeout(5000)
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return readResponseTextSmart(res);
}

function parseSogoPrincipalXml(
  xml: string,
  username: string
): { emails: string[]; displayName?: string } {
  const okXml = extractOkPropstatXml(xml);
  const emails: string[] = [];

  const addrSetXml = extractTagInnerXml(okXml, 'calendar-user-address-set');
  if (addrSetXml) {
    for (const rawHref of extractHrefs(addrSetXml)) {
      if (!/^mailto:/i.test(rawHref)) continue;
      const stripped = rawHref.replace(/^mailto:/i, '').trim();
      let decoded = stripped;
      try {
        decoded = decodeURIComponent(stripped);
      } catch {
        decoded = stripped;
      }
      const clean = normalizeDanishText(decoded).trim();
      if (clean && EMAIL_REGEX.test(clean)) {
        emails.push(clean);
      }
    }
  }

  let displayName: string | undefined;
  const rawDisplay = extractTagInnerXml(okXml, 'displayname');
  if (rawDisplay !== null) {
    const cleanName = normalizeDanishText(
      rawDisplay.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
    );
    if (
      cleanName &&
      cleanName.toLowerCase() !== username.trim().toLowerCase() &&
      !cleanName.includes('@')
    ) {
      displayName = cleanName;
    }
  }

  return { emails, displayName };
}

async function discoverViaSogoDav(
  creds: CalDavCredentials
): Promise<{ ok: boolean; emails: string[]; displayName?: string }> {
  const base = ensureTrailingSlash(normalizeMailcowUrl(creds.serverUrl));
  const rawUser = creds.username.trim();
  const encodedUser = encodeURIComponent(rawUser);

  const candidates = [`${base}${rawUser}/`];
  if (encodedUser !== rawUser) {
    candidates.push(`${base}${encodedUser}/`);
  }

  const principalPropfind = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:displayname/>
    <C:calendar-user-address-set/>
  </D:prop>
</D:propfind>`;

  for (const url of candidates) {
    try {
      const xml = await propfindDav(creds, url, principalPropfind);
      const parsed = parseSogoPrincipalXml(xml, rawUser);
      if (parsed.emails.length > 0 || parsed.displayName) {
        return { ok: true, ...parsed };
      }
      // Principal svarede 200 OK, men havde ingen ekstra adresser
      return { ok: true, ...parsed };
    } catch {
      // Prøv næste kandidat
    }
  }

  // Fallback via current-user-principal på DAV-rod
  try {
    const rootPropfind = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal/>
  </D:prop>
</D:propfind>`;
    const rootXml = await propfindDav(creds, base, rootPropfind);
    const okRoot = extractOkPropstatXml(rootXml);
    const cupXml = extractTagInnerXml(okRoot, 'current-user-principal');
    const href = cupXml ? extractHrefs(cupXml)[0] : undefined;
    if (href) {
      const principalUrl = ensureTrailingSlash(new URL(href, new URL(base).origin).toString());
      const xml = await propfindDav(creds, principalUrl, principalPropfind);
      const parsed = parseSogoPrincipalXml(xml, rawUser);
      return { ok: true, ...parsed };
    }
  } catch {
    // Ignorer fallback-fejl
  }

  return { ok: false, emails: [] };
}

function isMailcowActive(val: unknown): boolean {
  return val === '1' || val === 1 || val === true;
}

async function fetchMailcowJson(apiUrl: string, apiKey: string): Promise<unknown> {
  assertSafeCalDavUrl(apiUrl);
  const res = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      'X-API-Key': apiKey,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function discoverViaMailcowApi(
  creds: CalDavCredentials
): Promise<{ ok: boolean; emails: string[]; displayName?: string }> {
  const apiKey = process.env.MAILCOW_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, emails: [] };
  }

  const rawApiBase =
    process.env.MAILCOW_API_URL?.trim() || new URL(normalizeMailcowUrl(creds.serverUrl)).origin;
  const apiBase = assertSafeCalDavUrl(rawApiBase).toString().replace(/\/+$/, '');
  const username = creds.username.trim();
  const usernameLower = username.toLowerCase();

  const emails: string[] = [];
  let displayName: string | undefined;
  let anySucceeded = false;

  const [aliasRes, domainRes, mailboxRes] = await Promise.allSettled([
    fetchMailcowJson(`${apiBase}/api/v1/get/alias/all`, apiKey),
    fetchMailcowJson(`${apiBase}/api/v1/get/alias-domain/all`, apiKey),
    fetchMailcowJson(`${apiBase}/api/v1/get/mailbox/${encodeURIComponent(username)}`, apiKey)
  ]);

  if (aliasRes.status === 'fulfilled' && Array.isArray(aliasRes.value)) {
    anySucceeded = true;
    for (const item of aliasRes.value) {
      if (!item || typeof item !== 'object') continue;
      if (!isMailcowActive((item as any).active)) continue;
      const gotoTargets = String((item as any).goto || '')
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const addr = String((item as any).address || '').trim();
      if (gotoTargets.includes(usernameLower) && EMAIL_REGEX.test(addr)) {
        emails.push(addr);
      }
    }
  }

  if (domainRes.status === 'fulfilled' && Array.isArray(domainRes.value)) {
    anySucceeded = true;
    const atIdx = usernameLower.indexOf('@');
    if (atIdx > 0) {
      const localPart = usernameLower.slice(0, atIdx);
      const targetDom = usernameLower.slice(atIdx + 1);
      for (const item of domainRes.value) {
        if (!item || typeof item !== 'object') continue;
        if (!isMailcowActive((item as any).active)) continue;
        const itemTarget = String((item as any).target_domain || '').trim().toLowerCase();
        const aliasDomain = String((item as any).alias_domain || '').trim();
        if (itemTarget === targetDom && aliasDomain) {
          const candidate = `${localPart}@${aliasDomain}`;
          if (EMAIL_REGEX.test(candidate)) {
            emails.push(candidate);
          }
        }
      }
    }
  }

  if (mailboxRes.status === 'fulfilled' && mailboxRes.value && typeof mailboxRes.value === 'object') {
    const rawMailbox = Array.isArray(mailboxRes.value)
      ? mailboxRes.value[0]
      : mailboxRes.value;
    if (rawMailbox && typeof rawMailbox === 'object') {
      anySucceeded = true;
      const mbName = String((rawMailbox as any).name || '').trim();
      if (
        mbName &&
        mbName.toLowerCase() !== usernameLower &&
        !mbName.includes('@')
      ) {
        displayName = normalizeDanishText(mbName);
      }

      const rawAcl =
        (rawMailbox as any)?.attributes?.sender_acl ?? (rawMailbox as any)?.sender_acl;
      const aclEntries: string[] = Array.isArray(rawAcl)
        ? rawAcl.map((x: unknown) => String(x || '').trim())
        : typeof rawAcl === 'string'
          ? rawAcl.split(/[\s,;]+/).map((s) => s.trim())
          : [];
      for (const entry of aclEntries) {
        if (entry && EMAIL_REGEX.test(entry)) {
          emails.push(entry);
        }
      }
    }
  }

  return { ok: anySucceeded, emails, displayName };
}

export async function discoverMailcowAliases(
  creds: CalDavCredentials,
  forceRefresh = false
): Promise<MailcowAliasDiscoveryResult> {
  const origin = new URL(normalizeMailcowUrl(creds.serverUrl)).origin.toLowerCase();
  const usernameLower = creds.username.trim().toLowerCase();
  const cacheKey = `${origin}::${usernameLower}`;

  if (!forceRefresh) {
    const cached = aliasDiscoveryCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ALIAS_CACHE_TTL_MS) {
      return cached.result;
    }
  }

  const [sogoRes, apiRes] = await Promise.all([
    discoverViaSogoDav(creds).catch(() => ({ ok: false, emails: [] as string[], displayName: undefined })),
    discoverViaMailcowApi(creds).catch(() => ({ ok: false, emails: [] as string[], displayName: undefined }))
  ]);

  const dedupedByLower = new Map<string, string>();
  if (EMAIL_REGEX.test(creds.username.trim())) {
    dedupedByLower.set(usernameLower, creds.username.trim());
  }

  for (const email of [...sogoRes.emails, ...apiRes.emails]) {
    const clean = email.trim();
    const lower = clean.toLowerCase();
    if (EMAIL_REGEX.test(clean) && !dedupedByLower.has(lower)) {
      dedupedByLower.set(lower, clean);
    }
  }

  const result: MailcowAliasDiscoveryResult = {
    emails: Array.from(dedupedByLower.values()),
    displayName: sogoRes.displayName || apiRes.displayName || undefined,
    sources: {
      sogoDav: sogoRes.ok,
      mailcowApi: apiRes.ok
    }
  };

  if (aliasDiscoveryCache.size > 500) {
    aliasDiscoveryCache.clear();
  }
  aliasDiscoveryCache.set(cacheKey, {
    fetchedAt: Date.now(),
    result
  });

  return result;
}

export async function resolveAliasesWithMailcow(
  creds: CalDavCredentials,
  forceRefresh = false,
  clearDismissed = false
): Promise<{
  aliases: SenderAliasRecord[];
  discoveredCount: number;
  sources: { sogoDav: boolean; mailcowApi: boolean };
}> {
  try {
    const discovery = await discoverMailcowAliases(creds, forceRefresh);
    const aliases = mergeDiscoveredAliasesForUser(
      creds.username,
      { emails: discovery.emails, displayName: discovery.displayName },
      { clearDismissed }
    );
    return {
      aliases,
      discoveredCount: discovery.emails.length,
      sources: discovery.sources
    };
  } catch (err) {
    console.warn('Mailcow alias-opdagelse fejlede, bruger lokale aliaser:', err);
    return {
      aliases: getAliasesForUser(creds.username),
      discoveredCount: 0,
      sources: { sogoDav: false, mailcowApi: false }
    };
  }
}
