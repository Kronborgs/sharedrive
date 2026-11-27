import { raw, Router, type Request, type Response } from 'express';
import {
  type SendMailPayload,
  fetchMailFolders,
  fetchFolderMessages,
  searchAllFoldersMessages,
  fetchMessageDetail,
  fetchRawEmail,
  importRawEmail,
  downloadMessageAttachment,
  updateMessageFlags,
  markAllFolderMessagesAsSeen,
  transferMessages,
  deleteMessages,
  emptyImapFolder,
  reportSpamStatus,
  createImapFolder,
  renameImapFolder,
  deleteImapFolder,
  sendEmailViaSmtp,
  saveDraftToImap
} from '../services/mailClient.js';
import {
  getAliasesForUser,
  upsertAliasForUser,
  deleteAliasForUser
} from '../services/aliasStore.js';
import { resolveAliasesWithMailcow } from '../services/mailcowAliases.js';
import {
  type SieveRuleDTO,
  fetchSieveOverview,
  fetchSpecificSieveScript,
  saveSieveRulesOrScript
} from '../services/sieveClient.js';
import {
  createRateLimiter,
  requireMailCredentials,
  requireDavCredentials
} from '../services/sessionAuth.js';

export const mailRouter = Router();

const emlType = 'message/rfc822';

mailRouter.get('/eml', async (req, res) => {
  const folder = String(req.query.folder || 'INBOX');
  const uid = Number(req.query.uid);
  if (!Number.isSafeInteger(uid) || uid < 1) {
    res.status(400).json({ ok: false, error: 'Ugyldigt beskednummer.' });
    return;
  }
  try {
    const message = await fetchRawEmail(requireMailCredentials(req), folder, uid);
    if (!message) {
      res.status(404).json({ ok: false, error: 'Beskeden findes ikke længere i mappen.' });
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="mail-${uid}.eml"`);
    res.type(emlType).send(message);
  } catch {
    res.status(502).json({ ok: false, error: 'Kunne ikke eksportere mailen fra IMAP.' });
  }
});

mailRouter.post('/eml', raw({ type: emlType, limit: '20mb' }), async (req, res) => {
  const folder = String(req.query.folder || '').trim();
  const message = req.body as unknown;
  if (!folder || !Buffer.isBuffer(message) || !/^[!-9;-~]+:[^\r\n]*\r?\n/.test(message.subarray(0, 4096).toString('latin1'))) {
    res.status(400).json({ ok: false, error: 'Vælg en mappe og en gyldig .eml-fil.' });
    return;
  }
  try {
    await importRawEmail(requireMailCredentials(req), folder, message);
    res.status(201).json({ ok: true });
  } catch {
    res.status(502).json({ ok: false, error: 'IMAP kunne ikke gemme mailen i den valgte mappe.' });
  }
});

const sendMailLimiter = createRateLimiter(
  45,
  60 * 1000,
  'For mange afsendelser på kort tid. Vent venligst et øjeblik.'
);

/**
 * GET /api/mail/folders
 */
mailRouter.get('/folders', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folders = await fetchMailFolders(creds);
    res.json({ ok: true, folders });
  } catch (err: any) {
    res.status(401).json({ ok: false, error: err?.message || 'Kunne ikke hente mapper.' });
  }
});

/**
 * POST /api/mail/folders
 */
mailRouter.post('/folders', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folderPath = String(req.body?.path || '').trim();
    if (!folderPath) {
      res.status(400).json({ ok: false, error: 'Mappenavn mangler.' });
      return;
    }
    await createImapFolder(creds, folderPath);
    const folders = await fetchMailFolders(creds);
    res.json({ ok: true, folders });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke oprette mappen.' });
  }
});

/**
 * PUT /api/mail/folders
 */
mailRouter.put('/folders', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const oldPath = String(req.body?.oldPath || '').trim();
    const newPath = String(req.body?.newPath || '').trim();
    if (!oldPath || !newPath) {
      res.status(400).json({ ok: false, error: 'Nuværende og nyt mappenavn skal angives.' });
      return;
    }
    await renameImapFolder(creds, oldPath, newPath);
    const folders = await fetchMailFolders(creds);
    res.json({ ok: true, folders });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke omdøbe mappen.' });
  }
});

/**
 * DELETE /api/mail/folders
 */
mailRouter.delete('/folders', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folderPath = String(req.body?.path || req.query?.path || '').trim();
    if (!folderPath) {
      res.status(400).json({ ok: false, error: 'Mappesti mangler.' });
      return;
    }
    await deleteImapFolder(creds, folderPath);
    const folders = await fetchMailFolders(creds);
    res.json({ ok: true, folders });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke slette mappen.' });
  }
});

/**
 * POST /api/mail/messages
 */
mailRouter.post('/messages', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folder = String(req.body?.folder || 'INBOX').trim();
    const limit = Number(req.body?.limit || 100);
    const page = Number(req.body?.page || 1);
    const offset = req.body?.offset !== undefined ? Number(req.body.offset) : undefined;
    const searchQuery = String(req.body?.searchQuery || '').trim();
    const searchAllFolders = req.body?.searchAllFolders !== false;

    if (searchQuery && searchAllFolders) {
      const globalData = await searchAllFoldersMessages(creds, searchQuery);
      res.json({
        ok: true,
        folder: 'ALL',
        messages: globalData.messages,
        total: globalData.total,
        unread: globalData.messages.filter((m) => !m.seen).length,
        syncedAt: new Date().toISOString()
      });
      return;
    }

    const data = await fetchFolderMessages(creds, folder, { limit, page, offset, searchQuery });
    res.json({
      ok: true,
      folder,
      messages: data.messages,
      total: data.total,
      unread: data.unread,
      syncedAt: new Date().toISOString()
    });
  } catch (err: any) {
    console.error('Fejl ved hentning af beskeder:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke hente e-mails fra mappen.' });
  }
});

/**
 * POST /api/mail/message
 */
mailRouter.post('/message', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folder = String(req.body?.folder || 'INBOX').trim();
    const uid = Number(req.body?.uid);
    const markSeen = req.body?.markSeen !== false;

    if (!uid || isNaN(uid)) {
      res.status(400).json({ ok: false, error: 'Ugyldigt besked-UID.' });
      return;
    }

    const message = await fetchMessageDetail(creds, folder, uid, markSeen);
    res.json({ ok: true, message });
  } catch (err: any) {
    console.error('Fejl ved hentning af beskeddetaljer:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke åbne e-mailen.' });
  }
});

/**
 * GET /api/mail/attachment
 */
mailRouter.get('/attachment', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folder = String(req.query?.folder || 'INBOX').trim();
    const uid = Number(req.query?.uid);
    const attachmentId = String(req.query?.id ?? '0');

    if (!uid || isNaN(uid)) {
      res.status(400).json({ ok: false, error: 'Ugyldigt besked-UID.' });
      return;
    }

    const file = await downloadMessageAttachment(creds, folder, uid, attachmentId);
    const safeFilename = encodeURIComponent(file.filename);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFilename}`);
    res.setHeader('Content-Length', String(file.content.length));
    res.send(file.content);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke hente vedhæftningen.' });
  }
});

