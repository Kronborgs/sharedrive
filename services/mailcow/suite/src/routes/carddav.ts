import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  type ContactDTO,
  canonicalAddressBookKey,
  fetchAddressBooks,
  fetchAllContacts,
  saveCardDavContact,
  deleteCardDavContact,
  parseVcardToContacts,
  buildVcardFromContact,
  fetchExternalContactPhotoAsDataUrl
} from '../services/carddavClient.js';
import { updateCalDavCalendarColor } from '../services/davClient.js';
import { normalizeDanishText } from '../services/icalMapper.js';
import {
  syncContactBirthdaysToCalDav,
  maybeAutoSyncContactBirthdays
} from '../services/birthdayCaldavSync.js';
import { requireDavCredentials } from '../services/sessionAuth.js';
import {
  canonicalContactPrefKey,
  getUserContactPrefs,
  setUserContactFavorite,
  setUserContactCalendarColor,
  clearUserContactUnstarOverride
} from '../services/contactPrefsStore.js';

export const carddavRouter = Router();

function applyFavoritePrefsToContacts(username: string, contacts: ContactDTO[]): ContactDTO[] {
  const prefs = getUserContactPrefs(username);
  const favSet = new Set(prefs.favoriteContacts);
  const unstarSet = new Set(prefs.unstarredOverrides);

  return contacts.map((c) => {
    const key = canonicalContactPrefKey(c.id);
    const uidKey = c.uid ? canonicalContactPrefKey(c.uid) : '';
    const isUnstarredOverride = unstarSet.has(key) || (Boolean(uidKey) && unstarSet.has(uidKey));
    const isFavPref = favSet.has(key) || (Boolean(uidKey) && favSet.has(uidKey));
    const starred = isFavPref ? true : isUnstarredOverride ? false : Boolean(c.starred);
    return {
      ...c,
      starred
    };
  });
}

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

const MAX_BULK_CONTACT_ITEMS = 500;

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      try {
        const value = await worker(items[current]);
        results[current] = { status: 'fulfilled', value };
      } catch (reason) {
        results[current] = { status: 'rejected', reason };
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function hasContactIdentity(contact?: ContactDTO): boolean {
  return Boolean(
    contact?.fullName?.trim() ||
      contact?.firstName?.trim() ||
      contact?.lastName?.trim() ||
      (contact?.emails && contact.emails.length > 0)
  );
}

/**
 * POST /api/carddav/sync
 * Henter alle adressebøger og kontakter fra Mailcow / SOGo CardDAV.
 */
carddavRouter.post('/sync', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const addressBooks = await fetchAddressBooks(creds);
    const failedAddressBookIds: string[] = [];
    const rawContacts = await fetchAllContacts(creds, addressBooks, failedAddressBookIds);
    const contacts = applyFavoritePrefsToContacts(creds.username, rawContacts);
    const prefs = getUserContactPrefs(creds.username);
    if (!failedAddressBookIds.length) void maybeAutoSyncContactBirthdays(creds);

    sendCompressedJson(req, res, {
      ok: true,
      addressBooks,
      contacts,
      failedAddressBookIds,
      calendarColor: prefs.calendarColor || null,
      syncedAt: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('CardDAV sync fejl:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Synkronisering med CardDAV-serveren mislykkedes.'
    });
  }
});

/**
 * POST /api/carddav/contacts
 * Opretter eller opdaterer en kontakt på CardDAV-serveren.
 */
