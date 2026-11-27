import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { buildInvitationSeries, readCalendarInvitation } from '../../../src/calendarInvitation.ts';
import {
  type CalDavCredentials,
  type CalendarInfoDTO,
  fetchCalendars,
  fetchOwnCalendarsFast,
  fetchSingleCalendarByUrl,
  verifyAndFetchSharedCalendar,
  fetchUserSharedCalendarsForOwner,
  searchSogoSharedCalendarsByOwnerQuery,
  canonicalSogoCalendarSignature,
  fetchAllEvents,
  saveCalDavEvent,
  findCalendarEventByUid,
  deleteCalDavEvent,
  updateEventRsvp,
  normalizeMailcowUrl,
  ensureTrailingSlash,
  createCalDavCalendar,
  deleteCalDavCalendar,
  renameCalDavCalendar,
  updateCalDavCalendarColor
} from '../services/davClient.js';
import {
  type CalendarEventDTO,
  type AttendeeDTO,
  parseIcsToEvents,
  buildCalendarExportIcs,
  normalizeDanishText
} from '../services/icalMapper.js';
import {
  listSharesForUser,
  createShareLink,
  deleteShareLink,
  resolveShareToken,
  shareExpired
} from '../services/shareStore.js';
import {
  type CalendarSharePermission,
  listOutgoingUserShares,
  listOutgoingSogoShareHints,
  upsertUserCalendarShare,
  updateUserCalendarSharePermission,
  deleteUserCalendarShare,
  removeUserCalendarShareByTarget,
  upsertSogoShareHint,
  updateSogoShareHintPermission,
  resolveIncomingSogoHintsForRecipient,
  leaveIncomingUserCalendarShare,
  resolveIncomingSharesForRecipient,
  findAuthorizedIncomingShareForUrl,
  isUrlInsideSharedCalendar
} from '../services/userShareStore.js';
import {
  isSogoShareId,
  SogoAclUnsupportedError,
  SogoAclValidationError,
  listSogoCalendarShares,
  upsertSogoCalendarShare,
  updateSogoCalendarSharePermission,
  revokeSogoCalendarShare,
  subscribeToSogoSharedCalendar,
  unsubscribeFromSogoSharedCalendar,
  searchSogoUsers
} from '../services/sogoAclService.js';
import {
  getCalendarNameOverrides,
  resolveCalendarNameOverride,
  setCalendarNameOverride,
  getCalendarColorOverrides,
  resolveCalendarColorOverride,
  setCalendarColorOverride,
  isSharedCalendarDismissed,
  addDismissedSharedCalendar,
  removeDismissedSharedCalendar,
  removeDismissedSharedCalendarForEmails,
  clearDismissedSharedCalendars
} from '../services/calendarPrefsStore.js';
import {
  getAliasesForUser,
  findUsernamesOwningEmail
} from '../services/aliasStore.js';
import {
  getUserContactPrefs,
  setUserBirthdayCalendarSync,
  setUserContactCalendarColor
} from '../services/contactPrefsStore.js';
import {
  isBrogaardBirthdayCalendarUrl,
  syncContactBirthdaysToCalDav,
  disableContactBirthdaysCalDavSync,
  maybeAutoSyncContactBirthdays
} from '../services/birthdayCaldavSync.js';
import {
  addUserSubscription,
  removeUserSubscription,
  updateUserSubscriptionColor,
  syncUserSubscriptions
} from '../services/subscriptionService.js';
import {
  createRateLimiter,
  requireDavCredentials
} from '../services/sessionAuth.js';

export const caldavRouter = Router();

class ForbiddenShareError extends Error {
  statusCode = 403;
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenShareError';
  }
}

function getCallerIdentityEmails(username: string): string[] {
  const list = [username.trim(), ...getAliasesForUser(username).map((a) => a.email.trim())];
  return Array.from(new Set(list.map((e) => e.toLowerCase()).filter(Boolean)));
}

function resolveEffectiveDavCredentials(
  callerCreds: CalDavCredentials,
  targetUrl: string,
  requiredAccess: 'read' | 'write'
): { creds: CalDavCredentials; sharedCalendarUrl?: string } {
  const identityEmails = getCallerIdentityEmails(callerCreds.username);
  const incomingMatch = findAuthorizedIncomingShareForUrl(identityEmails, targetUrl);
  if (!incomingMatch) {
    return { creds: callerCreds };
  }
  if (requiredAccess === 'write' && incomingMatch.share.permission !== 'write') {
    throw new ForbiddenShareError(
      `Du har kun læserettigheder til denne kalender (delt af ${incomingMatch.share.ownerUsername}).`
    );
  }
  return {
    creds: {
      ...incomingMatch.ownerCreds,
      clientIp: callerCreds.clientIp
    },
    sharedCalendarUrl: incomingMatch.share.calendarUrl
  };
}

function canonicalCalKey(rawUrl: string): string {
  try {
    const u = new URL(ensureTrailingSlash(rawUrl.trim()));
    const decoded = u.pathname
      .split('/')
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      })
      .join('/')
      .toLowerCase();
    return `${u.origin.toLowerCase()}${decoded}`;
  } catch {
    return ensureTrailingSlash(rawUrl.trim()).toLowerCase();
  }
}

const publicShareLimiter = createRateLimiter(
  60,
  60 * 1000,
  'For mange forespørgsler. Prøv igen om et øjeblik.'
);

const SEARCH_EMAIL_REGEX =
  /^[^\s@/\\:<>()[\],;"]+@[^\s@/\\:<>()[\],;"]+\.[a-zA-Z0-9-]{2,}$/;

