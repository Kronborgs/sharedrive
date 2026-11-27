import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import net from 'node:net';

export interface MailServerCredentials {
  imapHost: string;
  imapServerName?: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpServerName?: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
  clientIp?: string;
}

export interface MailFolderDTO {
  path: string;
  name: string;
  delimiter: string;
  specialUse: 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk' | 'custom';
  totalMessages: number;
  unreadMessages: number;
}

export interface MailAddressDTO {
  name: string;
  address: string;
}

export interface MailAttachmentDTO {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  cid?: string;
  isInline: boolean;
  contentBase64?: string;
}

export interface MailHeaderDTO {
  uid: number;
  folder: string;
  messageId: string;
  subject: string;
  from: MailAddressDTO[];
  to: MailAddressDTO[];
  cc: MailAddressDTO[];
  date: string;
  size: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
}

export interface MailDetailDTO extends MailHeaderDTO {
  bcc: MailAddressDTO[];
  replyTo: MailAddressDTO[];
  inReplyTo?: string;
  references: string[];
  textBody: string;
  htmlBody: string;
  attachments: MailAttachmentDTO[];
  calendarInvite?: {
    summary: string;
    start?: string;
    end?: string;
    location?: string;
    organizer?: string;
    rawIcs: string;
  };
}

export interface SendMailPayload {
  fromEmail: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{
    filename: string;
    contentType: string;
    contentBase64: string;
  }>;
  saveToSent?: boolean;
}

/**
 * Sikkerhedsvalidering af server-hostname mod SSRF til localhost/metadata-endpoints,
 * medmindre der er tale om den konfigurerede DEFAULT_MAIL_HOST / DEFAULT_IMAP_HOST fra .env.
 */
