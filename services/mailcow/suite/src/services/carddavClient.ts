import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { createDAVClient } from 'tsdav';
import {
  type CalDavCredentials,
  normalizeMailcowUrl,
  ensureTrailingSlash,
  assertSameServerOrigin,
  readResponseTextSmart,
  buildForwardedIpHeaders,
  createForwardedIpFetch
} from './davClient.js';
import { normalizeDanishText, sanitizeHttpUrl } from './icalMapper.js';

export interface AddressBookDTO {
  id: string;
  url: string;
  name: string;
  readOnly: boolean;
  isShared: boolean;
  owner?: string;
  ctag?: string;
  description?: string;
}

export interface ContactEmailDTO {
  type: 'work' | 'home' | 'other';
  value: string;
  pref?: boolean;
}

export interface ContactPhoneDTO {
  type: 'mobile' | 'work' | 'home' | 'other';
  value: string;
  pref?: boolean;
}

export interface ContactAddressDTO {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface ContactDTO {
  id: string;
  uid: string;
  addressBookId: string;
  fullName: string;
  firstName: string;
  lastName: string;
  nickname?: string;
  organization?: string;
  title?: string;
  emails: ContactEmailDTO[];
  phones: ContactPhoneDTO[];
  birthday?: string;
  anniversary?: string;
  anniversaryLabel?: string;
  address?: ContactAddressDTO;
  website?: string;
  notes?: string;
  categories: string[];
  starred?: boolean;
  photoDataUrl?: string | null;
  externalPhotoUrl?: string;
  vcardUrl?: string;
  etag?: string;
  rawVcard?: string;
  updatedAt?: string;
}

const STARRED_VCARD_TAGS = new Set([
  'starred',
  'favorit',
  'favoritter',
  'favorite',
  'favorites'
]);

function foldVcardLine(line: string, maxChars = 74): string {
  if (line.length <= maxChars) return line;
  const chunks: string[] = [];
  chunks.push(line.slice(0, maxChars));
  let offset = maxChars;
  const contLen = maxChars - 1;
  while (offset < line.length) {
    chunks.push(` ${line.slice(offset, offset + contLen)}`);
    offset += contLen;
  }
  return chunks.join('\r\n');
}

function canonicalAddressBookKey(rawUrl: string): string {
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

export function buildSogoUserContactsHomeUrl(serverUrl: string, username: string): string {
  const base = normalizeMailcowUrl(serverUrl);
  return `${base}${encodeURIComponent(username.trim())}/Contacts/`;
}

async function carddavRequest(
  creds: CalDavCredentials,
  method: string,
  url: string,
  body?: string,
  extraHeaders: Record<string, string> = {}
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
    body: body !== undefined ? Buffer.from(body, 'utf8') : undefined
  });

  if (!res.ok) {
    const text = (await readResponseTextSmart(res).catch(() => '')).slice(0, 300);
    throw new Error(
      `CardDAV ${method} mod ${url} fejlede (HTTP ${res.status} ${res.statusText})${text ? `: ${text}` : ''}`
    );
  }
  return res;
}