function sendCompressedJson(req: Request, res: Response, payload: unknown) {
  const jsonStr = JSON.stringify(payload);
  const acceptEnc = String(req.headers['accept-encoding'] || '');
  if (jsonStr.length > 2048 && acceptEnc.includes('gzip')) {
    const gz = zlib.gzipSync(jsonStr, { level: 6 });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.send(gz);
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(jsonStr);
}

/**
 * POST /api/caldav/sync
 */
caldavRouter.post('/sync', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const timeRange = req.body?.timeRange as { start: string; end: string } | undefined;
    const clientSubscriptions = Array.isArray(req.body?.subscriptions)
      ? req.body.subscriptions
      : undefined;
    const forceBirthdaySync = Boolean(req.body?.forceBirthdaySync);

    const identityEmails = getCallerIdentityEmails(creds.username);
    const incomingShares = resolveIncomingSharesForRecipient(identityEmails);
    const incomingSogoHints = resolveIncomingSogoHintsForRecipient(identityEmails);
    const activeIncomingKeys = new Set(
      incomingShares.map((item) => canonicalCalKey(item.share.calendarUrl))
    );

    await maybeAutoSyncContactBirthdays(creds, forceBirthdaySync ? 0 : undefined);

    const [caldavCalendars, subData] = await Promise.all([
      fetchCalendars(creds),
      syncUserSubscriptions(creds, clientSubscriptions)
    ]);

    let dismissedSharedCount = 0;
    const visibleCaldavCalendars = caldavCalendars.filter((c) => {
      if (!c.isShared || activeIncomingKeys.has(canonicalCalKey(c.url))) return true;
      if (isSharedCalendarDismissed(creds.username, c.id, c.url)) {
        dismissedSharedCount += 1;
        return false;
      }
      return true;
    });

    const ownCalHomePrefix = `/SOGo/dav/${creds.username.toLowerCase().trim()}/`;
    for (const c of visibleCaldavCalendars) {
      if (c.isShared && c.url) {
        let dec = c.url;
        try {
          dec = decodeURIComponent(c.url);
        } catch {
          dec = c.url;
        }
        if (
          /\/SOGo\/dav\/[^/]+\/Calendar\/[^/]+\/?$/i.test(dec) &&
          !dec.toLowerCase().includes(ownCalHomePrefix)
        ) {
          void subscribeToSogoSharedCalendar(creds, c.url).catch(() => {});
        }
      }
    }

    const contactPrefs = getUserContactPrefs(creds.username);
    for (const c of visibleCaldavCalendars) {
      if (!c.isShared && isBrogaardBirthdayCalendarUrl(c.url, contactPrefs.birthdayCalendarUrl)) {
        c.isContactBirthdays = true;
        c.readOnly = true;
      }
    }

    const mergedCalendars: CalendarInfoDTO[] = [...visibleCaldavCalendars];
    const caldavEvents = await fetchAllEvents(creds, visibleCaldavCalendars, timeRange);
    const mergedEvents: CalendarEventDTO[] = [...caldavEvents];

    // Hent kalendere delt direkte med denne bruger i Brogaard Suite (Read / Write delegation)
    if (incomingShares.length > 0) {
      const shareSlug = (url: string): string => {
        try {
          const m = decodeURIComponent(url).match(/\/Calendar\/([^/]+)\/?$/i);
          return m ? m[1].toLowerCase() : '';
        } catch {
          return '';
        }
      };

      const fetchedShares = await Promise.allSettled(
        incomingShares.map(async ({ share, ownerCreds }) => {
          const effectiveOwnerCreds: CalDavCredentials = {
            ...ownerCreds,
            clientIp: creds.clientIp
          };
          const calMeta = await fetchSingleCalendarByUrl(
            effectiveOwnerCreds,
            share.calendarUrl,
            share.calendarName,
            share.calendarColor
          );
          const sharedCal: CalendarInfoDTO = {
            ...calMeta,
            id: share.calendarUrl,
            url: share.calendarUrl,
            name: share.calendarName || calMeta.name,
            color: share.calendarColor || calMeta.color,
            serverColor: share.calendarColor || calMeta.serverColor,
            readOnly: share.permission !== 'write',
            isShared: true,
            sharePermission: share.permission,
            userShareId: share.id,
            owner: share.ownerUsername
          };
          const sharedEvents = await fetchAllEvents(effectiveOwnerCreds, [sharedCal], timeRange);
          return { share, sharedCal, sharedEvents };
        })
      );

      for (const resItem of fetchedShares) {
        if (resItem.status !== 'fulfilled') continue;
        const { share, sharedCal, sharedEvents } = resItem.value;
        const shareKey = canonicalCalKey(share.calendarUrl);
        const targetSlug = shareSlug(share.calendarUrl);

        const exactMatch = mergedCalendars.find((c) => canonicalCalKey(c.url) === shareKey);
        if (exactMatch) {
          exactMatch.userShareId = share.id;
          if (share.permission === 'write') {
            exactMatch.readOnly = false;
            exactMatch.isShared = true;
            exactMatch.owner = share.ownerUsername;
            exactMatch.sharePermission = 'write';
          } else if (!exactMatch.sharePermission) {
            exactMatch.sharePermission = exactMatch.readOnly ? 'read' : 'write';
          }
          continue;
        }

        // Fjern evt. duplikeret SOGo-abonnement af samme ejers kalender, hvis Brogaard-delingen giver skrivbar (eller nyere) adgang
        if (targetSlug) {
          const subIdx = mergedCalendars.findIndex(
            (c) =>
              c.isShared &&
              c.owner?.toLowerCase().trim() === share.ownerUsername.toLowerCase().trim() &&
              decodeURIComponent(c.url || '').toLowerCase().endsWith(`_${targetSlug}/`)
          );
          if (subIdx !== -1) {
            const removedId = mergedCalendars[subIdx].id;
            mergedCalendars.splice(subIdx, 1);
            for (let i = mergedEvents.length - 1; i >= 0; i--) {
              if (mergedEvents[i].calendarId === removedId) {
                mergedEvents.splice(i, 1);
              }
            }
          }
        }

        mergedCalendars.push(sharedCal);
        mergedEvents.push(...sharedEvents);
      }
    }

    // Hent direkte delte SOGo-kalendere via kodeordsfri opdagelseshints (med modtagerens eget login)
    if (incomingSogoHints.length > 0) {
      const presentKeys = new Set(mergedCalendars.map((c) => canonicalCalKey(c.url)));
      const presentSigs = new Set(
        mergedCalendars
          .map((c) => canonicalSogoCalendarSignature(c.url, c.owner))
          .filter((s): s is string => Boolean(s))
      );

      const hintsToFetch = [];
      for (const hint of incomingSogoHints) {
        const hintKey = canonicalCalKey(hint.calendarUrl);
        const hintSig = canonicalSogoCalendarSignature(hint.calendarUrl, hint.ownerUsername);
        if (presentKeys.has(hintKey) || (hintSig && presentSigs.has(hintSig))) {
          continue;
        }
        if (isSharedCalendarDismissed(creds.username, hint.calendarUrl, hint.calendarUrl)) {
          dismissedSharedCount += 1;
          continue;
        }
        hintsToFetch.push(hint);
      }

      if (hintsToFetch.length > 0) {
        const hintResults = await Promise.allSettled(
          hintsToFetch.map(async (hint) => {
            try {
              const cal = await verifyAndFetchSharedCalendar(
                creds,
                hint.calendarUrl,
                hint.calendarName,
                hint.calendarColor
              );
              if (!cal) return null;
              void subscribeToSogoSharedCalendar(creds, cal.url).catch(() => {});
              const evs = await fetchAllEvents(creds, [cal], timeRange);
              return { cal, evs };
            } catch (err: any) {
              const msg = String(err?.message || err);
              if (/HTTP (?:403|404)\b/.test(msg)) {
                removeUserCalendarShareByTarget(
                  hint.ownerUsername,
                  hint.calendarUrl,
                  hint.recipientEmail
                );
              }
              throw err;
            }
          })
        );

        for (const hr of hintResults) {
          if (hr.status === 'fulfilled' && hr.value) {
            mergedCalendars.push(hr.value.cal);
            mergedEvents.push(...hr.value.evs);
          }
        }
      }
    }

    const allCalendars = [...mergedCalendars, ...subData.calendars];
    const savedNameOverrides = getCalendarNameOverrides(creds.username);
    const clientNameOverrides: Record<string, string> = { ...savedNameOverrides };
    const savedColorOverrides = getCalendarColorOverrides(creds.username);
    const clientColorOverrides: Record<string, string> = { ...savedColorOverrides };

    for (const cal of allCalendars) {
      const origName = cal.serverName || cal.name;
      cal.serverName = origName;
      const alias = resolveCalendarNameOverride(savedNameOverrides, cal.id, cal.url);
      if (alias) {
        cal.name = alias;
        cal.localNameOverride = alias;
        clientNameOverrides[cal.id] = alias;
      } else {
        cal.localNameOverride = null;
      }

      const colorAlias = resolveCalendarColorOverride(savedColorOverrides, cal.id, cal.url);
      if (colorAlias) {
        cal.color = colorAlias;
        cal.localColorOverride = colorAlias;
        clientColorOverrides[cal.id] = colorAlias;
      } else {
        cal.localColorOverride = null;
      }
    }

    sendCompressedJson(req, res, {
      ok: true,
      calendars: allCalendars,
      events: [...mergedEvents, ...subData.events],
      nameOverrides: clientNameOverrides,
      colorOverrides: clientColorOverrides,
      dismissedSharedCount,
      birthdayCalendarSync: {
        enabled: Boolean(contactPrefs.birthdayCalendarSyncEnabled),
        calendarUrl: contactPrefs.birthdayCalendarUrl || null,
        lastSyncedAt: contactPrefs.birthdayCalendarLastSyncedAt || null
      },
      syncedAt: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('CalDAV sync fejl:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Synkronisering med CalDAV-serveren mislykkedes.'
    });
  }
});