/**
 * POST /api/mail/flags
 */
mailRouter.post('/flags', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folder = String(req.body?.folder || 'INBOX').trim();
    const uids = Array.isArray(req.body?.uids) ? req.body.uids.map(Number).filter(Boolean) : [];
    const seen = req.body?.seen !== undefined ? Boolean(req.body.seen) : undefined;
    const flagged = req.body?.flagged !== undefined ? Boolean(req.body.flagged) : undefined;

    await updateMessageFlags(creds, folder, uids, { seen, flagged });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke opdatere beskedstatus.' });
  }
});

/**
 * POST /api/mail/folder-mark-all-read
 */
mailRouter.post('/folder-mark-all-read', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folder = String(req.body?.folder || 'INBOX').trim();
    const result = await markAllFolderMessagesAsSeen(creds, folder);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke markere mappen som læst.' });
  }
});

/**
 * POST /api/mail/folder-empty
 */
mailRouter.post('/folder-empty', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folder = String(req.body?.folder || '').trim();
    if (!folder) {
      res.status(400).json({ ok: false, error: 'Mappesti mangler.' });
      return;
    }
    const result = await emptyImapFolder(creds, folder);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke tømme mappen.' });
  }
});

/**
 * POST /api/mail/transfer
 */
mailRouter.post('/transfer', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const sourceFolder = String(req.body?.sourceFolder || '').trim();
    const targetFolder = String(req.body?.targetFolder || '').trim();
    const uids = Array.isArray(req.body?.uids) ? req.body.uids.map(Number).filter(Boolean) : [];
    const mode = req.body?.mode === 'COPY' ? 'COPY' : 'MOVE';

    if (!sourceFolder || !targetFolder || uids.length === 0) {
      res.status(400).json({ ok: false, error: 'Kilde-mappe, mål-mappe og beskeder skal angives.' });
      return;
    }

    await transferMessages(creds, sourceFolder, targetFolder, uids, mode);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke flytte/kopiere e-mails.' });
  }
});

