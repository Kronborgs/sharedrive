import {
  type CalDavCredentials,
  type CalendarInfoDTO,
  assertSameServerOrigin,
  ensureTrailingSlash,
  normalizeMailcowUrl,
  davRequest,
  readResponseTextSmart,
  escapeXml,
  decodeSogoSharedSlugOwner,
  buildForwardedIpHeaders
} from './davClient.js';
import { type CalendarSharePermission } from './userShareStore.js';

export interface SogoCalendarShare {
  id: string;
  ownerUsername: string;
  calendarUrl: string;
  calendarName: string;
  calendarColor: string;
  recipientEmail: string;
  recipientUid: string;
  recipientDisplayName?: string;
  permission: CalendarSharePermission;
  source: 'sogo';
  subscribedInSogo?: boolean;
  createdAt: string;
  updatedAt: string;
}

export class SogoAclUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SogoAclUnsupportedError';
  }
}

export class SogoAclValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SogoAclValidationError';
  }
}

const VALID_EMAIL_REGEX =
  /^[^\s@/\\:<>()[\],;"]+@[^\s@/\\:<>()[\],;"]+\.[a-zA-Z0-9-]{2,}$/;

const SOGO_WRITE_ROLES = new Set<string>([
  'ObjectCreator',
  'ObjectEraser',
  'ObjectEditor',
  'PublicModifier',
  'ConfidentialModifier',
  'PrivateModifier',
  'PublicResponder',
  'ConfidentialResponder',
  'PrivateResponder'
]);

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function isSogoShareId(shareId: string): boolean {
  return shareId.startsWith('sogo::');
}

export function encodeSogoShareId(calendarUrl: string, recipientUid: string): string {
  const payload = JSON.stringify({
    u: ensureTrailingSlash(calendarUrl.trim()),
    r: recipientUid.trim()
  });
  return `sogo::${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

function canonicalSogoDavUrl(rawUrl: string): string {
  try {
    const u = new URL(ensureTrailingSlash(rawUrl.trim()));
    const decoded = u.pathname
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
    return `${u.origin.toLowerCase()}${decoded}`;
  } catch {
    return ensureTrailingSlash(rawUrl.trim()).toLowerCase();
  }
}

function decodeSogoShareId(
  shareId: string
): { calendarUrl: string; recipientUid: string } | null {
  if (!isSogoShareId(shareId)) return null;
  const encoded = shareId.slice('sogo::'.length).trim();
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed.u === 'string' &&
      parsed.u.trim() &&
      typeof parsed.r === 'string' &&
      parsed.r.trim()
    ) {
      return {
        calendarUrl: ensureTrailingSlash(parsed.u.trim()),
        recipientUid: parsed.r.trim()
      };
    }
    return null;
  } catch {
    return null;
  }
}

function extractOwnedSogoCalendarPaths(
  creds: CalDavCredentials,
  calendarUrl: string
): {
  origin: string;
  ownerSegment: string;
  folderSlug: string;
  davCalendarUrl: string;
  sogoSoCalendarUrl: string;
} {
  const davCalendarUrl = ensureTrailingSlash(calendarUrl.trim());
  assertSameServerOrigin(davCalendarUrl, creds);

  let decoded = davCalendarUrl;
  try {
    decoded = decodeURIComponent(davCalendarUrl);
  } catch {
    decoded = davCalendarUrl;
  }

  if (/_shared_/i.test(decoded) || /\/Calendar\/public(?:\/|$)/i.test(decoded)) {
    throw new SogoAclValidationError('Delte eller offentlige kalendere kan ikke videredeles.');
  }

  const calMatch = decoded.match(/\/SOGo\/dav\/([^/]+)\/Calendar\/([^/]+)\/?$/i);
  if (!calMatch || !calMatch[1] || !calMatch[2]) {
    throw new SogoAclUnsupportedError('Kalender-URL bruger ikke SOGo/dav-format.');
  }

  const ownerSegment = calMatch[1].trim();
  const folderSlug = calMatch[2].trim();
  const userLower = creds.username.toLowerCase().trim();
  const ownerLower = ownerSegment.toLowerCase();

  if (ownerLower !== userLower && ownerLower !== userLower.split('@')[0]) {
    throw new SogoAclValidationError('Du kan kun dele dine egne kalendere med andre brugere.');
  }

  const origin = new URL(davCalendarUrl).origin;
  const sogoSoCalendarUrl = `${origin}/SOGo/so/${encodeURIComponent(ownerSegment)}/Calendar/${encodeURIComponent(folderSlug)}`;

  return {
    origin,
    ownerSegment,
    folderSlug,
    davCalendarUrl,
    sogoSoCalendarUrl
  };
}

async function sendSogoAclReport(
  creds: CalDavCredentials,
  davCalendarUrl: string,
  innerXml: string
): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?><acl-query xmlns="urn:inverse:params:xml:ns:inverse-dav">${innerXml}</acl-query>`;
  try {
    const res = await davRequest(
      creds,
      'REPORT',
      davCalendarUrl,
      body,
      { 'Content-Type': 'application/xml; charset=utf-8' },
      10000
    );
    if (res.status === 204) return '';
    return await readResponseTextSmart(res);
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/HTTP (?:404|405|501)\b/.test(msg)) {
      throw new SogoAclUnsupportedError(msg);
    }
    throw err;
  }
}