/**
 * POST /api/caldav/events
 */
caldavRouter.post('/events', async (req: Request, res: Response) => {
  try {
    const callerCreds = requireDavCredentials(req);
    const event = req.body?.event as CalendarEventDTO | undefined;
    if (!event || !event.calendarId || !event.title) {
      res.status(400).json({ ok: false, error: 'Ugyldige begivenhedsdata.' });
      return;
    }
    if (event.uid && /[\\/]/.test(event.uid)) {
      throw new ForbiddenShareError('Ugyldigt begivenheds-UID.');
    }

    const { creds: effectiveCreds, sharedCalendarUrl } = resolveEffectiveDavCredentials(
      callerCreds,
      event.calendarId,
      'write'
    );
    if (sharedCalendarUrl && event.caldavUrl && !isUrlInsideSharedCalendar(event.caldavUrl, sharedCalendarUrl)) {
      throw new ForbiddenShareError('Ugyldig mål-URL uden for den delte kalender.');
    }

    const saved = await saveCalDavEvent(effectiveCreds, event);
    res.json({ ok: true, event: saved });
  } catch (err: any) {
    const status = err instanceof ForbiddenShareError || err?.statusCode === 403 ? 403 : 500;
    console.error('Fejl ved gem af CalDAV event:', err?.message || err);
    res.status(status).json({
      ok: false,
      error: err?.message || 'Kunne ikke gemme begivenheden på CalDAV-serveren.'
    });
  }
});

/**
 * DELETE /api/caldav/events
 */
caldavRouter.delete('/events', async (req: Request, res: Response) => {
  try {
    const callerCreds = requireDavCredentials(req);
    const caldavUrl = (req.body?.caldavUrl || req.query?.caldavUrl) as string | undefined;
    const etag = (req.body?.etag || req.query?.etag) as string | undefined;

    if (!caldavUrl) {
      res.status(400).json({ ok: false, error: 'caldavUrl mangler.' });
      return;
    }

    const { creds: effectiveCreds } = resolveEffectiveDavCredentials(callerCreds, caldavUrl, 'write');
    await deleteCalDavEvent(effectiveCreds, caldavUrl, etag);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err instanceof ForbiddenShareError || err?.statusCode === 403 ? 403 : 500;
    console.error('Fejl ved sletning af CalDAV event:', err?.message || err);
    res.status(status).json({
      ok: false,
      error: err?.message || 'Kunne ikke slette begivenheden på CalDAV-serveren.'
    });
  }
});

/**
 * POST /api/caldav/events/bulk-delete
 */
caldavRouter.post('/events/bulk-delete', async (req: Request, res: Response) => {
  try {
    const callerCreds = requireDavCredentials(req);
    const items = Array.isArray(req.body?.items)
      ? (req.body.items as Array<{ caldavUrl?: string; etag?: string }>)
      : [];

    const validItems = items.filter(
      (item) => typeof item?.caldavUrl === 'string' && item.caldavUrl.trim().length > 0
    );
    let deletedCount = 0;
    let failedCount = 0;
    const CONCURRENCY = 8;

    for (let i = 0; i < validItems.length; i += CONCURRENCY) {
      const batch = validItems.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const itemUrl = item.caldavUrl!.trim();
          const { creds: effectiveCreds } = resolveEffectiveDavCredentials(
            callerCreds,
            itemUrl,
            'write'
          );
          return deleteCalDavEvent(effectiveCreds, itemUrl, item.etag);
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          deletedCount++;
        } else {
          failedCount++;
        }
      }
    }

    res.json({
      ok: true,
      deletedCount,
      failedCount
    });
  } catch (err: any) {
    console.error('Fejl ved bulk-sletning af CalDAV events:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke gennemføre bulk-sletning på CalDAV-serveren.'
    });
  }
});

/**
 * POST /api/caldav/calendars
 */
caldavRouter.post('/calendars', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const name = String(req.body?.name || '').trim();
    const color = String(req.body?.color || '#2563eb');
    const calendarUrl = req.body?.calendarUrl ? String(req.body.calendarUrl).trim() : undefined;

    if (!name && !calendarUrl) {
      res.status(400).json({ ok: false, error: 'Kalendernavn eller kalender-URL mangler.' });
      return;
    }
    const calendar = await createCalDavCalendar(creds, name || 'SOGo Kalender', color, calendarUrl);
    if (calendarUrl) {
      removeDismissedSharedCalendar(creds.username, calendarUrl);
    }
    res.json({ ok: true, calendar });
  } catch (err: any) {
    console.error('Fejl ved oprettelse/tilføjelse af kalender:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke oprette eller tilføje kalenderen.'
    });
  }
});

/**
 * DELETE /api/caldav/calendars
 */
caldavRouter.delete('/calendars', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const calendarUrl = String(req.body?.calendarUrl || '');
    if (!calendarUrl) {
      res.status(400).json({ ok: false, error: 'calendarUrl mangler.' });
      return;
    }
    await deleteCalDavCalendar(creds, calendarUrl);
    const contactPrefs = getUserContactPrefs(creds.username);
    if (isBrogaardBirthdayCalendarUrl(calendarUrl, contactPrefs.birthdayCalendarUrl)) {
      setUserBirthdayCalendarSync(creds.username, { enabled: false, calendarUrl: null });
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Fejl ved sletning af kalender:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke slette kalenderen.' });
  }
});

/**
 * POST /api/caldav/birthdays-sync
 * Opretter/opdaterer en rigtig CalDAV-kalender på Mailcow/SOGo med alle kontakters fødselsdage & mærkedage.
 */
caldavRouter.post('/birthdays-sync', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const result = await syncContactBirthdaysToCalDav(creds, { enable: true });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('Fejl ved synkronisering af fødselsdagskalender til Mailcow:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke synkronisere fødselsdagskalenderen til Mailcow.'
    });
  }
});

/**
 * DELETE /api/caldav/birthdays-sync
 * Deaktiverer automatisk synk af fødselsdagskalenderen (og sletter evt. fjern-kalenderen på Mailcow).
 */