export function normalizeAndValidateHost(rawInput: string, defaultEnvHost?: string): string {
  let clean = rawInput.trim();
  if (!clean && defaultEnvHost) {
    clean = defaultEnvHost.trim();
  }
  if (!clean) {
    throw new Error('Ingen mailserver angivet.');
  }

  // Fjern evt. https:// eller imaps:// præfiks og stier hvis brugeren indtastede en URL
  clean = clean.replace(/^[a-z0-9+.-]+:\/\//i, '').split('/')[0].split(':')[0].trim();

  if (!clean || /[\s/\\@?#]/.test(clean)) {
    throw new Error('Ugyldigt værtsnavn (hostname) for mailserver.');
  }

  // Hvis det er præcis den admin-konfigurerede standardserver fra .env, tillades den altid (f.eks. på internt Docker/Pangolin LAN)
  const allowedDefaults = [
    process.env.DEFAULT_MAIL_HOST,
    process.env.DEFAULT_IMAP_HOST,
    process.env.DEFAULT_SMTP_HOST
  ]
    .filter(Boolean)
    .map((h) => String(h).trim().toLowerCase());

  if (allowedDefaults.includes(clean.toLowerCase())) {
    return clean;
  }

  // Afvis loopback og cloud metadata IP'er for brugerindtastede servere
  const lower = clean.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '0.0.0.0' ||
    lower === '169.254.169.254' ||
    lower.endsWith('.localhost')
  ) {
    throw new Error('Af sikkerhedshensyn tillades lokale loopback/metadata-adresser ikke som brugerdefineret server.');
  }

  if (net.isIPv4(clean)) {
    if (clean.startsWith('127.') || clean.startsWith('169.254.') || clean.startsWith('0.')) {
      throw new Error('Ugyldig IP-adresse for mailserver.');
    }
  }

  return clean;
}

export function resolveServerConfig(input?: {
  serverHost?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
}): Omit<MailServerCredentials, 'username' | 'password'> {
  const envBaseHost = (process.env.DEFAULT_MAIL_HOST || '').trim();
  const envImapHost = (process.env.DEFAULT_IMAP_HOST || envBaseHost).trim();
  const envSmtpHost = (process.env.DEFAULT_SMTP_HOST || envBaseHost || envImapHost).trim();

  const customBase = (input?.serverHost || '').trim();
  const rawImapHost = (input?.imapHost || customBase || envImapHost).trim();
  const rawSmtpHost = (input?.smtpHost || customBase || envSmtpHost || rawImapHost).trim();

  const imapHost = normalizeAndValidateHost(rawImapHost, envImapHost);
  const smtpHost = normalizeAndValidateHost(rawSmtpHost, envSmtpHost);

  const imapPort = Number(input?.imapPort || process.env.DEFAULT_IMAP_PORT || 993);
  const imapSecure =
    input?.imapSecure !== undefined
      ? Boolean(input.imapSecure)
      : process.env.DEFAULT_IMAP_SECURE !== undefined
        ? process.env.DEFAULT_IMAP_SECURE !== 'false'
        : imapPort === 993;

  const smtpPort = Number(input?.smtpPort || process.env.DEFAULT_SMTP_PORT || 465);
  const smtpSecure =
    input?.smtpSecure !== undefined
      ? Boolean(input.smtpSecure)
      : process.env.DEFAULT_SMTP_SECURE !== undefined
        ? process.env.DEFAULT_SMTP_SECURE !== 'false'
        : smtpPort === 465;

  return {
    imapHost,
    imapPort,
    imapSecure,
    smtpHost,
    smtpPort,
    smtpSecure
  };
}

function createImapClient(creds: MailServerCredentials): ImapFlow {
  const allowInsecure = process.env.ALLOW_INSECURE_TLS === 'true';
  return new ImapFlow({
    host: creds.imapHost,
    servername: creds.imapServerName,
    port: creds.imapPort,
    secure: creds.imapSecure,
    auth: {
      user: creds.username,
      pass: creds.password
    },
    clientInfo: {
      name: 'Sharedrive',
      version: '1.0',
      ...(creds.clientIp && net.isIP(creds.clientIp) !== 0
        ? { 'x-originating-ip': creds.clientIp }
        : {})
    } as any,
    logger: false,
    tls: {
      rejectUnauthorized: !allowInsecure
    },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
}

export async function withImap<T>(creds: MailServerCredentials, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = createImapClient(creds);
  client.on('error', () => client.close());
  try {
    await client.connect();
    return await fn(client);
  } finally {
    if (client.usable) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    } else {
      client.close();
    }
  }
}

function detectSpecialUse(
  pathStr: string,
  nameStr: string,
  specialUseFlag?: string
): MailFolderDTO['specialUse'] {
  const flag = (specialUseFlag || '').toLowerCase();
  const lowerPath = pathStr.toLowerCase();
  const lowerName = nameStr.toLowerCase();

  if (lowerPath === 'inbox' || flag === '\\inbox') return 'inbox';
  if (flag === '\\sent' || /^(sent|sendt|sendte|sent items|sent messages)$/i.test(lowerName)) return 'sent';
  if (flag === '\\drafts' || /^(drafts|kladder|kladde)$/i.test(lowerName)) return 'drafts';
  if (flag === '\\trash' || /^(trash|papirkurv|deleted|deleted items|slettet)$/i.test(lowerName)) return 'trash';
  if (flag === '\\archive' || /^(archive|arkiv)$/i.test(lowerName)) return 'archive';
  if (flag === '\\junk' || /^(junk|spam|uønsket)$/i.test(lowerName)) return 'junk';
  return 'custom';
}

function translateFolderDisplayName(name: string, specialUse: MailFolderDTO['specialUse']): string {
  switch (specialUse) {
    case 'inbox':
      return 'Indbakke';
    case 'sent':
      return 'Sendt';
    case 'drafts':
      return 'Kladder';
    case 'trash':
      return 'Papirkurv';
    case 'archive':
      return 'Arkiv';
    case 'junk':
      return 'Spam';
    default:
      return name;
  }
}

/**
 * Henter alle IMAP-mapper inkl. antal ulæste og totale beskeder.
 */
export async function fetchMailFolders(creds: MailServerCredentials): Promise<MailFolderDTO[]> {
  return withImap(creds, async (client) => {
    const list = await client.list({
      statusQuery: {
        messages: true,
        unseen: true
      }
    });

    const folders: MailFolderDTO[] = list
      .filter((box) => !box.flags?.has('\\Noselect'))
      .map((box) => {
        const specialUse = detectSpecialUse(box.path, box.name, box.specialUse);
        return {
          path: box.path,
          name: translateFolderDisplayName(box.name, specialUse),
          delimiter: box.delimiter || '/',
          specialUse,
          totalMessages: Number(box.status?.messages || 0),
          unreadMessages: Number(box.status?.unseen || 0)
        };
      });

    const orderWeight: Record<MailFolderDTO['specialUse'], number> = {
      inbox: 1,
      drafts: 2,
      sent: 3,
      archive: 4,
      junk: 5,
      trash: 6,
      custom: 10
    };

    folders.sort((a, b) => {
      const wA = orderWeight[a.specialUse];
      const wB = orderWeight[b.specialUse];
      if (wA !== wB) return wA - wB;
      return a.name.localeCompare(b.name, 'da-DK');
    });

    return folders;
  });
}

function mapEnvelopeAddress(list?: Array<{ name?: string; address?: string }>): MailAddressDTO[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && (a.address || a.name))
    .map((a) => ({
      name: (a.name || '').trim(),
      address: (a.address || '').trim()
    }));
}

function bodyStructureHasAttachments(struct: any): boolean {
  if (!struct || typeof struct !== 'object') return false;
  const disp = String(struct.disposition || '').toLowerCase();
  if (disp === 'attachment') return true;
  if (
    disp === 'inline' &&
    struct.dispositionParameters?.filename &&
    !String(struct.type || '').toLowerCase().startsWith('text/')
  ) {
    return true;
  }
  if (
    struct.parameters?.name &&
    !String(struct.type || '').toLowerCase().startsWith('text/') &&
    !String(struct.type || '').toLowerCase().startsWith('multipart/')
  ) {
    return true;
  }
  if (Array.isArray(struct.childNodes)) {
    return struct.childNodes.some((child: any) => bodyStructureHasAttachments(child));
  }
  return false;
}

function parseMessageDate(envDate: unknown, internalDate: unknown): Date {
  for (const raw of [envDate, internalDate]) {
    if (raw instanceof Date && !isNaN(raw.getTime())) {
      return raw;
    }
    if (typeof raw === 'string' && raw.trim()) {
      const parsed = new Date(raw);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return new Date(0);
}

/**
 * Henter beskedoversigt (headers/envelopes) for en mappe, nyeste først.
 */
export async function fetchFolderMessages(
  creds: MailServerCredentials,
  folderPath: string,
  options?: { limit?: number; page?: number; offset?: number; searchQuery?: string }
): Promise<{ messages: MailHeaderDTO[]; total: number; unread: number }> {
  const limit = Math.min(1000, Math.max(20, Number(options?.limit || 100)));
  const page = Math.max(1, Number(options?.page || 1));
  const searchQuery = (options?.searchQuery || '').trim();
  const startIdx =
    options?.offset !== undefined && !isNaN(Number(options.offset))
      ? Math.max(0, Number(options.offset))
      : (page - 1) * limit;

  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folderPath, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      const total = mailbox ? Number(mailbox.exists || 0) : 0;
      if (total === 0) {
        return { messages: [], total: 0, unread: 0 };
      }

      let resultTotal = total;
      let rangeOrUids: string | number[] = '';
      let useUidFetch = false;

      if (searchQuery) {
        // Server-side IMAP søgning på tværs af emne, afsender og brødtekst
        const matchedUids = await client.search(
          {
            or: [
              { subject: searchQuery },
              { from: searchQuery },
              { to: searchQuery },
              { body: searchQuery }
            ]
          },
          { uid: true }
        );
        const uidList = Array.isArray(matchedUids) ? matchedUids : [];
        resultTotal = uidList.length;
        if (uidList.length === 0) {
          return { messages: [], total: 0, unread: 0 };
        }
        if (uidList.length > limit && uidList.length <= 2000) {
          const indexed: Array<{ uid: number; ts: number }> = [];
          for await (const meta of client.fetch(
            uidList,
            { uid: true, envelope: true, internalDate: true },
            { uid: true }
          )) {
            indexed.push({
              uid: meta.uid,
              ts: parseMessageDate(meta.envelope?.date, meta.internalDate).getTime()
            });
          }
          indexed.sort((a, b) => b.ts - a.ts || b.uid - a.uid);
          rangeOrUids = indexed.slice(startIdx, startIdx + limit).map((e) => e.uid);
        } else {
          uidList.sort((a, b) => b - a);
          rangeOrUids = uidList.slice(startIdx, startIdx + limit);
        }
        useUidFetch = true;
      } else {
        if (startIdx >= total) {
          const unseenUids = await client.search({ seen: false }, { uid: true });
          const unread = Array.isArray(unseenUids) ? unseenUids.length : 0;
          return { messages: [], total, unread };
        }
        if (total <= limit && startIdx === 0) {
          rangeOrUids = '1:*';
          useUidFetch = false;
        } else if (total <= 10000) {
          // Byg letvægts dato-indeks så mapper hvor ældre mails har høje sekvensnumre sorteres efter reel Date
          const dateIndex: Array<{ uid: number; ts: number }> = [];
          for await (const meta of client.fetch(
            '1:*',
            { uid: true, envelope: true, internalDate: true },
            { uid: false }
          )) {
            dateIndex.push({
              uid: meta.uid,
              ts: parseMessageDate(meta.envelope?.date, meta.internalDate).getTime()
            });
          }
          dateIndex.sort((a, b) => b.ts - a.ts || b.uid - a.uid);
          rangeOrUids = dateIndex.slice(startIdx, startIdx + limit).map((e) => e.uid);
          useUidFetch = true;
        } else {
          const endSeq = Math.max(1, total - startIdx);
          const startSeq = Math.max(1, endSeq - limit + 1);
          rangeOrUids = `${startSeq}:${endSeq}`;
        }
      }

      if (Array.isArray(rangeOrUids) && rangeOrUids.length === 0) {
        return { messages: [], total: resultTotal, unread: 0 };
      }

      const items: MailHeaderDTO[] = [];
      for await (const msg of client.fetch(
        rangeOrUids,
        {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
          size: true,
          bodyStructure: true
        },
        { uid: useUidFetch }
      )) {
        const env = msg.envelope || {};
        const flags = msg.flags || new Set<string>();
        const isoDate = parseMessageDate(env.date, msg.internalDate).toISOString();

        items.push({
          uid: msg.uid,
          folder: folderPath,
          messageId: env.messageId || `uid-${folderPath}-${msg.uid}`,
          subject: (env.subject || '(Intet emne)').trim(),
          from: mapEnvelopeAddress(env.from),
          to: mapEnvelopeAddress(env.to),
          cc: mapEnvelopeAddress(env.cc),
          date: isoDate,
          size: Number(msg.size || 0),
          seen: flags.has('\\Seen'),
          flagged: flags.has('\\Flagged'),
          answered: flags.has('\\Answered'),
          draft: flags.has('\\Draft'),
          hasAttachments: bodyStructureHasAttachments(msg.bodyStructure)
        });
      }

      items.sort((a, b) => {
        const diff = new Date(b.date).getTime() - new Date(a.date).getTime();
        return diff !== 0 ? diff : b.uid - a.uid;
      });

      let unreadCount = items.filter((m) => !m.seen).length;
      if (!searchQuery && total > items.length) {
        const unseenUids = await client.search({ seen: false }, { uid: true });
        if (Array.isArray(unseenUids)) {
          unreadCount = unseenUids.length;
        }
      }

      return {
        messages: items,
        total: resultTotal,
        unread: unreadCount
      };
    } finally {
      lock.release();
    }
  });
}