function detectAddressBookPermissions(
  bookUrl: string,
  displayName: string,
  normalizedUser: string
): { isShared: boolean; readOnly: boolean; owner?: string } {
  const decoded = decodeURIComponent(bookUrl || '');
  let isShared = false;
  let readOnly = false;
  let owner: string | undefined;

  if (/\/Contacts\/public(?:\/|$)/i.test(decoded)) {
    isShared = true;
    readOnly = true;
  }

  const sogoUserMatch = decoded.match(/\/SOGo\/dav\/([^/]+)\//i);
  if (sogoUserMatch && sogoUserMatch[1]) {
    const pathOwner = sogoUserMatch[1].toLowerCase().trim();
    if (pathOwner !== normalizedUser && pathOwner !== normalizedUser.split('@')[0]) {
      isShared = true;
      owner = sogoUserMatch[1];
    }
  }

  if (/_shared_/i.test(decoded) || /\((?:delt|shared|read-only|skrivebeskyttet)/i.test(displayName)) {
    isShared = true;
  }

  if (
    isShared &&
    (/read[-_\s]?only|skrivebeskyttet|kun\s+læs/i.test(displayName) ||
      /readonly/i.test(decoded) ||
      /\/Contacts\/public(?:\/|$)/i.test(decoded))
  ) {
    readOnly = true;
  }

  return { isShared, readOnly, owner };
}

async function fetchAddressBooksDirectPropfind(
  creds: CalDavCredentials,
  targetUrl: string,
  depth: '0' | '1' = '1'
): Promise<AddressBookDTO[]> {
  const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <CS:getctag/>
    <CR:addressbook-description/>
  </D:prop>
</D:propfind>`;

  const res = await carddavRequest(creds, 'PROPFIND', targetUrl, propfindXml, {
    'Content-Type': 'application/xml; charset=utf-8',
    Depth: depth
  });

  const xml = await readResponseTextSmart(res);
  const baseOrigin = new URL(targetUrl).origin;
  const normalizedUser = creds.username.toLowerCase().trim();
  const responseBlocks =
    xml.match(/<(?:[a-zA-Z0-9]+:)?response\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?response>/gi) || [];

  const results: AddressBookDTO[] = [];

  for (const block of responseBlocks) {
    const hrefMatch = block.match(/<(?:[a-zA-Z0-9]+:)?href[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?href>/i);
    if (!hrefMatch) continue;

    const fullUrl = ensureTrailingSlash(new URL(hrefMatch[1].trim(), baseOrigin).toString());
    const decodedFull = decodeURIComponent(fullUrl);
    if (/\/Contacts\/$/i.test(decodedFull)) {
      continue;
    }

    const resourceTypeMatch = block.match(
      /<(?:[a-zA-Z0-9]+:)?resourcetype[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?resourcetype>/i
    );
    const resourceTypeXml = resourceTypeMatch ? resourceTypeMatch[1] : '';
    const isAddressBook = /<(?:[a-zA-Z0-9]+:)?addressbook(?:\s|>|\/)/i.test(resourceTypeXml);
    if (!isAddressBook) {
      continue;
    }

    const displayNameMatch = block.match(
      /<(?:[a-zA-Z0-9]+:)?displayname[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?displayname>/i
    );
    const rawName = displayNameMatch
      ? normalizeDanishText(displayNameMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim())
      : '';

    const descMatch = block.match(
      /<(?:[a-zA-Z0-9]+:)?addressbook-description[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?addressbook-description>/i
    );
    const description = descMatch
      ? normalizeDanishText(descMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim())
      : undefined;

    const ctagMatch = block.match(
      /<(?:[a-zA-Z0-9]+:)?getctag[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?getctag>/i
    );

    const isPublicDir = /\/Contacts\/public\/$/i.test(decodedFull);
    const name = rawName || (isPublicDir ? 'Global Adressebog' : 'Personlig adressebog');
    const { isShared, readOnly, owner } = detectAddressBookPermissions(
      fullUrl,
      name,
      normalizedUser
    );

    results.push({
      id: fullUrl,
      url: fullUrl,
      name,
      readOnly,
      isShared,
      owner,
      ctag: ctagMatch ? ctagMatch[1].trim() : undefined,
      description
    });
  }

  return results;
}

/**
 * Henter alle brugerens CardDAV adressebøger (Mailcow / SOGo).
 */
export async function fetchAddressBooks(creds: CalDavCredentials): Promise<AddressBookDTO[]> {
  const normalizedUser = creds.username.toLowerCase().trim();
  const discoveredByKey = new Map<string, AddressBookDTO>();

  // 1. Direkte PROPFIND mod brugerens SOGo /Contacts/ mappe
  try {
    const homeUrl = buildSogoUserContactsHomeUrl(creds.serverUrl, creds.username);
    const directBooks = await fetchAddressBooksDirectPropfind(creds, homeUrl, '1');
    for (const book of directBooks) {
      const key = canonicalAddressBookKey(book.url);
      if (!discoveredByKey.has(key)) {
        discoveredByKey.set(key, book);
      }
    }
  } catch (err) {
    console.warn('Direkte CardDAV PROPFIND fejlede, prøver tsdav discovery:', err);
  }

  // 2. Fallback via tsdav CardDAV discovery
  if (discoveredByKey.size === 0) {
    try {
      const serverUrl = normalizeMailcowUrl(creds.serverUrl);
      const ipHeaders = buildForwardedIpHeaders(creds.clientIp);
      const client = await createDAVClient({
        serverUrl,
        credentials: {
          username: creds.username,
          password: creds.password
        },
        authMethod: 'Basic',
        defaultAccountType: 'carddav',
        fetch: createForwardedIpFetch(serverUrl, creds.clientIp),
        ...(Object.keys(ipHeaders).length > 0 ? { fetchOptions: { headers: ipHeaders } } : {})
      });

      const davBooks = await client.fetchAddressBooks();
      for (const book of davBooks) {
        const fullUrl = ensureTrailingSlash(book.url);
        const key = canonicalAddressBookKey(fullUrl);
        if (discoveredByKey.has(key)) continue;

        const name =
          typeof book.displayName === 'string' && book.displayName.trim()
            ? normalizeDanishText(book.displayName.trim())
            : 'Adressebog';

        const { isShared, readOnly, owner } = detectAddressBookPermissions(
          fullUrl,
          name,
          normalizedUser
        );

        discoveredByKey.set(key, {
          id: fullUrl,
          url: fullUrl,
          name,
          readOnly,
          isShared,
          owner,
          ctag: book.ctag,
          description: typeof book.description === 'string' ? book.description : undefined
        });
      }
    } catch (err) {
      console.warn('tsdav CardDAV discovery fejlede:', err);
    }
  }

  // 3. Sidste fallback: prøv standard SOGo personal adressebog
  if (discoveredByKey.size === 0) {
    const fallbackUrl = `${buildSogoUserContactsHomeUrl(creds.serverUrl, creds.username)}personal/`;
    await carddavRequest(creds, 'PROPFIND', fallbackUrl, undefined, { Depth: '0' });
    discoveredByKey.set(canonicalAddressBookKey(fallbackUrl), {
      id: fallbackUrl,
      url: fallbackUrl,
      name: 'Personlig adressebog',
      readOnly: false,
      isShared: false
    });
  }

  return Array.from(discoveredByKey.values());
}

function unfoldVcardLines(rawVcf: string): string[] {
  return rawVcf
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

function decodeQuotedPrintable(raw: string, charset = 'utf-8'): string {
  const cleaned = raw.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '=' && /^[0-9a-fA-F]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(cleaned.charCodeAt(i) & 0xff);
    }
  }
  const uint8 = new Uint8Array(bytes);
  try {
    return new TextDecoder(charset.toLowerCase().includes('iso') ? 'windows-1252' : 'utf-8', {
      fatal: true
    }).decode(uint8);
  } catch {
    return new TextDecoder('windows-1252').decode(uint8);
  }
}

function unescapeVcardText(val: string): string {
  return normalizeDanishText(
    val
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\')
  );
}

function escapeVcardText(val: string): string {
  return val
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function splitEscapedVcardFields(rawValue: string, separator = ';'): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (let i = 0; i < rawValue.length; i++) {
    const ch = rawValue[i];
    if (escaped) {
      current += `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function parseParamTypes(paramStr: string): string[] {
  const tokens: string[] = [];
  for (const part of paramStr.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq !== -1) {
      const key = trimmed.slice(0, eq).trim().toUpperCase();
      const val = trimmed.slice(eq + 1).trim().toUpperCase();
      if (key === 'TYPE') {
        tokens.push(...val.split(',').map((t) => t.trim()));
      } else {
        tokens.push(val);
      }
    } else {
      tokens.push(trimmed.toUpperCase());
    }
  }
  return tokens;
}

function normalizeEmailType(tokens: string[]): ContactEmailDTO['type'] {
  if (tokens.includes('WORK')) return 'work';
  if (tokens.includes('HOME')) return 'home';
  return 'other';
}

function normalizePhoneType(tokens: string[]): ContactPhoneDTO['type'] {
  if (tokens.includes('CELL') || tokens.includes('MOBILE')) return 'mobile';
  if (tokens.includes('WORK')) return 'work';
  if (tokens.includes('HOME')) return 'home';
  return 'other';
}

function normalizeBirthday(raw: string): string | undefined {
  const clean = raw.trim();
  if (!clean) return undefined;
  const compact = clean.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  const iso = clean.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) {
    return iso[1];
  }
  return undefined;
}

/**
 * Parser én eller flere vCard-blokke (RFC 2426 / 6350) til ContactDTO objekter.
 */
export function parseVcardToContacts(
  rawVcf: string,
  addressBookId: string,
  vcardUrl?: string,
  etag?: string
): ContactDTO[] {
  const normalizedInput = rawVcf.replace(/=\r?\n/g, '');
  const cardBlocks =
    normalizedInput.match(/BEGIN:VCARD[\s\S]*?END:VCARD/gi) || [];

  const contacts: ContactDTO[] = [];

  for (const block of cardBlocks) {
    const lines = unfoldVcardLines(block);
    let uid = '';
    let fullName = '';
    let firstName = '';
    let lastName = '';
    let nickname = '';
    let organization = '';
    let title = '';
    let birthday: string | undefined;
    let anniversary: string | undefined;
    let anniversaryLabel: string | undefined;
    let address: ContactAddressDTO | undefined;
    let website: string | undefined;
    let notes = '';
    let starred = false;
    const categories: string[] = [];
    const emails: ContactEmailDTO[] = [];
    const phones: ContactPhoneDTO[] = [];
    let photoDataUrl: string | undefined;
    let externalPhotoUrl: string | undefined;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || /^BEGIN:VCARD$/i.test(line) || /^END:VCARD$/i.test(line)) continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const leftPart = line.slice(0, colonIdx);
      let valuePart = line.slice(colonIdx + 1);

      const semiIdx = leftPart.indexOf(';');
      const propNameRaw = semiIdx === -1 ? leftPart : leftPart.slice(0, semiIdx);
      const paramStr = semiIdx === -1 ? '' : leftPart.slice(semiIdx + 1);
      // Fjern vCard item-præfiks (f.eks. item1.EMAIL)
      const propName = propNameRaw.replace(/^[^.]+\./, '').toUpperCase().trim();
      const paramUpper = paramStr.toUpperCase();

      if (paramUpper.includes('QUOTED-PRINTABLE')) {
        const charsetMatch = paramStr.match(/CHARSET=([^;]+)/i);
        valuePart = decodeQuotedPrintable(valuePart, charsetMatch?.[1] || 'utf-8');
      }

      const paramTokens = parseParamTypes(paramStr);

      switch (propName) {
        case 'UID':
          uid = valuePart.trim();
          break;
        case 'FN':
          fullName = unescapeVcardText(valuePart).trim();
          break;
        case 'N': {
          const nParts = splitEscapedVcardFields(valuePart, ';').map((p) =>
            unescapeVcardText(p).trim()
          );
          if (nParts[0]) lastName = nParts[0];
          if (nParts[1]) firstName = nParts[1];
          break;
        }
        case 'NICKNAME':
          nickname = unescapeVcardText(valuePart).trim();
          break;
        case 'ORG': {
          const orgParts = splitEscapedVcardFields(valuePart, ';')
            .map((p) => unescapeVcardText(p).trim())
            .filter(Boolean);
          organization = orgParts.join(' · ');
          break;
        }
        case 'TITLE':
          title = unescapeVcardText(valuePart).trim();
          break;
        case 'EMAIL': {
          const emailVal = unescapeVcardText(valuePart).trim();
          if (emailVal) {
            emails.push({
              type: normalizeEmailType(paramTokens),
              value: emailVal,
              pref: paramTokens.includes('PREF')
            });
          }
          break;
        }
        case 'TEL': {
          const phoneVal = unescapeVcardText(valuePart).trim();
          if (phoneVal) {
            phones.push({
              type: normalizePhoneType(paramTokens),
              value: phoneVal,
              pref: paramTokens.includes('PREF')
            });
          }
          break;
        }
        case 'BDAY':
          birthday = normalizeBirthday(valuePart);
          break;
        case 'ANNIVERSARY':
        case 'X-ANNIVERSARY':
        case 'X-SPOUSE-ANNIVERSARY': {
          const parsedAnniv = normalizeBirthday(valuePart);
          if (parsedAnniv) anniversary = parsedAnniv;
          break;
        }
        case 'X-ANNIVERSARY-LABEL': {
          const lbl = unescapeVcardText(valuePart).trim().slice(0, 40);
          if (lbl) anniversaryLabel = lbl;
          break;
        }
        case 'ADR': {
          const adrParts = splitEscapedVcardFields(valuePart, ';').map((p) =>
            unescapeVcardText(p).trim()
          );
          const street = adrParts[2] || '';
          const city = adrParts[3] || '';
          const postalCode = adrParts[5] || '';
          const country = adrParts[6] || '';
          if (street || city || postalCode) {
            address = { street, city, postalCode, country };
          }
          break;
        }
        case 'URL': {
          const safe = sanitizeHttpUrl(unescapeVcardText(valuePart).trim());
          if (safe) website = safe;
          break;
        }
        case 'NOTE':
          notes = unescapeVcardText(valuePart).trim();
          break;
        case 'CATEGORIES': {
          const cats = splitEscapedVcardFields(valuePart, ',')
            .map((c) => unescapeVcardText(c).trim())
            .filter(Boolean);
          for (const c of cats) {
            if (STARRED_VCARD_TAGS.has(c.toLowerCase())) {
              starred = true;
              continue;
            }
            if (!categories.includes(c)) categories.push(c);
          }
          break;
        }
        case 'X-FAVORITE':
        case 'X-STARRED': {
          const flag = valuePart.trim().toUpperCase();
          if (flag === 'TRUE' || flag === '1' || flag === 'YES') {
            starred = true;
          }
          break;
        }
        case 'PHOTO': {
          const trimmedVal = valuePart.trim();
          if (/^data:image\//i.test(trimmedVal) && trimmedVal.length < 1_000_000) {
            photoDataUrl = trimmedVal;
          } else if (/^https:\/\/\S+/i.test(trimmedVal) && trimmedVal.length < 2048) {
            externalPhotoUrl = trimmedVal;
          } else if (
            trimmedVal &&
            !/^https?:\/\//i.test(trimmedVal) &&
            (paramUpper.includes('ENCODING=B') ||
              paramUpper.includes('BASE64') ||
              /^[A-Za-z0-9+/=\s]{64,}$/.test(trimmedVal)) &&
            trimmedVal.length < 1_000_000
          ) {
            const mime =
              paramTokens.includes('PNG') || paramUpper.includes('IMAGE/PNG')
                ? 'image/png'
                : paramTokens.includes('WEBP') || paramUpper.includes('IMAGE/WEBP')
                  ? 'image/webp'
                  : paramTokens.includes('GIF') || paramUpper.includes('IMAGE/GIF')
                    ? 'image/gif'
                    : 'image/jpeg';
            photoDataUrl = `data:${mime};base64,${trimmedVal.replace(/\s+/g, '')}`;
          }
          break;
        }
        default:
          break;
      }
    }

    const finalUid = uid || crypto.randomUUID();
    const composedName = [firstName, lastName].filter(Boolean).join(' ').trim();
    const displayFullName =
      fullName || composedName || nickname || organization || emails[0]?.value || 'Unavngivet kontakt';

    if (!firstName && !lastName && fullName) {
      const tokens = fullName.split(/\s+/);
      if (tokens.length >= 2) {
        firstName = tokens.slice(0, -1).join(' ');
        lastName = tokens[tokens.length - 1];
      } else {
        firstName = fullName;
      }
    }

    contacts.push({
      id: `${addressBookId}::${finalUid}`,
      uid: finalUid,
      addressBookId,
      fullName: displayFullName,
      firstName,
      lastName,
      nickname: nickname || undefined,
      organization: organization || undefined,
      title: title || undefined,
      emails,
      phones,
      birthday,
      anniversary,
      anniversaryLabel: anniversary ? anniversaryLabel || 'Bryllupsdag' : undefined,
      address,
      website,
      notes: notes || undefined,
      categories,
      starred,
      photoDataUrl,
      externalPhotoUrl,
      vcardUrl,
      etag,
      rawVcard: block
    });
  }

  return contacts;
}