caldavRouter.delete('/birthdays-sync', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const deleteCalendar = Boolean(req.body?.deleteCalendar);
    const result = await disableContactBirthdaysCalDavSync(creds, deleteCalendar);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('Fejl ved afbrydelse af fødselsdagskalender-synk:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke stoppe synkroniseringen af fødselsdagskalenderen.'
    });
  }
});

function extractSubscriptionContext(req: Request): CalDavCredentials {
  try {
    return requireDavCredentials(req);
  } catch {
    const envHost = process.env.DEFAULT_MAIL_HOST || process.env.DEFAULT_IMAP_HOST;
    const rawServer = String(
      req.body?.serverUrl ||
        process.env.DEFAULT_CALDAV_URL ||
        (envHost ? `https://${envHost}/SOGo/dav/` : 'https://caldav.local')
    ).trim();
    const serverUrl = rawServer ? normalizeMailcowUrl(rawServer) : 'https://caldav.local';
    const username = String(req.body?.username || 'default').trim() || 'default';
    return { serverUrl, username, password: '' };
  }
}

/**
 * POST /api/caldav/subscriptions
 */
caldavRouter.post('/subscriptions', async (req: Request, res: Response) => {
  try {
    const creds = extractSubscriptionContext(req);
    const subscriptionUrl = String(req.body?.subscriptionUrl || '').trim();
    const name = req.body?.name ? String(req.body.name).trim() : undefined;
    const color = req.body?.color ? String(req.body.color).trim() : undefined;

    if (!subscriptionUrl) {
      res.status(400).json({ ok: false, error: 'Abonnements-URL mangler.' });
      return;
    }

    const result = await addUserSubscription(creds, { name, subscriptionUrl, color });
    res.json({
      ok: true,
      calendar: result.calendar,
      events: result.events
    });
  } catch (err: any) {
    console.error('Fejl ved oprettelse af kalender-abonnement:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke tilføje kalender-abonnement.'
    });
  }
});

/**
 * DELETE /api/caldav/subscriptions
 */
caldavRouter.delete('/subscriptions', async (req: Request, res: Response) => {
  try {
    const creds = extractSubscriptionContext(req);
    const id = String(req.body?.id || '').trim();
    if (!id) {
      res.status(400).json({ ok: false, error: 'Abonnements-ID mangler.' });
      return;
    }
    removeUserSubscription(creds, id);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Fejl ved afmelding af abonnement:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke afmelde kalender-abonnement.'
    });
  }
});

/**
 * POST /api/caldav/rsvp
 */
caldavRouter.post('/rsvp', async (req: Request, res: Response) => {
  try {
    const callerCreds = requireDavCredentials(req);
    const event = req.body?.event as CalendarEventDTO | undefined;
    const partstat = req.body?.partstat as AttendeeDTO['partstat'] | undefined;

    if (!event || !partstat) {
      res.status(400).json({ ok: false, error: 'Manglende event eller RSVP-status.' });
      return;
    }

    const { creds: effectiveCreds, sharedCalendarUrl } = resolveEffectiveDavCredentials(
      callerCreds,
      event.calendarId || event.caldavUrl || '',
      'write'
    );
    if (sharedCalendarUrl && event.caldavUrl && !isUrlInsideSharedCalendar(event.caldavUrl, sharedCalendarUrl)) {
      throw new ForbiddenShareError('Ugyldig mål-URL uden for den delte kalender.');
    }

    const updated = await updateEventRsvp(effectiveCreds, event, partstat);
    res.json({ ok: true, event: updated });
  } catch (err: any) {
    const status = err instanceof ForbiddenShareError || err?.statusCode === 403 ? 403 : 500;
    console.error('Fejl ved RSVP opdatering:', err?.message || err);
    res.status(status).json({
      ok: false,
      error: err?.message || 'Kunne ikke opdatere mødesvar på CalDAV-serveren.'
    });
  }
});

async function addInvitation(creds: CalDavCredentials, calendarId: string, event: CalendarEventDTO, invitationSeries?: string) {
  const existing = await findCalendarEventByUid(creds, calendarId, event.uid);
  if (existing) return { event: existing, alreadyAdded: true };
  try {
    const saved = await saveCalDavEvent(creds, event, { createOnly: true, invitationSeries });
    return { event: saved, alreadyAdded: false };
  } catch (error) {
    if (error instanceof Error && /\(HTTP (403|409|412)\b/.test(error.message)) {
      const concurrent = await findCalendarEventByUid(creds, calendarId, event.uid);
      if (concurrent) return { event: concurrent, alreadyAdded: true };
    }
    throw error;
  }
}

caldavRouter.post('/invitation', async (req, res) => {
  const calendarId = typeof req.body?.calendarId === 'string' ? req.body.calendarId.trim() : '';
  const rawIcs = typeof req.body?.icsContent === 'string' ? req.body.icsContent : '';
  const invitation = readCalendarInvitation(rawIcs);
  if (!calendarId || !invitation?.canAddDirectly || !invitation.uid) {
    res.status(400).json({ ok: false, error: 'Vælg en kalender og en gyldig mødeinvitation.' });
    return;
  }

  try {
    const { creds } = resolveEffectiveDavCredentials(requireDavCredentials(req), calendarId, 'write');
    const event = parseIcsToEvents(rawIcs, calendarId).find(item => item.uid === invitation.uid);
    if (!event || event.uid !== invitation.uid) {
      res.status(400).json({ ok: false, error: 'Mødeinvitationen indeholder ingen gyldig aftale.' });
      return;
    }
    const series = invitation.recurring ? buildInvitationSeries(rawIcs) : undefined;
    const result = await addInvitation(creds, calendarId, event, series);
    const storedSeries = result.alreadyAdded ? result.event.rawIcs : series;
    const occurrences = storedSeries && invitation.recurring
      ? parseIcsToEvents(storedSeries, calendarId, result.event.caldavUrl, undefined, false, true)
      : undefined;
    res.json({ ok: true, ...result, occurrences });
  } catch (error) {
    const status = error instanceof ForbiddenShareError ? 403 : 502;
    res.status(status).json({ ok: false, error: 'Kunne ikke gemme invitationen i den valgte kalender.' });
  }
});

/**
 * POST /api/caldav/import
 */
caldavRouter.post('/import', async (req: Request, res: Response) => {
  try {
    const callerCreds = requireDavCredentials(req);
    const calendarId = String(req.body?.calendarId || '').trim();
    const rawIcs = normalizeDanishText(String(req.body?.icsContent || ''));

    if (!calendarId || !rawIcs.includes('BEGIN:VCALENDAR')) {
      res.status(400).json({
        ok: false,
        error: 'Ugyldig .ics-fil eller manglende mål-kalender.'
      });
      return;
    }

    const { creds: effectiveCreds } = resolveEffectiveDavCredentials(callerCreds, calendarId, 'write');

    const parsedEvents = parseIcsToEvents(rawIcs, calendarId);
    if (parsedEvents.length === 0) {
      res.status(400).json({
        ok: false,
        error: 'Ingen gyldige begivenheder (VEVENT) fundet i .ics-filen.'
      });
      return;
    }

    const savedEvents: CalendarEventDTO[] = [];
    for (const ev of parsedEvents) {
      const saved = await saveCalDavEvent(effectiveCreds, {
        ...ev,
        calendarId,
        uid: crypto.randomUUID(),
        caldavUrl: undefined,
        etag: undefined,
        rawIcs: undefined
      });
      savedEvents.push(saved);
    }

    res.json({
      ok: true,
      importedCount: savedEvents.length,
      events: savedEvents
    });
  } catch (err: any) {
    const status = err instanceof ForbiddenShareError || err?.statusCode === 403 ? 403 : 500;
    console.error('Fejl ved ICS import:', err?.message || err);
    res.status(status).json({
      ok: false,
      error: err?.message || 'Kunne ikke importere .ics-filen til kalenderen.'
    });
  }
});

/**
 * POST /api/caldav/export
 */
caldavRouter.post('/export', async (req: Request, res: Response) => {
  try {
    requireDavCredentials(req);
    const events = Array.isArray(req.body?.events) ? (req.body.events as CalendarEventDTO[]) : [];
    const calendarName = String(req.body?.calendarName || 'Kalender').trim();
    const icsContent = buildCalendarExportIcs(events, calendarName);

    res.json({
      ok: true,
      icsContent
    });
  } catch (err: any) {
    console.error('Fejl ved ICS eksport:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke eksportere kalenderen til .ics.'
    });
  }
});