/**
 * Søger på tværs af ALLE IMAP-mapper (inkl. Indbakke, Sendt, Arkiv, Kladder, Spam og Papirkurv/Slettet).
 */
export async function searchAllFoldersMessages(
  creds: MailServerCredentials,
  searchQuery: string,
  maxPerFolder = 40
): Promise<{ messages: MailHeaderDTO[]; total: number }> {
  const q = searchQuery.trim();
  if (!q) {
    return { messages: [], total: 0 };
  }

  return withImap(creds, async (client) => {
    const boxes = await client.list({
      statusQuery: { messages: true }
    });
    const selectableBoxes = boxes.filter(
      (box) => !box.flags?.has('\\Noselect') && Number(box.status?.messages || 0) > 0
    );

    const allMatches: MailHeaderDTO[] = [];

    for (const box of selectableBoxes) {
      let lock;
      try {
        lock = await client.getMailboxLock(box.path, { readOnly: true });
      } catch {
        continue;
      }

      try {
        const matchedUids = await client.search(
          {
            or: [
              { subject: q },
              { from: q },
              { to: q },
              { body: q }
            ]
          },
          { uid: true }
        );
        const uidList = Array.isArray(matchedUids) ? matchedUids : [];
        if (uidList.length === 0) continue;

        uidList.sort((a, b) => b - a);
        const targetUids = uidList.slice(0, maxPerFolder);

        for await (const msg of client.fetch(
          targetUids,
          {
            uid: true,
            flags: true,
            envelope: true,
            internalDate: true,
            size: true,
            bodyStructure: true
          },
          { uid: true }
        )) {
          const env = msg.envelope || {};
          const flags = msg.flags || new Set<string>();
          const dateObj = env.date || msg.internalDate || new Date();
          const isoDate =
            dateObj instanceof Date && !isNaN(dateObj.getTime())
              ? dateObj.toISOString()
              : new Date().toISOString();

          allMatches.push({
            uid: msg.uid,
            folder: box.path,
            messageId: env.messageId || `uid-${box.path}-${msg.uid}`,
            subject: (env.subject || '(Intet emne)').trim(),
            from: mapEnvelopeAddress(env.from),
            to: mapEnvelopeAddress(env.to),
            cc: mapEnvelopeAddress(env.cc),
            date: isoDate,
            size: Number(msg.size || 0),
            seen: flags.has('\\Seen'),
            flagged: flags.has('\\Flagged'),
            answered: flags.has('\\Answered'),
            draft: flags.has('\\Draft'),
            hasAttachments: bodyStructureHasAttachments(msg.bodyStructure)
          });
        }
      } catch {
        // Ignorér fejl på enkelte specialmapper og fortsæt søgningen i de øvrige
      } finally {
        lock.release();
      }
    }

    allMatches.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      messages: allMatches,
      total: allMatches.length
    };
  });
}