carddavRouter.post('/contacts', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const contact = req.body?.contact as ContactDTO | undefined;

    if (!contact || !contact.addressBookId || !hasContactIdentity(contact)) {
      res.status(400).json({ ok: false, error: 'Ugyldige kontaktdata.' });
      return;
    }

    const saved = await saveCardDavContact(creds, contact, req.body?.requireUnchanged === true);
    if (typeof contact.starred === 'boolean') {
      setUserContactFavorite(creds.username, saved.id, contact.starred);
      if (saved.uid) {
        setUserContactFavorite(creds.username, saved.uid, contact.starred);
      }
      if (contact.starred) {
        clearUserContactUnstarOverride(creds.username, saved.id);
      }
      saved.starred = contact.starred;
    }
    if (getUserContactPrefs(creds.username).birthdayCalendarSyncEnabled) {
      await syncContactBirthdaysToCalDav(creds).catch((e) =>
        console.warn('Kunne ikke auto-synke fødselsdagskalender:', e)
      );
    }
    res.json({ ok: true, contact: saved });
  } catch (err: any) {
    console.error('Fejl ved gem af CardDAV kontakt:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke gemme kontakten på CardDAV-serveren.'
    });
  }
});

/**
 * POST /api/carddav/contacts/bulk-update
 * Opdaterer flere kontakter parallelt (f.eks. tags, firma m.m.) og synkroniserer evt. fødselsdagskalender én gang bagefter.
 */
carddavRouter.post('/contacts/bulk-update', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const rawContacts = req.body?.contacts;
    if (!Array.isArray(rawContacts) || rawContacts.length === 0) {
      res.status(400).json({ ok: false, error: 'Ingen kontakter angivet til opdatering.' });
      return;
    }
    if (rawContacts.length > MAX_BULK_CONTACT_ITEMS) {
      res.status(400).json({
        ok: false,
        error: `Højst ${MAX_BULK_CONTACT_ITEMS} kontakter kan opdateres ad gangen.`
      });
      return;
    }

    const contacts = rawContacts as ContactDTO[];
    const validContacts: ContactDTO[] = [];
    let failedCount = 0;

    for (const c of contacts) {
      if (!c || !c.addressBookId || !hasContactIdentity(c)) {
        failedCount++;
      } else {
        validContacts.push(c);
      }
    }

    const settled = await runWithConcurrency(validContacts, 6, async (contact) => {
      const saved = await saveCardDavContact(creds, contact, req.body?.requireUnchanged === true);
      if (typeof contact.starred === 'boolean') {
        setUserContactFavorite(creds.username, saved.id, contact.starred);
        if (saved.uid) {
          setUserContactFavorite(creds.username, saved.uid, contact.starred);
        }
        if (contact.starred) {
          clearUserContactUnstarOverride(creds.username, saved.id);
        }
        saved.starred = contact.starred;
      }
      return saved;
    });

    const savedContacts: ContactDTO[] = [];
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        savedContacts.push(item.value);
      } else {
        failedCount++;
      }
    }

    if (savedContacts.length > 0 && getUserContactPrefs(creds.username).birthdayCalendarSyncEnabled) {
      await syncContactBirthdaysToCalDav(creds).catch((e) =>
        console.warn('Kunne ikke auto-synke fødselsdagskalender efter bulk-update:', e)
      );
    }

    res.json({
      ok: true,
      updatedCount: savedContacts.length,
      failedCount,
      contacts: savedContacts
    });
  } catch (err: any) {
    console.error('Fejl ved bulk-opdatering af CardDAV kontakter:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke bulk-opdatere kontakter på CardDAV-serveren.'
    });
  }
});

/**
 * POST /api/carddav/favorite
 * Markerer eller fjerner en kontakt som favorit (gemmes både i CardDAV Starred-tag hvis skrivbar og i brugerpræferencer).
 */