/**
 * GET /api/caldav/shares
 */
caldavRouter.get('/shares', async (req: Request, res: Response) => {
  try {
    requireDavCredentials(req);
    const shares = listSharesForUser();
    res.json({ ok: true, shares });
  } catch (err: any) {
    res.status(401).json({ ok: false, error: err?.message || 'Uautoriseret' });
  }
});

/**
 * POST /api/caldav/shares
 */
caldavRouter.post('/shares', async (req: Request, res: Response) => {
  try {
    requireDavCredentials(req);
    const label = String(req.body?.label || 'Delt kalender').trim();
    const calendarUrls = Array.isArray(req.body?.calendarUrls)
      ? req.body.calendarUrls.map(String)
      : [];
    const calendarNames = Array.isArray(req.body?.calendarNames)
      ? req.body.calendarNames.map(String)
      : [];
    const hideDetails = Boolean(req.body?.hideDetails);
    const expiresAt = req.body?.expiresAt;
    if (expiresAt != null && (typeof expiresAt !== 'string' || !(Date.parse(expiresAt) > Date.now()))) {
      res.status(400).json({ ok: false, error: 'Vælg et udløbstidspunkt i fremtiden.' });
      return;
    }

    if (calendarUrls.length === 0) {
      res.status(400).json({ ok: false, error: 'Vælg mindst én kalender at dele.' });
      return;
    }

    const share = createShareLink({
      label,
      calendarUrls,
      calendarNames,
      hideDetails,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined
    });

    res.json({ ok: true, share });
  } catch (err: any) {
    console.error('Fejl ved oprettelse af delingslink:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke oprette delingslink.' });
  }
});

/**
 * DELETE /api/caldav/shares/:token
 */
caldavRouter.delete('/shares/:token', async (req: Request, res: Response) => {
  try {
    requireDavCredentials(req);
    const rawToken = req.params.token;
    const token = String(Array.isArray(rawToken) ? rawToken[0] : rawToken || '').trim();
    const deleted = deleteShareLink(token);
    res.json({ ok: true, deleted });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke slette delingslink.' });
  }
});

/**
 * GET /api/caldav/public/:token
 */
caldavRouter.get('/public/:token', publicShareLimiter, async (req: Request, res: Response) => {
  try {
    const rawToken = req.params.token;
    const token = String(Array.isArray(rawToken) ? rawToken[0] : rawToken || '').trim();
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(token)) {
      res.status(404).json({
        ok: false,
        error: 'Ugyldigt delingslink.'
      });
      return;
    }

    const record = resolveShareToken(token);
    if (!record || shareExpired(record)) {
      res.status(404).json({
        ok: false,
        error: 'Dette delingslink findes ikke eller er blevet tilbagekaldt af ejeren.'
      });
      return;
    }

    const creds = requireDavCredentials(req);
    const allCalendars = await fetchCalendars(creds);
    const allowedSet = new Set(
      record.calendarUrls.map((u) => decodeURIComponent(u).toLowerCase().replace(/\/+$/, ''))
    );

    const sharedCalendars = allCalendars
      .filter((c) => {
        const normUrl = decodeURIComponent(c.url).toLowerCase().replace(/\/+$/, '');
        const normId = decodeURIComponent(c.id).toLowerCase().replace(/\/+$/, '');
        return allowedSet.has(normUrl) || allowedSet.has(normId);
      })
      .map((c) => ({
        ...c,
        readOnly: true,
        isShared: true,
        owner: creds.username
      }));

    const rawEvents = await fetchAllEvents(creds, sharedCalendars);

    const sanitizedEvents: CalendarEventDTO[] = rawEvents.map((ev) => ({
      id: ev.id,
      uid: ev.uid,
      calendarId: ev.calendarId,
      title: record.hideDetails ? 'Optaget' : ev.title,
      start: ev.start,
      end: ev.end,
      allDay: ev.allDay,
      description: record.hideDetails ? '' : ev.description,
      location: record.hideDetails ? '' : ev.location,
      videoUrl: record.hideDetails ? undefined : ev.videoUrl,
      timezone: ev.timezone,
      attendees: [],
      organizer: undefined,
      reminderMinutes: null
    }));

    res.json({
      ok: true,
      label: record.label,
      owner: creds.username,
      hideDetails: record.hideDetails,
      calendars: sharedCalendars,
      events: sanitizedEvents,
      syncedAt: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('Fejl ved hentning af offentligt delt kalender:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: 'Kunne ikke hente den delte kalender fra serveren.'
    });
  }
});

/**
 * GET /api/caldav/user-shares
 * Henter kalenderdelinger direkte fra Mailcow/SOGo ACL (samt evt. legacy/ikke-SOGo delinger).
 */