function extractSimpleIcsInvite(rawIcs: string): MailDetailDTO['calendarInvite'] | undefined {
  if (!rawIcs.includes('BEGIN:VEVENT')) return undefined;
  const getField = (key: string): string | undefined => {
    const regex = new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, 'im');
    const match = rawIcs.match(regex);
    return match ? match[1].trim() : undefined;
  };
  const summary = getField('SUMMARY') || 'Mødeinvitation';
  const start = getField('DTSTART');
  const end = getField('DTEND');
  const location = getField('LOCATION');
  const organizer = getField('ORGANIZER')?.replace(/^mailto:/i, '');

  return {
    summary,
    start,
    end,
    location,
    organizer,
    rawIcs
  };
}

/**
 * Henter hele e-mailen (inkl. dekodet UTF-8 / ISO-8859-1 / Windows-1252 tekst, HTML og vedhæftningsliste).
 * Markerer automatisk beskeden som læst (\Seen), hvis markSeen = true.
 */
export async function fetchMessageDetail(
  creds: MailServerCredentials,
  folderPath: string,
  uid: number,
  markSeen = true,
  maxSize?: number
): Promise<MailDetailDTO> {
  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folderPath);
    try {
      if (maxSize !== undefined) {
        const metadata = await client.fetchOne(String(uid), { size: true }, { uid: true });
        if (!metadata || metadata.size === undefined || metadata.size > maxSize) {
          throw new Error('Beskeden er for stor eller findes ikke.');
        }
      }
      const msg = await client.fetchOne(
        String(uid),
        {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
          size: true,
          source: true
        },
        { uid: true }
      );

      if (!msg || !msg.source) {
        throw new Error('Beskeden blev ikke fundet i mappen.');
      }

      const flags = msg.flags || new Set<string>();
      const isDraftMsg =
        flags.has('\\Draft') || detectSpecialUse(folderPath, folderPath, undefined) === 'drafts';
      let isSeen = flags.has('\\Seen');

      if (markSeen && !isSeen) {
        try {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          isSeen = true;
        } catch {
          // Ignorér hvis mappen er read-only
        }
      }

      const parsed = await simpleParser(msg.source);

      // Udtræk inline cid-billeder som data-URL'er så de vises direkte i den isolerede mailvisning
      let htmlBody = typeof parsed.html === 'string' ? parsed.html : '';
      const attachments: MailAttachmentDTO[] = [];
      let calendarInvite: MailDetailDTO['calendarInvite'] | undefined;

      for (let i = 0; i < (parsed.attachments || []).length; i++) {
        const att = parsed.attachments[i];
        const contentType = (att.contentType || 'application/octet-stream').toLowerCase();
        const filename = att.filename || `vedhaeftning-${i + 1}`;
        const isInline = att.contentDisposition === 'inline' && Boolean(att.cid);

        if (
          !calendarInvite &&
          (contentType.includes('text/calendar') || filename.toLowerCase().endsWith('.ics')) &&
          att.content
        ) {
          calendarInvite = extractSimpleIcsInvite(att.content.toString('utf8'));
        }

        if (isInline && att.cid && htmlBody && contentType.startsWith('image/') && att.content.length < 2 * 1024 * 1024) {
          const dataUrl = `data:${contentType};base64,${att.content.toString('base64')}`;
          const escapedCid = att.cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          htmlBody = htmlBody.replace(new RegExp(`cid:${escapedCid}`, 'gi'), dataUrl);
        }

        attachments.push({
          id: String(i),
          filename,
          contentType: att.contentType || 'application/octet-stream',
          size: Number(att.size || att.content?.length || 0),
          cid: att.cid,
          isInline,
          ...(isDraftMsg && !isInline && att.content && att.content.length <= 18 * 1024 * 1024
            ? { contentBase64: att.content.toString('base64') }
            : {})
        });
      }

      const extractParsedAddresses = (addrObj: any): MailAddressDTO[] => {
        if (!addrObj) return [];
        const vals = Array.isArray(addrObj)
          ? addrObj.flatMap((a) => a.value || [])
          : Array.isArray(addrObj.value)
            ? addrObj.value
            : [];
        return vals
          .filter((v: any) => v && (v.address || v.name))
          .map((v: any) => ({
            name: (v.name || '').trim(),
            address: (v.address || '').trim()
          }));
      };

      const env = msg.envelope || {};
      const dateObj = parsed.date || env.date || msg.internalDate || new Date();
      const isoDate =
        dateObj instanceof Date && !isNaN(dateObj.getTime())
          ? dateObj.toISOString()
          : new Date().toISOString();

      const refsRaw = parsed.references;
      const references = Array.isArray(refsRaw)
        ? refsRaw
        : typeof refsRaw === 'string'
          ? [refsRaw]
          : [];

      return {
        uid: msg.uid,
        folder: folderPath,
        messageId: parsed.messageId || env.messageId || `uid-${folderPath}-${msg.uid}`,
        subject: (parsed.subject || env.subject || '(Intet emne)').trim(),
        from: extractParsedAddresses(parsed.from).length
          ? extractParsedAddresses(parsed.from)
          : mapEnvelopeAddress(env.from),
        to: extractParsedAddresses(parsed.to).length
          ? extractParsedAddresses(parsed.to)
          : mapEnvelopeAddress(env.to),
        cc: extractParsedAddresses(parsed.cc).length
          ? extractParsedAddresses(parsed.cc)
          : mapEnvelopeAddress(env.cc),
        bcc: extractParsedAddresses(parsed.bcc).length
          ? extractParsedAddresses(parsed.bcc)
          : mapEnvelopeAddress(env.bcc),
        replyTo: extractParsedAddresses(parsed.replyTo),
        inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : undefined,
        references,
        date: isoDate,
        size: Number(msg.size || 0),
        seen: isSeen,
        flagged: flags.has('\\Flagged'),
        answered: flags.has('\\Answered'),
        draft: flags.has('\\Draft'),
        hasAttachments: attachments.filter((a) => !a.isInline).length > 0,
        textBody: parsed.text || '',
        htmlBody,
        attachments,
        calendarInvite
      };
    } finally {
      lock.release();
    }
  });
}