function parseSogoUserBlocks(
  xml: string,
  excludeUserLower: string
): Array<{ uid: string; email: string; displayName?: string }> {
  const userMatches = Array.from(
    xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?user\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?user>/gi)
  );
  const parsed: Array<{ uid: string; email: string; displayName?: string }> = [];
  const seen = new Set<string>();

  for (const um of userMatches) {
    const inner = um[1];
    const idMatch = inner.match(
      /<(?:[A-Za-z0-9_-]+:)?id\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?id>/i
    );
    const dnMatch = inner.match(
      /<(?:[A-Za-z0-9_-]+:)?displayName\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?displayName>/i
    );
    const mailMatch = inner.match(
      /<(?:[A-Za-z0-9_-]+:)?email\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?email>/i
    );

    const uid = idMatch ? unescapeXml(idMatch[1].trim()) : '';
    if (!uid || uid.startsWith('<')) continue;
    const uidLower = uid.toLowerCase();
    if (
      uidLower === 'anonymous' ||
      uidLower === '<default>' ||
      uidLower === excludeUserLower ||
      seen.has(uidLower)
    ) {
      continue;
    }
    seen.add(uidLower);

    const email = mailMatch ? unescapeXml(mailMatch[1].trim()) : uid;
    const displayName = dnMatch ? unescapeXml(dnMatch[1].trim()) : undefined;
    parsed.push({
      uid,
      email: email || uid,
      displayName: displayName && displayName !== uid ? displayName : undefined
    });
  }

  return parsed;
}

export async function searchSogoUsers(
  creds: CalDavCredentials,
  query: string
): Promise<Array<{ uid: string; email: string; displayName?: string }>> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const base = ensureTrailingSlash(normalizeMailcowUrl(creds.serverUrl));
  const rawUser = creds.username.trim();
  const userLower = rawUser.toLowerCase();
  const encodedUser = encodeURIComponent(rawUser);

  const principalCandidates = [`${base}${rawUser}/`];
  if (encodedUser !== rawUser) {
    principalCandidates.push(`${base}${encodedUser}/`);
  }

  // VIGTIGT: Ingen whitespace mellem <user-query> og <users/> (SOGo bruger DOM firstChild)
  const body = `<?xml version="1.0" encoding="utf-8"?><user-query xmlns="urn:inverse:params:xml:ns:inverse-dav"><users match-name="${escapeXml(cleanQuery)}"/></user-query>`;

  for (const userFolderUrl of principalCandidates) {
    try {
      const res = await davRequest(
        creds,
        'REPORT',
        userFolderUrl,
        body,
        { 'Content-Type': 'application/xml; charset=utf-8' },
        5000
      );
      if (res.status === 204) return [];
      const xml = await readResponseTextSmart(res);
      return parseSogoUserBlocks(xml, userLower);
    } catch {
      // Prøv næste kandidat eller returnér tom liste
    }
  }

  return [];
}

async function resolveSogoUserUid(
  creds: CalDavCredentials,
  emailOrUid: string
): Promise<{ uid: string; email: string; displayName?: string }> {
  const query = emailOrUid.trim();
  const queryLower = query.toLowerCase();

  try {
    const users = await searchSogoUsers(creds, query);
    for (const u of users) {
      if (u.uid.toLowerCase() === queryLower || u.email.toLowerCase() === queryLower) {
        return u;
      }
    }
  } catch {
    // Best-effort opslag – brug direkte e-mail som fallback
  }

  return {
    uid: queryLower,
    email: queryLower
  };
}