caldavRouter.get('/user-shares', async (req: Request, res: Response) => {
  let creds: CalDavCredentials;
  try {
    creds = requireDavCredentials(req);
  } catch (err: any) {
    res.status(401).json({ ok: false, error: err?.message || 'Kræver aktivt login.' });
    return;
  }

  let ownCalendars: CalendarInfoDTO[] = [];
  try {
    ownCalendars = await fetchOwnCalendarsFast(creds);
  } catch (fastErr: any) {
    console.warn('Hurtig kalenderhentning til delinger fejlede, prøver fuld fetch:', fastErr?.message || fastErr);
    ownCalendars = [];
  }

  if (ownCalendars.length === 0) {
    try {
      ownCalendars = (await fetchCalendars(creds)).filter((c) => !c.isShared);
    } catch {
      ownCalendars = [];
    }
  }

  const savedNameOverrides = getCalendarNameOverrides(creds.username);
  for (const cal of ownCalendars) {
    const alias = resolveCalendarNameOverride(savedNameOverrides, cal.id, cal.url);
    if (alias) cal.name = alias;
  }

  const sogoHints = listOutgoingSogoShareHints(creds.username);
  const { shares: sogoShares, staleHints } = await listSogoCalendarShares(
    creds,
    ownCalendars,
    sogoHints
  ).catch((err) => {
    console.warn('listSogoCalendarShares fejlede:', err?.message || err);
    return {
      shares: [],
      staleHints: [] as Array<{ calendarUrl: string; recipientEmail: string }>
    };
  });

  for (const stale of staleHints) {
    removeUserCalendarShareByTarget(creds.username, stale.calendarUrl, stale.recipientEmail);
  }

  const sogoKeySet = new Set<string>();
  for (const s of sogoShares) {
    sogoKeySet.add(`${canonicalCalKey(s.calendarUrl)}::${s.recipientEmail.toLowerCase().trim()}`);
    if (s.recipientUid) {
      sogoKeySet.add(`${canonicalCalKey(s.calendarUrl)}::${s.recipientUid.toLowerCase().trim()}`);
    }
  }

  const legacyShares = listOutgoingUserShares(creds.username)
    .filter(
      (ls) => !sogoKeySet.has(`${canonicalCalKey(ls.calendarUrl)}::${ls.recipientEmail.toLowerCase().trim()}`)
    )
    .map((ls) => ({ ...ls, source: 'suite' as const }));

  res.json({ ok: true, userShares: [...sogoShares, ...legacyShares] });
});

/**
 * POST /api/caldav/shared-search
 * Søger delte kalendere i Mailcow/SOGo ud fra brugernavn, e-mailadresse eller kontakter.
 */
caldavRouter.post('/shared-search', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const query = String(req.body?.query || '').trim().slice(0, 120);
    const rawCandidateEmails = Array.isArray(req.body?.candidateEmails)
      ? (req.body.candidateEmails as unknown[])
      : [];

    const identityEmails = getCallerIdentityEmails(creds.username);
    const identitySet = new Set(identityEmails);
    const identityLocalParts = new Set(identityEmails.map((e) => e.split('@')[0]));

    const ownerCandidateMap = new Map<string, { email: string; displayName?: string }>();
    const addOwnerCandidate = (rawEmail: string, displayName?: string) => {
      const clean = rawEmail.trim();
      if (!clean) return;
      const lower = clean.toLowerCase();
      if (identitySet.has(lower) || identityLocalParts.has(lower)) return;
      const existing = ownerCandidateMap.get(lower);
      if (existing) {
        if (!existing.displayName && displayName) {
          existing.displayName = displayName;
        }
        return;
      }
      if (ownerCandidateMap.size >= 15) return;
      ownerCandidateMap.set(lower, { email: clean, displayName });
    };

    if (query && SEARCH_EMAIL_REGEX.test(query)) {
      addOwnerCandidate(query);
    }

    if (query.length >= 2) {
      const sogoUsers = await searchSogoUsers(creds, query).catch(() => []);
      for (const u of sogoUsers) {
        addOwnerCandidate(u.email || u.uid, u.displayName);
      }

      if (!query.includes('@') && /^[a-z0-9._+-]{2,64}$/i.test(query)) {
        const domains = Array.from(
          new Set(identityEmails.map((e) => e.split('@')[1]).filter(Boolean))
        );
        for (const dom of domains) {
          addOwnerCandidate(`${query.toLowerCase()}@${dom}`);
        }
      }
    }

    let contactCount = 0;
    for (const rawEmail of rawCandidateEmails) {
      if (contactCount >= 8) break;
      if (typeof rawEmail !== 'string') continue;
      const trimmed = rawEmail.trim();
      if (SEARCH_EMAIL_REGEX.test(trimmed)) {
        addOwnerCandidate(trimmed);
        contactCount++;
      }
    }

    const incomingHints = resolveIncomingSogoHintsForRecipient(identityEmails);
    const qLower = query.toLowerCase();
    const matchingHints = qLower
      ? incomingHints.filter(
          (h) =>
            h.ownerUsername.toLowerCase().includes(qLower) ||
            h.calendarName.toLowerCase().includes(qLower) ||
            h.calendarUrl.toLowerCase().includes(qLower)
        )
      : incomingHints;

    for (const h of matchingHints) {
      addOwnerCandidate(h.ownerUsername);
    }

    const ownerList = Array.from(ownerCandidateMap.values());
    const [ownerResults, collectionItems, hintResults] = await Promise.all([
      Promise.allSettled(ownerList.map((o) => fetchUserSharedCalendarsForOwner(creds, o.email))),
      query.length >= 2
        ? searchSogoSharedCalendarsByOwnerQuery(creds, query).catch(() => [])
        : Promise.resolve([]),
      Promise.allSettled(
        matchingHints.map((h) =>
          verifyAndFetchSharedCalendar(creds, h.calendarUrl, h.calendarName, h.calendarColor)
        )
      )
    ]);

    const discoveredMap = new Map<string, CalendarInfoDTO>();
    const recordFound = (cal: CalendarInfoDTO) => {
      const ownerLower = (cal.owner || '').toLowerCase().trim();
      if (ownerLower && (identitySet.has(ownerLower) || identityLocalParts.has(ownerLower))) {
        return;
      }
      const dedupKey =
        canonicalSogoCalendarSignature(cal.url, cal.owner) || canonicalCalKey(cal.url);
      const existing = discoveredMap.get(dedupKey);
      if (!existing || (existing.readOnly && !cal.readOnly)) {
        discoveredMap.set(dedupKey, cal);
      }
    };

    for (const r of ownerResults) {
      if (r.status === 'fulfilled') {
        for (const cal of r.value) recordFound(cal);
      }
    }
    for (const hr of hintResults) {
      if (hr.status === 'fulfilled' && hr.value) {
        recordFound(hr.value);
      }
    }

    const missingCollectionItems = collectionItems.filter((item) => {
      const sig = canonicalSogoCalendarSignature(item.url, item.owner);
      const key = sig || canonicalCalKey(item.url);
      return !discoveredMap.has(key);
    });

    if (missingCollectionItems.length > 0) {
      const verifiedCollection = await Promise.allSettled(
        missingCollectionItems.map((item) =>
          verifyAndFetchSharedCalendar(creds, item.url, item.displayName)
        )
      );
      for (const vc of verifiedCollection) {
        if (vc.status === 'fulfilled' && vc.value) {
          recordFound(vc.value);
        }
      }
    }

    const savedNameOverrides = getCalendarNameOverrides(creds.username);
    const results = Array.from(discoveredMap.values())
      .map((cal) => {
        const ownerKey = (cal.owner || '').toLowerCase().trim();
        const ownerInfo = ownerKey ? ownerCandidateMap.get(ownerKey) : undefined;
        const alias = resolveCalendarNameOverride(savedNameOverrides, cal.id, cal.url);
        return {
          url: cal.url,
          name: alias || cal.name,
          color: cal.color || cal.serverColor || '#2563eb',
          owner: cal.owner,
          ownerDisplayName: ownerInfo?.displayName,
          readOnly: cal.readOnly,
          sharePermission: (cal.readOnly ? 'read' : 'write') as CalendarSharePermission,
          description: cal.description
        };
      })
      .sort((a, b) => {
        const ownerCmp = (a.owner || '').localeCompare(b.owner || '', 'da');
        return ownerCmp !== 0 ? ownerCmp : a.name.localeCompare(b.name, 'da');
      });

    res.json({ ok: true, calendars: results });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke søge efter delte kalendere i SOGo.'
    });
  }
});