carddavRouter.post('/favorite', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const contactId = String(req.body?.contactId || '').trim();
    const starred = Boolean(req.body?.starred);
    const contact = req.body?.contact as ContactDTO | undefined;

    if (!contactId && !contact?.id) {
      res.status(400).json({ ok: false, error: 'contactId mangler.' });
      return;
    }

    const effectiveId = contactId || String(contact?.id || '');
    setUserContactFavorite(creds.username, effectiveId, starred);
    if (contact?.uid) {
      setUserContactFavorite(creds.username, contact.uid, starred);
    }

    let updatedContact: ContactDTO | undefined;
    if (contact && contact.addressBookId && contact.vcardUrl) {
      try {
        updatedContact = await saveCardDavContact(creds, {
          ...contact,
          starred
        });
        updatedContact.starred = starred;
      } catch {
        // Skrivebeskyttet adressebog (f.eks. Global Adressebog): brugerpræferencen er allerede gemt
      }
    }

    res.json({
      ok: true,
      starred,
      contact: updatedContact
    });
  } catch (err: any) {
    console.error('Fejl ved opdatering af favorit-kontakt:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke opdatere favorit-status.'
    });
  }
});

/**
 * POST /api/carddav/favorites/bulk
 * Markerer eller fjerner flere kontakter som favoritter i én handling.
 */
carddavRouter.post('/favorites/bulk', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const starred = Boolean(req.body?.starred);
    const rawItems = req.body?.items;

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      res.status(400).json({ ok: false, error: 'Ingen kontakter angivet.' });
      return;
    }
    if (rawItems.length > MAX_BULK_CONTACT_ITEMS) {
      res.status(400).json({
        ok: false,
        error: `Højst ${MAX_BULK_CONTACT_ITEMS} kontakter kan opdateres ad gangen.`
      });
      return;
    }

    const items = rawItems as Array<{ contactId?: string; contact?: ContactDTO }>;
    const validItems = items.filter((item) => Boolean(item?.contactId || item?.contact?.id));
    if (validItems.length === 0) {
      res.status(400).json({ ok: false, error: 'Ingen gyldige kontakt-ID angivet.' });
      return;
    }

    const writableTargets: ContactDTO[] = [];
    for (const item of validItems) {
      const effectiveId = String(item.contactId || item.contact?.id || '').trim();
      setUserContactFavorite(creds.username, effectiveId, starred);
      if (item.contact?.uid) {
        setUserContactFavorite(creds.username, item.contact.uid, starred);
      }
      if (item.contact && item.contact.addressBookId && item.contact.vcardUrl) {
        writableTargets.push(item.contact);
      }
    }

    const updatedContacts: ContactDTO[] = [];
    if (writableTargets.length > 0) {
      const settled = await runWithConcurrency(writableTargets, 6, async (contact) => {
        try {
          const updated = await saveCardDavContact(creds, {
            ...contact,
            starred
          });
          updated.starred = starred;
          return updated;
        } catch {
          // Skrivebeskyttet adressebog: brugerpræferencen er allerede gemt
          return null;
        }
      });
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) {
          updatedContacts.push(r.value);
        }
      }
    }

    res.json({
      ok: true,
      starred,
      updatedCount: validItems.length,
      contacts: updatedContacts
    });
  } catch (err: any) {
    console.error('Fejl ved bulk-favorit opdatering:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke opdatere favorit-status for de valgte kontakter.'
    });
  }
});

/**
 * PUT /api/carddav/prefs
 * Gemmer brugerens valgte kalenderfarve til kontakt-fødselsdage/mærkedage på tværs af enheder.
 */
carddavRouter.put('/prefs', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const rawColor = req.body?.calendarColor;
    const savedColor = setUserContactCalendarColor(
      creds.username,
      typeof rawColor === 'string' ? rawColor : null
    );
    const prefs = getUserContactPrefs(creds.username);
    if (prefs.birthdayCalendarSyncEnabled && prefs.birthdayCalendarUrl) {
      await updateCalDavCalendarColor(
        creds,
        prefs.birthdayCalendarUrl,
        savedColor || '#ec4899'
      ).catch(() => {});
    }
    res.json({
      ok: true,
      calendarColor: savedColor
    });
  } catch (err: any) {
    res.status(400).json({
      ok: false,
      error: err?.message || 'Kunne ikke gemme kontaktpræferencer.'
    });
  }
});