export async function fetchRawEmail(creds: MailServerCredentials, folder: string, uid: number): Promise<Buffer | undefined> {
  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
      return message ? message.source : undefined;
    } finally {
      lock.release();
    }
  });
}

export async function importRawEmail(creds: MailServerCredentials, folder: string, raw: Buffer): Promise<void> {
  await withImap(creds, async (client) => {
    const result = await client.append(folder, raw);
    if (!result) throw new Error('IMAP kunne ikke gemme beskeden.');
  });
}

/**
 * Henter en specifik vedhæftning som binær Buffer til download.
 */
export async function downloadMessageAttachment(
  creds: MailServerCredentials,
  folderPath: string,
  uid: number,
  attachmentId: string
): Promise<{ filename: string; contentType: string; content: Buffer }> {
  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folderPath, { readOnly: true });
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, source: true },
        { uid: true }
      );
      if (!msg || !msg.source) {
        throw new Error('Beskeden blev ikke fundet.');
      }
      const parsed = await simpleParser(msg.source);
      const idx = Number(attachmentId);
      const att = (parsed.attachments || [])[idx];
      if (!att || !att.content) {
        throw new Error('Vedhæftningen blev ikke fundet.');
      }
      return {
        filename: att.filename || `vedhaeftning-${idx + 1}`,
        contentType: att.contentType || 'application/octet-stream',
        content: att.content
      };
    } finally {
      lock.release();
    }
  });
}