/**
 * POST /api/caldav/shared-subscribe
 * Abonnerer og tilføjer en fundet delt SOGo-kalender til brugerens konto.
 */
caldavRouter.post('/shared-subscribe', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const calendarUrl = String(req.body?.calendarUrl || '').trim();
    const owner = String(req.body?.owner || '').trim() || undefined;
    const name = String(req.body?.name || '').trim() || undefined;
    const color = String(req.body?.color || '').trim() || undefined;

    if (!calendarUrl) {
      res.status(400).json({ ok: false, error: 'calendarUrl mangler.' });
      return;
    }

    let cal: CalendarInfoDTO | null = null;
    try {
      cal = await verifyAndFetchSharedCalendar(creds, calendarUrl, name, color);
    } catch (verifyErr: any) {
      const msg = String(verifyErr?.message || verifyErr);
      if (/HTTP (?:401|403|404)\b/.test(msg)) {
        const statusCode = msg.includes('HTTP 404') ? 404 : 403;
        res.status(statusCode).json({
          ok: false,
          error: 'Du har ikke adgang til denne kalender i SOGo.'
        });
        return;
      }
      throw verifyErr;
    }

    if (!cal) {
      res.status(404).json({ ok: false, error: 'Kalenderen blev ikke fundet i SOGo.' });
      return;
    }

    cal.isShared = true;
    cal.owner = cal.owner || owner;
    cal.sharePermission = cal.readOnly ? 'read' : 'write';

    const subscribedInSogo = await subscribeToSogoSharedCalendar(creds, cal.url).catch(() => false);
    removeDismissedSharedCalendar(creds.username, cal.url);
    if (calendarUrl !== cal.url) {
      removeDismissedSharedCalendar(creds.username, calendarUrl);
    }

    if (cal.owner) {
      upsertSogoShareHint({
        ownerUsername: cal.owner,
        ownerServerUrl: creds.serverUrl,
        calendarUrl: cal.url,
        calendarName: cal.name,
        calendarColor: cal.color,
        recipientEmail: creds.username,
        permission: cal.readOnly ? 'read' : 'write'
      });
    }

    const savedNameOverrides = getCalendarNameOverrides(creds.username);
    cal.serverName = cal.serverName || cal.name;
    const alias = resolveCalendarNameOverride(savedNameOverrides, cal.id, cal.url);
    if (alias) {
      cal.name = alias;
      cal.localNameOverride = alias;
    } else {
      cal.localNameOverride = null;
    }

    const events = await fetchAllEvents(creds, [cal]);

    res.json({
      ok: true,
      calendar: cal,
      events,
      subscribedInSogo
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke tilføje den delte kalender.'
    });
  }
});

/**
 * POST /api/caldav/user-shares
 * Deler en af brugerens egne kalendere direkte i Mailcow/SOGo (med fallback til lokal deling ved ikke-SOGo servere).
 */
caldavRouter.post('/user-shares', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const calendarUrl = String(req.body?.calendarUrl || '').trim();
    const calendarName = String(req.body?.calendarName || 'Delt kalender').trim();
    const calendarColor = String(req.body?.calendarColor || '#2563eb').trim();
    const recipientEmail = String(req.body?.recipientEmail || '').trim();
    const permission: CalendarSharePermission =
      req.body?.permission === 'write' ? 'write' : 'read';

    if (!calendarUrl || !recipientEmail) {
      res.status(400).json({
        ok: false,
        error: 'Både kalender og modtager e-mailadresse skal angives.'
      });
      return;
    }

    try {
      const sogoShare = await upsertSogoCalendarShare({
        creds,
        calendarUrl,
        calendarName,
        calendarColor,
        recipientEmail,
        permission,
        subscribeRecipient: true
      });
      removeUserCalendarShareByTarget(creds.username, calendarUrl, recipientEmail);
      if (sogoShare.recipientUid) {
        removeUserCalendarShareByTarget(creds.username, calendarUrl, sogoShare.recipientUid);
      }
      upsertSogoShareHint({
        ownerUsername: creds.username,
        ownerServerUrl: creds.serverUrl,
        calendarUrl: sogoShare.calendarUrl,
        calendarName: sogoShare.calendarName,
        calendarColor: sogoShare.calendarColor,
        recipientEmail: sogoShare.recipientEmail,
        permission: sogoShare.permission
      });
      const recipientTargets = Array.from(
        new Set(
          [recipientEmail, sogoShare.recipientEmail, sogoShare.recipientUid].flatMap((em) =>
            findUsernamesOwningEmail(em)
          )
        )
      );
      removeDismissedSharedCalendarForEmails(recipientTargets, calendarUrl);
      res.json({ ok: true, userShare: sogoShare });
      return;
    } catch (sogoErr: any) {
      if (sogoErr instanceof SogoAclValidationError) {
        res.status(400).json({ ok: false, error: sogoErr.message });
        return;
      }
      if (sogoErr instanceof SogoAclUnsupportedError) {
        const fallbackShare = upsertUserCalendarShare({
          ownerCreds: creds,
          calendarUrl,
          calendarName,
          calendarColor,
          recipientEmail,
          permission
        });
        removeDismissedSharedCalendarForEmails([recipientEmail], calendarUrl);
        res.json({ ok: true, userShare: { ...fallbackShare, source: 'suite' } });
        return;
      }
      throw sogoErr;
    }
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err?.message || 'Kunne ikke dele kalenderen med brugeren i SOGo.'
    });
  }
});

/**
 * PATCH /api/caldav/user-shares/:id
 * Opdaterer rettigheden ('read' <-> 'write') direkte i Mailcow/SOGo eller i fallback-registeret.
 */
caldavRouter.patch('/user-shares/:id', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const rawId = req.params.id;
    const shareId = String(Array.isArray(rawId) ? rawId[0] : rawId || '').trim();
    const permission: CalendarSharePermission =
      req.body?.permission === 'write' ? 'write' : 'read';

    if (isSogoShareId(shareId)) {
      const updated = await updateSogoCalendarSharePermission(creds, shareId, permission, {
        calendarName: req.body?.calendarName ? String(req.body.calendarName) : undefined,
        calendarColor: req.body?.calendarColor ? String(req.body.calendarColor) : undefined
      });
      updateSogoShareHintPermission(
        creds.username,
        updated.calendarUrl,
        updated.recipientEmail,
        permission
      );
      res.json({ ok: true, userShare: updated });
      return;
    }

    const updated = updateUserCalendarSharePermission(creds.username, shareId, permission);
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Kalenderdeling blev ikke fundet.' });
      return;
    }

    res.json({ ok: true, userShare: { ...updated, source: 'suite' } });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err?.message || 'Kunne ikke opdatere rettigheden.'
    });
  }
});

/**
 * DELETE /api/caldav/user-shares/:id
 * Tilbagekalder en bruger-deling direkte i Mailcow/SOGo (eller i fallback-registeret).
 */