async function trySubscribeUserInSogo(
  creds: CalDavCredentials,
  sogoSoCalendarUrl: string,
  recipientUid: string
): Promise<boolean> {
  try {
    assertSameServerOrigin(sogoSoCalendarUrl, creds);
    const subscribeUrl = `${sogoSoCalendarUrl}/subscribeUsers?uids=${encodeURIComponent(recipientUid)}`;
    const auth = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');

    const res = await fetch(subscribeUrl, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json, text/plain, */*',
        ...buildForwardedIpHeaders(creds.clientIp)
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(6000)
    });

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    return res.status === 204 || (res.status >= 200 && res.status < 300 && !contentType.includes('text/html'));
  } catch (err: any) {
    console.warn('SOGo subscribeUsers fejlede (delingen er stadig aktiv):', err?.message || err);
    return false;
  }
}

function buildRolesXml(permission: CalendarSharePermission): string {
  if (permission === 'write') {
    return '<ObjectCreator/><ObjectEraser/><PublicModifier/><ConfidentialModifier/><PrivateDAndTViewer/>';
  }
  return '<PublicViewer/><ConfidentialViewer/><PrivateDAndTViewer/>';
}

function parseRolesFromAclXml(xml: string): string[] {
  const rolesBlockMatch = xml.match(
    /<(?:[A-Za-z0-9_-]+:)?roles\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?roles>/i
  );
  const content = rolesBlockMatch ? rolesBlockMatch[1] : xml;
  const tagMatches = content.matchAll(/<(?:[A-Za-z0-9_-]+:)?([A-Za-z0-9_]+)(?:\s*\/>|>)/g);
  const roles: string[] = [];

  for (const m of tagMatches) {
    const tag = m[1];
    if (tag && tag !== 'roles' && tag !== 'None' && tag !== 'acl-query') {
      roles.push(tag);
    }
  }

  return roles;
}

export interface KnownOutgoingSogoHint {
  calendarUrl: string;
  calendarName: string;
  calendarColor: string;
  recipientEmail: string;
  permission: CalendarSharePermission;
  createdAt: string;
  updatedAt: string;
}

export async function listSogoCalendarShares(
  creds: CalDavCredentials,
  calendars: CalendarInfoDTO[],
  knownHints: KnownOutgoingSogoHint[] = []
): Promise<{
  shares: SogoCalendarShare[];
  staleHints: Array<{ calendarUrl: string; recipientEmail: string }>;
}> {
  const ownCalendars = calendars.filter(
    (c) =>
      !c.isShared &&
      !c.isSubscribed &&
      !c.id.startsWith('sub::') &&
      /\/SOGo\/dav\//i.test(c.url || '')
  );

  if (ownCalendars.length === 0 && knownHints.length === 0) {
    return { shares: [], staleHints: [] };
  }

  const userLower = creds.username.toLowerCase().trim();
  const now = new Date().toISOString();

  const ownCalByCanon = new Map<string, CalendarInfoDTO>();
  for (const cal of ownCalendars) {
    ownCalByCanon.set(canonicalSogoDavUrl(cal.url), cal);
  }

  const allShares: SogoCalendarShare[] = [];
  const foundKeys = new Set<string>();
  const staleHints: Array<{ calendarUrl: string; recipientEmail: string }> = [];

  const perCalResults = await Promise.allSettled(
    ownCalendars.map(async (cal) => {
      const davUrl = ensureTrailingSlash(cal.url.trim());
      let userListXml = '';
      try {
        // params="nocn,noemail" undgår SOGo davRecordForUser-nedbrud ved ukendte/eksterne brugere
        userListXml = await sendSogoAclReport(creds, davUrl, '<user-list params="nocn,noemail"/>');
      } catch (err: any) {
        console.warn(
          `SOGo ACL <user-list params="nocn,noemail"/> fejlede for ${davUrl}, prøver fallback:`,
          err?.message || err
        );
        try {
          userListXml = await sendSogoAclReport(creds, davUrl, '<user-list/>');
        } catch (fallbackErr: any) {
          console.warn(
            `SOGo ACL <user-list/> fallback fejlede for ${davUrl}:`,
            fallbackErr?.message || fallbackErr
          );
          return [] as SogoCalendarShare[];
        }
      }

      if (!userListXml) return [] as SogoCalendarShare[];

      const parsedUsers = parseSogoUserBlocks(userListXml, userLower);
      if (parsedUsers.length === 0) return [] as SogoCalendarShare[];

      const roleChecks = await Promise.allSettled(
        parsedUsers.map(async (u) => {
          const rolesXml = await sendSogoAclReport(
            creds,
            davUrl,
            `<roles user="${escapeXml(u.uid)}"/>`
          );
          const roles = parseRolesFromAclXml(rolesXml);
          if (roles.length === 0) return null;

          const permission: CalendarSharePermission = roles.some((r) => SOGO_WRITE_ROLES.has(r))
            ? 'write'
            : 'read';

          const share: SogoCalendarShare = {
            id: encodeSogoShareId(davUrl, u.uid),
            ownerUsername: creds.username,
            calendarUrl: davUrl,
            calendarName: cal.name,
            calendarColor: cal.color || cal.serverColor || '#2563eb',
            recipientEmail: u.email,
            recipientUid: u.uid,
            recipientDisplayName: u.displayName,
            permission,
            source: 'sogo',
            createdAt: now,
            updatedAt: now
          };
          return share;
        })
      );

      const shares: SogoCalendarShare[] = [];
      for (const rc of roleChecks) {
        if (rc.status === 'fulfilled' && rc.value) {
          shares.push(rc.value);
        }
      }
      return shares;
    })
  );

  for (const res of perCalResults) {
    if (res.status === 'fulfilled') {
      for (const s of res.value) {
        const cUrl = canonicalSogoDavUrl(s.calendarUrl);
        foundKeys.add(`${cUrl}::${s.recipientUid.toLowerCase().trim()}`);
        foundKeys.add(`${cUrl}::${s.recipientEmail.toLowerCase().trim()}`);
        allShares.push(s);
      }
    }
  }

  // Sikring mod manglende/oversete delinger: verificér kendte Suite-oprettede SOGo-hints direkte mod SOGo
  const missingHints = knownHints.filter((hint) => {
    const cUrl = canonicalSogoDavUrl(hint.calendarUrl);
    const recipLower = hint.recipientEmail.toLowerCase().trim();
    return recipLower && recipLower !== userLower && !foundKeys.has(`${cUrl}::${recipLower}`);
  });

  if (missingHints.length > 0) {
    const hintChecks = await Promise.allSettled(
      missingHints.map(async (hint) => {
        const canonUrl = canonicalSogoDavUrl(hint.calendarUrl);
        const ownCal = ownCalByCanon.get(canonUrl);
        const davUrl = ownCal?.url
          ? ensureTrailingSlash(ownCal.url.trim())
          : ensureTrailingSlash(hint.calendarUrl.trim());
        const calName = ownCal?.name || hint.calendarName || 'Kalender';
        const calColor = ownCal?.color || ownCal?.serverColor || hint.calendarColor || '#2563eb';
        const recipientUid = hint.recipientEmail.trim();

        try {
          const rolesXml = await sendSogoAclReport(
            creds,
            davUrl,
            `<roles user="${escapeXml(recipientUid)}"/>`
          );
          const roles = parseRolesFromAclXml(rolesXml);
          if (roles.length === 0) {
            staleHints.push({ calendarUrl: davUrl, recipientEmail: hint.recipientEmail });
            return null;
          }

          const permission: CalendarSharePermission = roles.some((r) => SOGO_WRITE_ROLES.has(r))
            ? 'write'
            : 'read';

          const verified: SogoCalendarShare = {
            id: encodeSogoShareId(davUrl, recipientUid),
            ownerUsername: creds.username,
            calendarUrl: davUrl,
            calendarName: calName,
            calendarColor: calColor,
            recipientEmail: hint.recipientEmail,
            recipientUid,
            permission,
            source: 'sogo',
            createdAt: hint.createdAt || now,
            updatedAt: hint.updatedAt || now
          };
          return verified;
        } catch (err: any) {
          if (err instanceof SogoAclUnsupportedError) {
            return null;
          }
          console.warn(
            `SOGo ACL <roles> verificering af hint fejlede midlertidigt for ${recipientUid}:`,
            err?.message || err
          );
          const fallbackShare: SogoCalendarShare = {
            id: encodeSogoShareId(davUrl, recipientUid),
            ownerUsername: creds.username,
            calendarUrl: davUrl,
            calendarName: calName,
            calendarColor: calColor,
            recipientEmail: hint.recipientEmail,
            recipientUid,
            permission: hint.permission,
            source: 'sogo',
            createdAt: hint.createdAt || now,
            updatedAt: hint.updatedAt || now
          };
          return fallbackShare;
        }
      })
    );

    for (const hc of hintChecks) {
      if (hc.status === 'fulfilled' && hc.value) {
        const cUrl = canonicalSogoDavUrl(hc.value.calendarUrl);
        const uidKey = `${cUrl}::${hc.value.recipientUid.toLowerCase().trim()}`;
        if (!foundKeys.has(uidKey)) {
          foundKeys.add(uidKey);
          foundKeys.add(`${cUrl}::${hc.value.recipientEmail.toLowerCase().trim()}`);
          allShares.push(hc.value);
        }
      }
    }
  }

  allShares.sort((a, b) => {
    const calCmp = a.calendarName.localeCompare(b.calendarName, 'da');
    return calCmp !== 0 ? calCmp : a.recipientEmail.localeCompare(b.recipientEmail, 'da');
  });

  return { shares: allShares, staleHints };
}

export async function upsertSogoCalendarShare(params: {
  creds: CalDavCredentials;
  calendarUrl: string;
  calendarName: string;
  calendarColor?: string;
  recipientEmail: string;
  permission: CalendarSharePermission;
  subscribeRecipient?: boolean;
}): Promise<SogoCalendarShare> {
  const recipientEmail = params.recipientEmail.trim();
  const userLower = params.creds.username.toLowerCase().trim();

  if (!recipientEmail || !VALID_EMAIL_REGEX.test(recipientEmail)) {
    throw new SogoAclValidationError('Angiv en gyldig modtager e-mailadresse.');
  }

  if (recipientEmail.toLowerCase() === userLower) {
    throw new SogoAclValidationError('Du kan ikke dele en kalender med dig selv.');
  }

  const { davCalendarUrl, sogoSoCalendarUrl } = extractOwnedSogoCalendarPaths(
    params.creds,
    params.calendarUrl
  );

  const resolved = await resolveSogoUserUid(params.creds, recipientEmail);
  if (resolved.uid.toLowerCase() === userLower) {
    throw new SogoAclValidationError('Du kan ikke dele en kalender med dig selv.');
  }

  await sendSogoAclReport(
    params.creds,
    davCalendarUrl,
    `<add-user user="${escapeXml(resolved.uid)}"/>`
  );

  await sendSogoAclReport(
    params.creds,
    davCalendarUrl,
    `<set-roles user="${escapeXml(resolved.uid)}">${buildRolesXml(params.permission)}</set-roles>`
  );

  const subscribedInSogo =
    params.subscribeRecipient !== false
      ? await trySubscribeUserInSogo(params.creds, sogoSoCalendarUrl, resolved.uid)
      : undefined;

  const safeColor = /^#[0-9a-fA-F]{6}$/.test(params.calendarColor || '')
    ? (params.calendarColor as string)
    : '#2563eb';
  const cleanName = params.calendarName.trim() || 'Delt kalender';
  const now = new Date().toISOString();

  return {
    id: encodeSogoShareId(davCalendarUrl, resolved.uid),
    ownerUsername: params.creds.username,
    calendarUrl: davCalendarUrl,
    calendarName: cleanName,
    calendarColor: safeColor,
    recipientEmail: resolved.email || recipientEmail,
    recipientUid: resolved.uid,
    recipientDisplayName: resolved.displayName,
    permission: params.permission,
    source: 'sogo',
    subscribedInSogo,
    createdAt: now,
    updatedAt: now
  };
}

export async function updateSogoCalendarSharePermission(
  creds: CalDavCredentials,
  shareId: string,
  permission: CalendarSharePermission,
  meta?: { calendarName?: string; calendarColor?: string }
): Promise<SogoCalendarShare> {
  const decoded = decodeSogoShareId(shareId);
  if (!decoded) {
    throw new SogoAclValidationError('Ugyldigt SOGo delings-ID.');
  }

  const { davCalendarUrl } = extractOwnedSogoCalendarPaths(creds, decoded.calendarUrl);

  await sendSogoAclReport(
    creds,
    davCalendarUrl,
    `<set-roles user="${escapeXml(decoded.recipientUid)}">${buildRolesXml(permission)}</set-roles>`
  );

  const safeColor = /^#[0-9a-fA-F]{6}$/.test(meta?.calendarColor || '')
    ? (meta!.calendarColor as string)
    : '#2563eb';
  const now = new Date().toISOString();

  return {
    id: encodeSogoShareId(davCalendarUrl, decoded.recipientUid),
    ownerUsername: creds.username,
    calendarUrl: davCalendarUrl,
    calendarName: meta?.calendarName?.trim() || 'Kalender',
    calendarColor: safeColor,
    recipientEmail: decoded.recipientUid,
    recipientUid: decoded.recipientUid,
    permission,
    source: 'sogo',
    createdAt: now,
    updatedAt: now
  };
}

export async function revokeSogoCalendarShare(
  creds: CalDavCredentials,
  shareId: string
): Promise<{ calendarUrl: string; recipientUid: string }> {
  const decoded = decodeSogoShareId(shareId);
  if (!decoded) {
    throw new SogoAclValidationError('Ugyldigt SOGo delings-ID.');
  }

  const { davCalendarUrl } = extractOwnedSogoCalendarPaths(creds, decoded.calendarUrl);

  await sendSogoAclReport(
    creds,
    davCalendarUrl,
    `<remove-user user="${escapeXml(decoded.recipientUid)}"/>`
  );

  return {
    calendarUrl: davCalendarUrl,
    recipientUid: decoded.recipientUid
  };
}

export async function subscribeToSogoSharedCalendar(
  creds: CalDavCredentials,
  calendarUrl: string
): Promise<boolean> {
  try {
    const targetUrl = ensureTrailingSlash(calendarUrl.trim());
    assertSameServerOrigin(targetUrl, creds);
    const body =
      '<?xml version="1.0" encoding="utf-8"?><subscribe xmlns="urn:inverse:params:xml:ns:inverse-dav"/>';
    await davRequest(
      creds,
      'POST',
      targetUrl,
      body,
      { 'Content-Type': 'application/xml; charset=utf-8' },
      6000
    );
    return true;
  } catch {
    return false;
  }
}

export async function unsubscribeFromSogoSharedCalendar(
  creds: CalDavCredentials,
  calendarUrl: string
): Promise<boolean> {
  const targetUrl = ensureTrailingSlash(calendarUrl.trim());
  assertSameServerOrigin(targetUrl, creds);

  const origin = new URL(targetUrl).origin;
  const slugDecoded = decodeSogoSharedSlugOwner(targetUrl, creds.username.toLowerCase().trim());

  const davCandidates = new Set<string>([targetUrl]);
  if (slugDecoded.owner && slugDecoded.slug) {
    davCandidates.add(
      `${origin}/SOGo/dav/${encodeURIComponent(slugDecoded.owner)}/Calendar/${encodeURIComponent(slugDecoded.slug)}/`
    );
    davCandidates.add(`${origin}/SOGo/dav/${slugDecoded.owner}/Calendar/${slugDecoded.slug}/`);
  }

  const body = '<?xml version="1.0" encoding="utf-8"?><unsubscribe xmlns="urn:inverse:params:xml:ns:inverse-dav"/>';

  for (const candUrl of davCandidates) {
    try {
      await davRequest(
        creds,
        'POST',
        candUrl,
        body,
        { 'Content-Type': 'application/xml; charset=utf-8' },
        6000
      );
      return true;
    } catch {
      // Prøv næste kandidat
    }
  }

  if (slugDecoded.owner && slugDecoded.slug) {
    try {
      const soUnsubUrl = `${origin}/SOGo/so/${encodeURIComponent(slugDecoded.owner)}/Calendar/${encodeURIComponent(slugDecoded.slug)}/unsubscribe`;
      assertSameServerOrigin(soUnsubUrl, creds);
      const auth = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');
      const res = await fetch(soUnsubUrl, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          ...buildForwardedIpHeaders(creds.clientIp)
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(6000)
      });
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      return res.status === 204 || (res.status >= 200 && res.status < 300 && !contentType.includes('text/html'));
    } catch {
      return false;
    }
  }

  return false;
}