/**
 * Opdaterer IMAP-flag (\Seen, \Flagged, \Answered) på én eller flere beskeder.
 */
export async function updateMessageFlags(
  creds: MailServerCredentials,
  folderPath: string,
  uids: number[],
  flags: { seen?: boolean; flagged?: boolean; answered?: boolean }
): Promise<void> {
  if (uids.length === 0) return;
  const uidRange = uids.join(',');

  await withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folderPath);
    try {
      const toAdd: string[] = [];
      const toRemove: string[] = [];

      if (flags.seen === true) toAdd.push('\\Seen');
      if (flags.seen === false) toRemove.push('\\Seen');
      if (flags.flagged === true) toAdd.push('\\Flagged');
      if (flags.flagged === false) toRemove.push('\\Flagged');
      if (flags.answered === true) toAdd.push('\\Answered');
      if (flags.answered === false) toRemove.push('\\Answered');

      if (toAdd.length > 0) {
        await client.messageFlagsAdd(uidRange, toAdd, { uid: true });
      }
      if (toRemove.length > 0) {
        await client.messageFlagsRemove(uidRange, toRemove, { uid: true });
      }
    } finally {
      lock.release();
    }
  });
}

/**
 * Markerer ALLE ulæste beskeder i en given IMAP-mappe som læst (\Seen).
 */
export async function markAllFolderMessagesAsSeen(
  creds: MailServerCredentials,
  folderPath: string
): Promise<{ markedCount: number }> {
  return withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(folderPath);
    try {
      const unseenUids = await client.search({ seen: false }, { uid: true });
      const uidList = Array.isArray(unseenUids) ? unseenUids : [];
      if (uidList.length === 0) {
        return { markedCount: 0 };
      }
      await client.messageFlagsAdd(uidList, ['\\Seen'], { uid: true });
      return { markedCount: uidList.length };
    } finally {
      lock.release();
    }
  });
}

/**
 * Flytter eller kopierer én eller flere beskeder mellem IMAP-mapper.
 */
export async function transferMessages(
  creds: MailServerCredentials,
  sourceFolder: string,
  targetFolder: string,
  uids: number[],
  mode: 'MOVE' | 'COPY'
): Promise<void> {
  if (uids.length === 0 || sourceFolder === targetFolder) return;
  const uidRange = uids.join(',');

  await withImap(creds, async (client) => {
    const lock = await client.getMailboxLock(sourceFolder);
    try {
      if (mode === 'MOVE') {
        await client.messageMove(uidRange, targetFolder, { uid: true });
      } else {
        await client.messageCopy(uidRange, targetFolder, { uid: true });
      }
    } finally {
      lock.release();
    }
  });
}

/**
 * Sletter beskeder: Hvis de ikke allerede ligger i Papirkurv (Trash), flyttes de til Trash.
 * Hvis de allerede ligger i Trash (eller permanent = true), slettes de permanent.
 */
export async function deleteMessages(
  creds: MailServerCredentials,
  folderPath: string,
  uids: number[],
  permanent = false
): Promise<{ movedToTrash: boolean; trashFolder?: string }> {
  if (uids.length === 0) return { movedToTrash: false };
  const uidRange = uids.join(',');

  return withImap(creds, async (client) => {
    const trashBox = permanent
      ? undefined
      : (await client.list()).find(
          (b) => detectSpecialUse(b.path, b.name, b.specialUse) === 'trash'
        );

    const lock = await client.getMailboxLock(folderPath);
    try {
      if (!permanent && trashBox && trashBox.path !== folderPath) {
        await client.messageMove(uidRange, trashBox.path, { uid: true });
        return { movedToTrash: true, trashFolder: trashBox.path };
      } else {
        await client.messageDelete(uidRange, { uid: true });
        return { movedToTrash: false };
      }
    } finally {
      lock.release();
    }
  });
}