caldavRouter.delete('/user-shares/:id', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const rawId = req.params.id;
    const shareId = String(Array.isArray(rawId) ? rawId[0] : rawId || '').trim();

    if (isSogoShareId(shareId)) {
      const { calendarUrl, recipientUid } = await revokeSogoCalendarShare(creds, shareId);
      removeUserCalendarShareByTarget(creds.username, calendarUrl, recipientUid);
      res.json({ ok: true, deleted: true });
      return;
    }

    const deleted = deleteUserCalendarShare(creds.username, shareId);
    res.json({ ok: true, deleted });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err?.message || 'Kunne ikke tilbagekalde kalenderdeling.'
    });
  }
});

/**
 * POST /api/caldav/user-shares/leave
 * Lader en modtager forlade en delt kalender: afmelder i SOGo + fjerner lokal adgang/fravalg.
 */
caldavRouter.post('/user-shares/leave', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const shareId = req.body?.shareId ? String(req.body.shareId).trim() : undefined;
    const calendarUrl = req.body?.calendarUrl ? String(req.body.calendarUrl).trim() : undefined;

    if (!shareId && !calendarUrl) {
      res.status(400).json({ ok: false, error: 'shareId eller calendarUrl mangler.' });
      return;
    }

    const identityEmails = getCallerIdentityEmails(creds.username);
    const { removedCount, removedOwners } = leaveIncomingUserCalendarShare(identityEmails, {
      shareId,
      calendarUrl
    });

    let unsubscribedInSogo = false;
    if (calendarUrl) {
      unsubscribedInSogo = await unsubscribeFromSogoSharedCalendar(creds, calendarUrl).catch(
        () => false
      );
      addDismissedSharedCalendar(creds.username, calendarUrl);
      setCalendarNameOverride(creds.username, calendarUrl, null);
    }

    res.json({ ok: true, removedCount, removedOwners, unsubscribedInSogo });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err?.message || 'Kunne ikke forlade den delte kalender.'
    });
  }
});

/**
 * POST /api/caldav/user-shares/restore-dismissed
 * Gendanner delte kalendere som brugeren tidligere har forladt/fravalgt.
 */
caldavRouter.post('/user-shares/restore-dismissed', (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    clearDismissedSharedCalendars(creds.username);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(401).json({
      ok: false,
      error: err?.message || 'Kræver aktivt login.'
    });
  }
});

/**
 * PUT /api/caldav/calendar-name
 * Gemmer et personligt alias-navn pr. bruger (synkroniseres på tværs af enheder)
 * eller omdøber brugerens egen kalender direkte på Mailcow/SOGo via PROPPATCH.
 */
caldavRouter.put('/calendar-name', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const calendarId = String(req.body?.calendarId || '').trim();
    const calendarUrl = String(req.body?.calendarUrl || '').trim();
    const rawName = req.body?.name;
    const renameOnServer = Boolean(req.body?.renameOnServer);

    const primaryKey = calendarUrl || calendarId;
    if (!primaryKey) {
      res.status(400).json({ ok: false, error: 'calendarId eller calendarUrl mangler.' });
      return;
    }

    const trimmedName = typeof rawName === 'string' ? rawName.trim().slice(0, 80) : '';

    if (renameOnServer && trimmedName && calendarUrl) {
      try {
        await renameCalDavCalendar(creds, calendarUrl, trimmedName);
        setCalendarNameOverride(creds.username, primaryKey, null, calendarId || undefined);
        res.json({
          ok: true,
          renamedOnServer: true,
          effectiveName: trimmedName,
          localNameOverride: null
        });
        return;
      } catch (renameErr: any) {
        setCalendarNameOverride(creds.username, primaryKey, trimmedName, calendarId || undefined);
        res.json({
          ok: true,
          renamedOnServer: false,
          effectiveName: trimmedName,
          localNameOverride: trimmedName,
          fallbackReason: renameErr?.message || 'Serveren understøttede ikke direkte omdøbning.'
        });
        return;
      }
    }

    setCalendarNameOverride(
      creds.username,
      primaryKey,
      trimmedName || null,
      calendarId || undefined
    );
    res.json({
      ok: true,
      renamedOnServer: false,
      effectiveName: trimmedName || null,
      localNameOverride: trimmedName || null
    });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err?.message || 'Kunne ikke gemme kalendernavn.'
    });
  }
});

/**
 * PUT /api/caldav/calendar-color
 * Opdaterer kalenderfarven direkte på Mailcow/SOGo via CalDAV PROPPATCH (eller gemmer brugerens personlige farve).
 */
caldavRouter.put('/calendar-color', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const calendarId = String(req.body?.calendarId || '').trim();
    const calendarUrl = String(req.body?.calendarUrl || '').trim();
    const rawColor = req.body?.color;

    const primaryKey = calendarUrl || calendarId;
    if (!primaryKey) {
      res.status(400).json({ ok: false, error: 'calendarId eller calendarUrl mangler.' });
      return;
    }

    if (rawColor === null || rawColor === undefined || String(rawColor).trim() === '') {
      setCalendarColorOverride(creds.username, primaryKey, null, calendarId || undefined);
      res.json({
        ok: true,
        syncedToServer: false,
        effectiveColor: null,
        localColorOverride: null
      });
      return;
    }

    const cleanColor = String(rawColor).trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/i.test(cleanColor)) {
      res.status(400).json({ ok: false, error: 'Ugyldig hex-farve.' });
      return;
    }

    if (calendarId.startsWith('sub::')) {
      const updatedSub = updateUserSubscriptionColor(creds, calendarId, cleanColor);
      setCalendarColorOverride(
        creds.username,
        primaryKey,
        updatedSub ? null : cleanColor,
        calendarId || undefined
      );
      res.json({
        ok: true,
        syncedToServer: updatedSub,
        effectiveColor: cleanColor,
        localColorOverride: updatedSub ? null : cleanColor
      });
      return;
    }

    if (calendarUrl) {
      try {
        await updateCalDavCalendarColor(creds, calendarUrl, cleanColor);
        setCalendarColorOverride(creds.username, primaryKey, null, calendarId || undefined);
        const contactPrefs = getUserContactPrefs(creds.username);
        if (isBrogaardBirthdayCalendarUrl(calendarUrl, contactPrefs.birthdayCalendarUrl)) {
          setUserContactCalendarColor(creds.username, cleanColor);
        }
        res.json({
          ok: true,
          syncedToServer: true,
          effectiveColor: cleanColor,
          localColorOverride: null
        });
        return;
      } catch (colorErr: any) {
        setCalendarColorOverride(creds.username, primaryKey, cleanColor, calendarId || undefined);
        res.json({
          ok: true,
          syncedToServer: false,
          effectiveColor: cleanColor,
          localColorOverride: cleanColor,
          fallbackReason: colorErr?.message || 'Serveren understøttede ikke direkte farveændring.'
        });
        return;
      }
    }

    setCalendarColorOverride(creds.username, primaryKey, cleanColor, calendarId || undefined);
    res.json({
      ok: true,
      syncedToServer: false,
      effectiveColor: cleanColor,
      localColorOverride: cleanColor
    });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err?.message || 'Kunne ikke gemme kalenderfarve.'
    });
  }
});