/**
 * DELETE /api/mail/messages
 */
mailRouter.delete('/messages', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folder = String(req.body?.folder || 'INBOX').trim();
    const uids = Array.isArray(req.body?.uids) ? req.body.uids.map(Number).filter(Boolean) : [];
    const permanent = Boolean(req.body?.permanent);

    const result = await deleteMessages(creds, folder, uids, permanent);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke slette e-mails.' });
  }
});

/**
 * POST /api/mail/spam
 */
mailRouter.post('/spam', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const folder = String(req.body?.folder || 'INBOX').trim();
    const uids = Array.isArray(req.body?.uids) ? req.body.uids.map(Number).filter(Boolean) : [];
    const isSpam = req.body?.isSpam !== false;

    const result = await reportSpamStatus(creds, folder, uids, isSpam);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke opdatere spam-status.' });
  }
});

/**
 * POST /api/mail/send
 */
mailRouter.post('/send', sendMailLimiter, async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const to = Array.isArray(req.body?.to)
      ? req.body.to.map((s: any) => String(s).trim()).filter(Boolean)
      : [];
    const cc = Array.isArray(req.body?.cc)
      ? req.body.cc.map((s: any) => String(s).trim()).filter(Boolean)
      : [];
    const bcc = Array.isArray(req.body?.bcc)
      ? req.body.bcc.map((s: any) => String(s).trim()).filter(Boolean)
      : [];

    if (to.length === 0) {
      res.status(400).json({ ok: false, error: 'Angiv mindst én modtager (Til).' });
      return;
    }

    const fromEmail = String(req.body?.fromEmail || creds.username).trim();
    const fromName = String(req.body?.fromName || '').trim();
    const saveAlias = req.body?.saveAlias !== false;

    const payload: SendMailPayload = {
      fromEmail,
      fromName,
      to,
      cc,
      bcc,
      subject: String(req.body?.subject || '').trim(),
      textBody: String(req.body?.textBody || ''),
      htmlBody: req.body?.htmlBody ? String(req.body.htmlBody) : undefined,
      inReplyTo: req.body?.inReplyTo ? String(req.body.inReplyTo) : undefined,
      references: Array.isArray(req.body?.references) ? req.body.references.map(String) : undefined,
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
      saveToSent: req.body?.saveToSent !== false
    };

    const replyMeta =
      req.body?.replyFolder && req.body?.replyUid
        ? { folder: String(req.body.replyFolder), uid: Number(req.body.replyUid) }
        : undefined;

    const replaceDraft =
      req.body?.replaceDraft?.folder && Number(req.body?.replaceDraft?.uid) > 0
        ? {
            folder: String(req.body.replaceDraft.folder).trim(),
            uid: Number(req.body.replaceDraft.uid)
          }
        : undefined;

    const sent = await sendEmailViaSmtp(creds, payload, replyMeta, replaceDraft);

    let aliases = getAliasesForUser(creds.username);
    if (saveAlias && fromEmail.includes('@')) {
      try {
        aliases = upsertAliasForUser(creds.username, {
          email: fromEmail,
          displayName: fromName || undefined
        });
      } catch {
        // Ignorér alias-fejl efter vellykket afsendelse
      }
    }

    res.json({
      ok: true,
      messageId: sent.messageId,
      aliases
    });
  } catch (err: any) {
    console.error('SMTP afsendelsesfejl:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke sende e-mailen via SMTP-serveren.'
    });
  }
});

/**
 * POST /api/mail/drafts
 */