/**
 * Tømmer hele Papirkurv eller Spam-mappen permanent.
 */
export async function emptyImapFolder(
  creds: MailServerCredentials,
  folderPath: string
): Promise<{ deletedCount: number }> {
  return withImap(creds, async (client) => {
    const list = await client.list();
    const box = list.find((b) => b.path === folderPath);
    if (!box) {
      throw new Error('Mappen blev ikke fundet på IMAP-serveren.');
    }
    const special = detectSpecialUse(box.path, box.name, box.specialUse);
    if (special !== 'trash' && special !== 'junk') {
      throw new Error('Kun Papirkurv og Spam kan tømmes helt.');
    }

    const lock = await client.getMailboxLock(folderPath);
    try {
      const total = client.mailbox ? Number(client.mailbox.exists || 0) : 0;
      if (total === 0) {
        return { deletedCount: 0 };
      }
      await client.messageDelete('1:*', { uid: false });
      return { deletedCount: total };
    } finally {
      lock.release();
    }
  });
}

/**
 * Markerer e-mails som Spam (flytter til Junk/Spam-mappen og sætter $Junk flag så Rspamd på Mailcow/Dovecot lærer SPAM),
 * eller som "Ikke spam" (flytter fra Junk tilbage til INBOX og sætter $NotJunk så Rspamd lærer HAM).
 */
export async function reportSpamStatus(
  creds: MailServerCredentials,
  sourceFolder: string,
  uids: number[],
  isSpam: boolean
): Promise<{ targetFolder: string }> {
  if (uids.length === 0) {
    throw new Error('Ingen beskeder valgt.');
  }
  const uidRange = uids.join(',');

  return withImap(creds, async (client) => {
    const list = await client.list();
    let targetFolder = 'INBOX';

    if (isSpam) {
      let junkBox = list.find(
        (b) => detectSpecialUse(b.path, b.name, b.specialUse) === 'junk'
      );
      if (!junkBox) {
        targetFolder = 'Junk';
        try {
          await client.mailboxCreate(targetFolder);
        } catch {
          // Ignorér hvis den allerede eksisterer
        }
      } else {
        targetFolder = junkBox.path;
      }
    } else {
      const inboxBox = list.find(
        (b) => detectSpecialUse(b.path, b.name, b.specialUse) === 'inbox'
      );
      targetFolder = inboxBox ? inboxBox.path : 'INBOX';
    }

    const lock = await client.getMailboxLock(sourceFolder);
    try {
      try {
        if (isSpam) {
          await client.messageFlagsAdd(uidRange, ['$Junk', 'Junk'], { uid: true });
          await client.messageFlagsRemove(uidRange, ['$NotJunk', 'NotJunk', 'NonJunk'], { uid: true });
        } else {
          await client.messageFlagsAdd(uidRange, ['$NotJunk', 'NotJunk', 'NonJunk'], { uid: true });
          await client.messageFlagsRemove(uidRange, ['$Junk', 'Junk'], { uid: true });
        }
      } catch {
        // Visse IMAP-servere tillader ikke custom keywords; selve MOVE til/fra Junk trigger stadig Dovecot imap_sieve / Rspamd
      }

      if (sourceFolder !== targetFolder) {
        await client.messageMove(uidRange, targetFolder, { uid: true });
      }
    } finally {
      lock.release();
    }

    return { targetFolder };
  });
}

/**
 * Opretter, omdøber eller sletter en brugerdefineret IMAP-mappe.
 */
export async function createImapFolder(creds: MailServerCredentials, folderPath: string): Promise<void> {
  await withImap(creds, async (client) => {
    await client.mailboxCreate(folderPath);
  });
}

export async function renameImapFolder(
  creds: MailServerCredentials,
  oldPath: string,
  newPath: string
): Promise<void> {
  await withImap(creds, async (client) => {
    await client.mailboxRename(oldPath, newPath);
  });
}

export async function deleteImapFolder(creds: MailServerCredentials, folderPath: string): Promise<void> {
  await withImap(creds, async (client) => {
    await client.mailboxDelete(folderPath);
  });
}

function buildMailOptions(payload: SendMailPayload): SendMailOptions {
  const fromFormatted = payload.fromName?.trim()
    ? `"${payload.fromName.trim().replace(/"/g, '\\"')}" <${payload.fromEmail.trim()}>`
    : payload.fromEmail.trim();

  const attachments = (payload.attachments || []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType || 'application/octet-stream',
    content: Buffer.from(a.contentBase64, 'base64')
  }));

  return {
    from: fromFormatted,
    to: payload.to.join(', '),
    cc: payload.cc && payload.cc.length > 0 ? payload.cc.join(', ') : undefined,
    bcc: payload.bcc && payload.bcc.length > 0 ? payload.bcc.join(', ') : undefined,
    subject: payload.subject || '(Intet emne)',
    text: payload.textBody || '',
    html: payload.htmlBody || undefined,
    inReplyTo: payload.inReplyTo || undefined,
    references: payload.references && payload.references.length > 0 ? payload.references : undefined,
    attachments
  };
}