/**
 * Bygger en RFC 2426 vCard 3.0 UTF-8 streng ud fra en ContactDTO.
 * Bevarer evt. eksisterende PHOTO-linje fra rawVcard ved redigering.
 */
export function buildVcardFromContact(contact: ContactDTO): string {
  const uid = (contact.uid || crypto.randomUUID()).trim();
  const first = (contact.firstName || '').trim();
  const last = (contact.lastName || '').trim();
  const fullName =
    (contact.fullName || '').trim() ||
    [first, last].filter(Boolean).join(' ').trim() ||
    contact.organization ||
    contact.emails[0]?.value ||
    'Kontakt';

  const lines: string[] = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `PRODID:-//Sharedrive//CardDAV Client//DA`,
    `UID:${uid}`,
    `FN:${escapeVcardText(fullName)}`,
    `N:${escapeVcardText(last)};${escapeVcardText(first)};;;`
  ];

  if (contact.nickname?.trim()) {
    lines.push(`NICKNAME:${escapeVcardText(contact.nickname.trim())}`);
  }
  if (contact.organization?.trim()) {
    lines.push(`ORG:${escapeVcardText(contact.organization.trim())}`);
  }
  if (contact.title?.trim()) {
    lines.push(`TITLE:${escapeVcardText(contact.title.trim())}`);
  }

  for (const em of contact.emails || []) {
    const val = em.value.trim();
    if (!val) continue;
    const typeUpper = em.type === 'work' ? 'WORK' : em.type === 'home' ? 'HOME' : 'OTHER';
    const prefSuffix = em.pref ? ',PREF' : '';
    lines.push(`EMAIL;TYPE=INTERNET,${typeUpper}${prefSuffix}:${val}`);
  }

  for (const ph of contact.phones || []) {
    const val = ph.value.trim();
    if (!val) continue;
    const typeUpper =
      ph.type === 'mobile'
        ? 'CELL'
        : ph.type === 'work'
          ? 'WORK'
          : ph.type === 'home'
            ? 'HOME'
            : 'VOICE';
    const prefSuffix = ph.pref ? ',PREF' : '';
    lines.push(`TEL;TYPE=${typeUpper}${prefSuffix}:${val}`);
  }

  if (contact.birthday && /^\d{4}-\d{2}-\d{2}$/.test(contact.birthday.trim())) {
    lines.push(`BDAY:${contact.birthday.trim()}`);
  }

  if (contact.anniversary && /^\d{4}-\d{2}-\d{2}$/.test(contact.anniversary.trim())) {
    const cleanAnniv = contact.anniversary.trim();
    lines.push(`ANNIVERSARY:${cleanAnniv}`);
    lines.push(`X-ANNIVERSARY:${cleanAnniv}`);
    const cleanLabel = (contact.anniversaryLabel || 'Bryllupsdag').trim().slice(0, 40);
    if (cleanLabel) {
      lines.push(`X-ANNIVERSARY-LABEL:${escapeVcardText(cleanLabel)}`);
    }
  }

  if (
    contact.address &&
    (contact.address.street?.trim() ||
      contact.address.city?.trim() ||
      contact.address.postalCode?.trim())
  ) {
    lines.push(
      `ADR;TYPE=HOME:;;${escapeVcardText(contact.address.street || '')};${escapeVcardText(
        contact.address.city || ''
      )};;${escapeVcardText(contact.address.postalCode || '')};${escapeVcardText(
        contact.address.country || ''
      )}`
    );
  }

  const safeWebsite = sanitizeHttpUrl(contact.website);
  if (safeWebsite) {
    lines.push(`URL:${safeWebsite}`);
  }

  const mergedCategories = (contact.categories || [])
    .map((c) => c.trim())
    .filter((c) => Boolean(c) && !STARRED_VCARD_TAGS.has(c.toLowerCase()));
  if (contact.starred) {
    mergedCategories.push('Starred');
  }
  if (mergedCategories.length > 0) {
    const escapedCats = mergedCategories.map(escapeVcardText);
    lines.push(`CATEGORIES:${escapedCats.join(',')}`);
  }
  if (contact.starred) {
    lines.push('X-FAVORITE:TRUE');
  }

  if (contact.notes?.trim()) {
    lines.push(`NOTE:${escapeVcardText(contact.notes.trim())}`);
  }

  // Kontaktbillede: skriv nyt/eksisterende base64-billede (RFC 2426 foldet), eller udelad hvis eksplicit fjernet (null / '')
  if (typeof contact.photoDataUrl === 'string' && contact.photoDataUrl.trim().length > 0) {
    const dataMatch = contact.photoDataUrl
      .trim()
      .match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i);
    if (dataMatch) {
      const rawSub = dataMatch[1].toUpperCase();
      const vcardImgType = rawSub === 'JPG' ? 'JPEG' : rawSub;
      const cleanBase64 = dataMatch[2].replace(/\s+/g, '');
      if (cleanBase64.length > 0 && cleanBase64.length <= 750_000) {
        lines.push(foldVcardLine(`PHOTO;ENCODING=b;TYPE=${vcardImgType}:${cleanBase64}`));
      }
    }
  } else if (contact.photoDataUrl === undefined && contact.rawVcard) {
    const unfolded = unfoldVcardLines(contact.rawVcard);
    const photoLine = unfolded.find((l) => /^PHOTO[;:]/i.test(l.trim()));
    if (photoLine) {
      lines.push(foldVcardLine(photoLine.trim()));
    }
  }

  lines.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`);
  lines.push('END:VCARD');

  return `${lines.join('\r\n')}\r\n`;
}

const CTAG_CACHE_TTL_MS = 30 * 60 * 1000;
const contactsCache = new Map<
  string,
  { ctag: string; fetchedAt: number; contacts: ContactDTO[] }
>();

function getContactsCacheKey(creds: CalDavCredentials, bookUrl: string): string {
  return `${creds.serverUrl.trim().toLowerCase()}::${creds.username.trim().toLowerCase()}::${canonicalAddressBookKey(bookUrl)}`;
}

function invalidateUserContactsCache(creds: CalDavCredentials) {
  const prefix = `${creds.serverUrl.trim().toLowerCase()}::${creds.username.trim().toLowerCase()}::`;
  for (const key of contactsCache.keys()) {
    if (key.startsWith(prefix)) {
      contactsCache.delete(key);
    }
  }
}

async function fetchContactsFromAddressBookReport(
  creds: CalDavCredentials,
  book: AddressBookDTO
): Promise<ContactDTO[]> {
  const reportXml = `<?xml version="1.0" encoding="utf-8" ?>