mailRouter.post('/drafts', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const payload: SendMailPayload = {
      fromEmail: String(req.body?.fromEmail || creds.username).trim(),
      fromName: String(req.body?.fromName || '').trim(),
      to: Array.isArray(req.body?.to) ? req.body.to.map(String).filter(Boolean) : [],
      cc: Array.isArray(req.body?.cc) ? req.body.cc.map(String).filter(Boolean) : [],
      bcc: Array.isArray(req.body?.bcc) ? req.body.bcc.map(String).filter(Boolean) : [],
      subject: String(req.body?.subject || '(Kladde uden emne)').trim(),
      textBody: String(req.body?.textBody || ''),
      htmlBody: req.body?.htmlBody ? String(req.body.htmlBody) : undefined,
      inReplyTo: req.body?.inReplyTo ? String(req.body.inReplyTo) : undefined,
      references: Array.isArray(req.body?.references) ? req.body.references.map(String) : undefined,
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : []
    };

    const replaceDraft =
      req.body?.replaceDraft?.folder && Number(req.body?.replaceDraft?.uid) > 0
        ? {
            folder: String(req.body.replaceDraft.folder).trim(),
            uid: Number(req.body.replaceDraft.uid)
          }
        : undefined;

    const saved = await saveDraftToImap(creds, payload, replaceDraft);
    res.json({ ok: true, folder: saved.folder });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Kunne ikke gemme kladden på IMAP-serveren.' });
  }
});

/**
 * GET /api/mail/aliases
 */
mailRouter.get('/aliases', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    let aliases = getAliasesForUser(creds.username);
    try {
      const davCreds = requireDavCredentials(req);
      const resolved = await resolveAliasesWithMailcow(davCreds, false);
      aliases = resolved.aliases;
    } catch {
      // Fallback til lokale aliaser hvis DAV ikke svarer
    }
    res.json({ ok: true, aliases });
  } catch (err: any) {
    res.status(401).json({ ok: false, error: err?.message || 'Ikke logget ind.' });
  }
});

/**
 * POST /api/mail/aliases/sync
 */
mailRouter.post('/aliases/sync', async (req: Request, res: Response) => {
  try {
    const davCreds = requireDavCredentials(req);
    const resolved = await resolveAliasesWithMailcow(davCreds, true, true);
    res.json({
      ok: true,
      aliases: resolved.aliases,
      discoveredCount: resolved.discoveredCount,
      sources: resolved.sources
    });
  } catch (err: any) {
    res.status(401).json({
      ok: false,
      error: err?.message || 'Kunne ikke synkronisere aliaser fra Mailcow.'
    });
  }
});

/**
 * POST /api/mail/aliases
 */
mailRouter.post('/aliases', (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const aliases = upsertAliasForUser(creds.username, {
      id: req.body?.id ? String(req.body.id) : undefined,
      email: String(req.body?.email || ''),
      displayName: req.body?.displayName !== undefined ? String(req.body.displayName) : undefined,
      signature: req.body?.signature !== undefined ? String(req.body.signature) : undefined,
      isDefault: Boolean(req.body?.isDefault)
    });
    res.json({ ok: true, aliases });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message || 'Kunne ikke gemme afsender-alias.' });
  }
});

/**
 * DELETE /api/mail/aliases/:id
 */
mailRouter.delete('/aliases/:id', (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const rawId = req.params.id;
    const aliasId = String(Array.isArray(rawId) ? rawId[0] : rawId || '').trim();
    const aliases = deleteAliasForUser(creds.username, aliasId);
    res.json({ ok: true, aliases });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message || 'Kunne ikke slette afsender-alias.' });
  }
});

/**
 * GET /api/mail/sieve
 */
mailRouter.get('/sieve', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const scriptName = req.query?.script ? String(req.query.script).trim() : '';

    if (scriptName) {
      const specific = await fetchSpecificSieveScript(creds, scriptName);
      res.json({ ok: true, ...specific });
      return;
    }

    const overview = await fetchSieveOverview(creds);
    res.json({ ok: true, overview });
  } catch (err: any) {
    console.error('ManageSieve fejl:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke forbinde til ManageSieve (port 4190) på mailserveren.'
    });
  }
});

/**
 * POST /api/mail/sieve
 */
mailRouter.post('/sieve', async (req: Request, res: Response) => {
  try {
    const creds = requireMailCredentials(req);
    const scriptName = req.body?.scriptName ? String(req.body.scriptName).trim() : undefined;
    const rawScript = typeof req.body?.rawScript === 'string' ? req.body.rawScript : undefined;
    const rules = Array.isArray(req.body?.rules) ? (req.body.rules as SieveRuleDTO[]) : undefined;

    const overview = await saveSieveRulesOrScript(creds, {
      scriptName,
      rules,
      rawScript
    });

    res.json({ ok: true, overview });
  } catch (err: any) {
    console.error('ManageSieve gem-fejl:', err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || 'Kunne ikke gemme Sieve-regler på serveren.'
    });
  }
});