/**
 * Kompilerer en komplet RFC 5322 rå MIME-besked via Nodemailers indbyggede buffer-streamTransport
 * (undgår direkte dybe imports i nodemailer/lib/*, så det virker på tværs af alle Nodemailer-versioner).
 */
async function buildRawMimeBuffer(options: SendMailOptions): Promise<Buffer> {
  const rawTransporter = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows'
  });
  const compiled = await rawTransporter.sendMail(options);
  return Buffer.isBuffer(compiled.message)
    ? compiled.message
    : Buffer.from(String(compiled.message || ''), 'utf8');
}

/**
 * Sender en e-mail via SMTP med det valgte afsender-alias og gemmer en kopi i IMAP "Sendt"-mappen.
 */
export async function sendEmailViaSmtp(
  creds: MailServerCredentials,
  payload: SendMailPayload,
  replyMeta?: { folder: string; uid: number },
  replaceDraft?: { folder: string; uid: number }
): Promise<{ messageId: string }> {
  const allowInsecure = process.env.ALLOW_INSECURE_TLS === 'true';

  const transporter = nodemailer.createTransport({
    host: creds.smtpHost,
    port: creds.smtpPort,
    secure: creds.smtpSecure,
    requireTLS: !creds.smtpSecure,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    auth: {
      user: creds.username,
      pass: creds.password
    },
    tls: {
      rejectUnauthorized: !allowInsecure,
      servername: creds.smtpServerName
    }
  });

  const mailOptions = buildMailOptions(payload);
  const info = await transporter.sendMail(mailOptions).finally(() => transporter.close());

  // Gem en kopi i IMAP "Sendt"-mappen, sæt evt. \Answered flag og fjern evt. afsendt kladde fra "Kladder"
  if (payload.saveToSent !== false || (replaceDraft?.folder && replaceDraft?.uid)) {
    try {
      const rawBuffer =
        payload.saveToSent !== false
          ? await buildRawMimeBuffer({
              ...mailOptions,
              messageId: info.messageId,
              date: new Date()
            })
          : null;

      await withImap(creds, async (client) => {
        if (rawBuffer) {
          const list = await client.list();
          const sentBox = list.find(
            (b) => detectSpecialUse(b.path, b.name, b.specialUse) === 'sent'
          );
          if (sentBox) {
            await client.append(sentBox.path, rawBuffer, ['\\Seen']);
          }
        }
        if (replyMeta?.folder && replyMeta?.uid) {
          const lock = await client.getMailboxLock(replyMeta.folder);
          try {
            await client.messageFlagsAdd(String(replyMeta.uid), ['\\Answered'], { uid: true });
          } finally {
            lock.release();
          }
        }
        if (replaceDraft?.folder && replaceDraft?.uid) {
          try {
            const draftLock = await client.getMailboxLock(replaceDraft.folder);
            try {
              await client.messageDelete(String(replaceDraft.uid), { uid: true });
            } finally {
              draftLock.release();
            }
          } catch {
            // Ignorér hvis kladden allerede var slettet
          }
        }
      });
    } catch {
      // Mails på visse servere (f.eks. Gmail/Exchange) gemmer selv i Sendt automatisk, så vi fejler ikke hvis APPEND afvises
    }
  }

  return { messageId: info.messageId || '' };
}

/**
 * Gemmer en kladde i IMAP "Kladder"-mappen (Drafts) og erstatter evt. den tidligere kladde-version.
 */
export async function saveDraftToImap(
  creds: MailServerCredentials,
  payload: SendMailPayload,
  replaceDraft?: { folder: string; uid: number }
): Promise<{ folder: string }> {
  const mailOptions = buildMailOptions(payload);
  const rawBuffer = await buildRawMimeBuffer({
    ...mailOptions,
    date: new Date()
  });

  return withImap(creds, async (client) => {
    const list = await client.list();
    let draftsBox = list.find(
      (b) => detectSpecialUse(b.path, b.name, b.specialUse) === 'drafts'
    );
    const targetPath = draftsBox ? draftsBox.path : 'Drafts';
    if (!draftsBox) {
      try {
        await client.mailboxCreate(targetPath);
      } catch {
        // Ignorér hvis den allerede eksisterer
      }
    }
    await client.append(targetPath, rawBuffer, ['\\Seen', '\\Draft']);

    if (replaceDraft?.folder && replaceDraft?.uid) {
      try {
        const lock = await client.getMailboxLock(replaceDraft.folder);
        try {
          await client.messageDelete(String(replaceDraft.uid), { uid: true });
        } finally {
          lock.release();
        }
      } catch {
        // Ignorér hvis den gamle kladde allerede er slettet
      }
    }

    return { folder: targetPath };
  });
}