/**
 * DELETE /api/carddav/contacts
 */
carddavRouter.delete('/contacts', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const vcardUrl = (req.body?.vcardUrl || req.query?.vcardUrl) as string | undefined;
    const etag = (req.body?.etag || req.query?.etag) as string | undefined;

    if (!vcardUrl) {
      res.status(400).json({ ok: false, error: 'vcardUrl mangler.' });
      return;
    }

    await deleteCardDavContact(creds, vcardUrl, etag);
    if (getUserContactPrefs(creds.username).birthdayCalendarSyncEnabled) {
      await syncContactBirthdaysToCalDav(creds).catch((e) =>
        console.warn('Kunne ikke auto-synke fødselsdagskalender:', e)
      );
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Fejl ved sletning af CardDAV kontakt:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke slette kontakten på CardDAV-serveren.'
    });
  }
});

/**
 * POST /api/carddav/contacts/bulk-delete
 * Sletter flere kontakter på CardDAV-serveren og synkroniserer evt. fødselsdagskalender én gang bagefter.
 */
carddavRouter.post('/contacts/bulk-delete', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const rawItems = req.body?.items;

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      res.status(400).json({ ok: false, error: 'Ingen kontakter angivet til sletning.' });
      return;
    }
    if (rawItems.length > MAX_BULK_CONTACT_ITEMS) {
      res.status(400).json({
        ok: false,
        error: `Højst ${MAX_BULK_CONTACT_ITEMS} kontakter kan slettes ad gangen.`
      });
      return;
    }

    const items = rawItems as Array<{ id?: string; vcardUrl?: string; etag?: string }>;
    const settled = await runWithConcurrency(items, 6, async (item) => {
      if (item.vcardUrl) {
        await deleteCardDavContact(creds, item.vcardUrl, item.etag, req.body?.requireUnchanged === true);
      }
      return item.id || null;
    });

    const deletedIds: string[] = [];
    let deletedCount = 0;
    let failedCount = 0;
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        deletedCount++;
        if (r.value) deletedIds.push(r.value);
      } else {
        failedCount++;
      }
    }

    if (deletedCount > 0 && getUserContactPrefs(creds.username).birthdayCalendarSyncEnabled) {
      await syncContactBirthdaysToCalDav(creds).catch((e) =>
        console.warn('Kunne ikke auto-synke fødselsdagskalender efter bulk-delete:', e)
      );
    }

    res.json({
      ok: true,
      deletedCount,
      failedCount,
      deletedIds
    });
  } catch (err: any) {
    console.error('Fejl ved bulk-sletning af CardDAV kontakter:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke slette de valgte kontakter på CardDAV-serveren.'
    });
  }
});