<CR:addressbook-query xmlns:D="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <CR:address-data/>
  </D:prop>
</CR:addressbook-query>`;

  const bookUrl = ensureTrailingSlash(book.url);
  const res = await carddavRequest(creds, 'REPORT', bookUrl, reportXml, {
    'Content-Type': 'application/xml; charset=utf-8',
    Depth: '1'
  });

  const xml = await readResponseTextSmart(res);
  const baseOrigin = new URL(bookUrl).origin;
  const responseBlocks =
    xml.match(/<(?:[a-zA-Z0-9]+:)?response\b[\s\S]*?<\/(?:[a-zA-Z0-9]+:)?response>/gi) || [];

  const contacts: ContactDTO[] = [];

  for (const block of responseBlocks) {
    const hrefMatch = block.match(/<(?:[a-zA-Z0-9]+:)?href[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?href>/i);
    const dataMatch = block.match(
      /<(?:[a-zA-Z0-9]+:)?address-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?address-data>/i
    );
    if (!dataMatch) continue;

    const rawVcf = normalizeDanishText(
      dataMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
    );
    if (!/BEGIN:VCARD/i.test(rawVcf)) continue;

    const objectUrl = hrefMatch ? new URL(hrefMatch[1].trim(), baseOrigin).toString() : undefined;
    const etagMatch = block.match(
      /<(?:[a-zA-Z0-9]+:)?getetag[^>]*>([^<]+)<\/(?:[a-zA-Z0-9]+:)?getetag>/i
    );
    const etag = etagMatch ? etagMatch[1].trim().replace(/^["']|["']$/g, '') : undefined;

    const parsed = parseVcardToContacts(rawVcf, book.id, objectUrl, etag);
    contacts.push(...parsed);
  }

  return contacts;
}

/**
 * Henter alle kontakter fra de valgte CardDAV adressebøger (med ctag-cache).
 */
export async function fetchAllContacts(
  creds: CalDavCredentials,
  addressBooks: AddressBookDTO[]
): Promise<ContactDTO[]> {
  const allContacts: ContactDTO[] = [];

  await Promise.all(
    addressBooks.map(async (book) => {
      try {
        const cacheKey = getContactsCacheKey(creds, book.url);
        const cached = contactsCache.get(cacheKey);
        if (
          book.ctag &&
          cached &&
          cached.ctag === book.ctag &&
          Date.now() - cached.fetchedAt < CTAG_CACHE_TTL_MS
        ) {
          allContacts.push(...cached.contacts);
          return;
        }

        const list = await fetchContactsFromAddressBookReport(creds, book);
        if (book.ctag) {
          contactsCache.set(cacheKey, {
            ctag: book.ctag,
            fetchedAt: Date.now(),
            contacts: list
          });
        }
        allContacts.push(...list);
      } catch (err) {
        console.warn(`Kunne ikke hente kontakter fra ${book.name} (${book.url}):`, err);
      }
    })
  );

  return allContacts;
}

/**
 * Opretter eller opdaterer en kontakt på CardDAV-serveren (PUT text/vcard).
 */
export async function saveCardDavContact(
  creds: CalDavCredentials,
  contactDto: ContactDTO
): Promise<ContactDTO> {
  const uid = contactDto.uid || crypto.randomUUID();
  const normalizedDto: ContactDTO = {
    ...contactDto,
    uid
  };
  const vcardString = buildVcardFromContact(normalizedDto);
  const isUpdate = Boolean(contactDto.vcardUrl);
  const objectUrl = isUpdate
    ? (contactDto.vcardUrl as string)
    : `${ensureTrailingSlash(contactDto.addressBookId)}${encodeURIComponent(uid)}.vcf`;

  const res = await carddavRequest(creds, 'PUT', objectUrl, vcardString, {
    'Content-Type': 'text/vcard; charset=utf-8'
  });
  const newEtag = res.headers.get('etag') || undefined;
  invalidateUserContactsCache(creds);

  return {
    ...normalizedDto,
    photoDataUrl: normalizedDto.photoDataUrl || undefined,
    id: `${normalizedDto.addressBookId}::${uid}`,
    vcardUrl: objectUrl,
    etag: newEtag,
    rawVcard: vcardString,
    updatedAt: new Date().toISOString()
  };
}

function isPrivateOrReservedIp(ip: string): boolean {
  const clean = ip.trim().replace(/^::ffff:/i, '').toLowerCase();
  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(clean)) {
    if (
      clean === '::' ||
      clean === '::1' ||
      clean.startsWith('fc') ||
      clean.startsWith('fd') ||
      clean.startsWith('fe8') ||
      clean.startsWith('fe9') ||
      clean.startsWith('fea') ||
      clean.startsWith('feb')
    ) {
      return true;
    }
    return false;
  }
  return true;
}

async function fetchPhoto(start: URL) {
  let url = start;
  const signal = AbortSignal.timeout(5000);
  for (let redirect = 0; redirect < 4; redirect++) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif;q=0.9,*/*;q=0.1' },
      signal
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) return undefined;
    url = new URL(location, url);
  }
  return undefined;
}

/**
 * Henter et eksternt HTTPS kontaktbillede (f.eks. fra Google Kontakter .vcf-eksport) sikkert med SSRF-beskyttelse
 * og returnerer det som data:image/...;base64 til lagring i CardDAV.
 */
export async function fetchExternalContactPhotoAsDataUrl(
  rawUrl: string,
  maxBytes = 512 * 1024
): Promise<string | undefined> {
  try {
    const urlObj = new URL(rawUrl.trim());
    if (urlObj.protocol !== 'https:') return undefined;

    const host = urlObj.hostname.toLowerCase();
    if (
      !host ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return undefined;
    }

    if (net.isIP(host) !== 0) {
      if (isPrivateOrReservedIp(host)) return undefined;
    } else {
      const resolved = await dns.lookup(host, { all: true });
      if (!resolved.length || resolved.some((r) => isPrivateOrReservedIp(r.address))) {
        return undefined;
      }
    }

    const res = await fetchPhoto(urlObj);
    if (!res?.ok) return undefined;

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const mime = ct.includes('image/png')
      ? 'image/png'
      : ct.includes('image/webp')
        ? 'image/webp'
        : ct.includes('image/gif')
          ? 'image/gif'
          : ct.includes('image/jpeg') || ct.includes('image/jpg')
            ? 'image/jpeg'
            : '';
    if (!mime) return undefined;

    const contentLen = Number(res.headers.get('content-length') || 0);
    if (contentLen > maxBytes) return undefined;

    const arrayBuf = await res.arrayBuffer();
    if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > maxBytes) {
      return undefined;
    }

    const b64 = Buffer.from(arrayBuf).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch {
    return undefined;
  }
}

/**
 * Sletter en kontakt fra CardDAV-serveren via DELETE.
 */
export async function deleteCardDavContact(
  creds: CalDavCredentials,
  vcardUrl: string,
  _etag?: string
): Promise<void> {
  try {
    await carddavRequest(creds, 'DELETE', vcardUrl);
    invalidateUserContactsCache(creds);
  } catch (err: any) {
    if (String(err?.message || '').includes('HTTP 404')) return;
    throw err;
  }
}