async function importContactsIntoBook(creds: CalDavCredentials, addressBookId: string, contacts: ContactDTO[]) {
  const savedContacts: ContactDTO[] = [];
  for (const contact of contacts) {
    let saved: ContactDTO;
    try {
      saved = await saveCardDavContact(creds, {
        ...contact,
        externalPhotoUrl: undefined,
        addressBookId,
        uid: crypto.randomUUID(),
        vcardUrl: undefined,
        etag: undefined
      });
    } catch (error) {
      if (error instanceof Error && /\(HTTP (401|403|404)\b/.test(error.message)) break;
      continue;
    }
    if (contact.starred) {
      setUserContactFavorite(creds.username, saved.id, true);
      if (saved.uid) setUserContactFavorite(creds.username, saved.uid, true);
      saved.starred = true;
    }
    savedContacts.push(saved);
  }
  return savedContacts;
}

async function downloadImportedContactPhotos(contacts: ContactDTO[]) {
  const batchSize = 5;
  for (let i = 0; i < contacts.length; i += batchSize) {
    await Promise.all(contacts.slice(i, i + batchSize).map(async contact => {
      if (contact.photoDataUrl || !contact.externalPhotoUrl) return;
      const photo = await fetchExternalContactPhotoAsDataUrl(contact.externalPhotoUrl);
      if (photo) contact.photoDataUrl = photo;
    }));
  }
}

/**
 * POST /api/carddav/import
 */
carddavRouter.post('/import', async (req: Request, res: Response) => {
  try {
    const creds = requireDavCredentials(req);
    const addressBookId = String(req.body?.addressBookId || '').trim();
    const rawVcf = normalizeDanishText(String(req.body?.vcfContent || ''));
    if (!addressBookId || !/BEGIN:VCARD/i.test(rawVcf)) {
      res.status(400).json({ ok: false, error: 'Ugyldig .vcf-fil eller manglende mål-adressebog.' });
      return;
    }
    const key = canonicalAddressBookKey(addressBookId);
    const book = (await fetchAddressBooks(creds)).find(item => canonicalAddressBookKey(item.id) === key);
    if (!book || book.readOnly || book.canCreate === false) {
      res.status(403).json({ ok: false, error: 'Vælg en adressebog, der tillader nye kontakter.' });
      return;
    }

    const parsed = parseVcardToContacts(rawVcf, book.id);
    if (!parsed.length) {
      res.status(400).json({ ok: false, error: 'Ingen gyldige kontakter fundet i .vcf-filen.' });
      return;
    }
    await downloadImportedContactPhotos(parsed);
    const contacts = await importContactsIntoBook(creds, book.id, parsed);
    if (!contacts.length) {
      res.status(502).json({ ok: false, error: 'SOGo gemte ingen kontakter. Kontrollér skriveadgangen til adressebogen.' });
      return;
    }
    if (getUserContactPrefs(creds.username).birthdayCalendarSyncEnabled) {
      await syncContactBirthdaysToCalDav(creds).catch(e =>
        console.warn('Kunne ikke auto-synke fødselsdagskalender:', e));
    }

    res.json({ ok: true, importedCount: contacts.length, failedCount: parsed.length - contacts.length, contacts });
  } catch {
    res.status(502).json({ ok: false, error: 'Kunne ikke gennemføre kontaktimporten i SOGo.' });
  }
});

/**
 * POST /api/carddav/export
 * Genererer en samlet .vcf-fil ud fra de valgte kontakter.
 */
carddavRouter.post('/export', async (req: Request, res: Response) => {
  try {
    requireDavCredentials(req);
    const contacts = Array.isArray(req.body?.contacts) ? (req.body.contacts as ContactDTO[]) : [];
    const vcfContent = contacts.map((c) => buildVcardFromContact(c)).join('\r\n');

    res.json({
      ok: true,
      vcfContent
    });
  } catch (err: any) {
    console.error('Fejl ved VCF eksport:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke eksportere kontakter til .vcf.'
    });
  }
});

/**
 * POST /api/carddav/fetch-photo
 * Henter et eksternt kontaktbillede (f.eks. Gravatar ud fra e-mail eller sikker HTTPS URL) server-side som kompakt data-URL til CardDAV.
 */
carddavRouter.post('/fetch-photo', async (req: Request, res: Response) => {
  try {
    requireDavCredentials(req);
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';

    let targetUrl = '';
    if (rawEmail && rawEmail.includes('@')) {
      const hash = crypto.createHash('sha256').update(rawEmail).digest('hex');
      targetUrl = `https://www.gravatar.com/avatar/${hash}?s=256&d=404`;
    } else if (rawUrl) {
      targetUrl = rawUrl;
    }

    if (!targetUrl) {
      res.status(400).json({ ok: false, error: 'Angiv en e-mail eller billede-URL.' });
      return;
    }

    const photoDataUrl = await fetchExternalContactPhotoAsDataUrl(targetUrl, 512 * 1024);
    res.json({
      ok: true,
      photoDataUrl: photoDataUrl || null
    });
  } catch (err: any) {
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke hente profilbillede.'
    });
  }
});
