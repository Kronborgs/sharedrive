import type {
  MailFolder,
  MailHeader,
  MailDetail,
  SenderAlias,
  SieveOverview,
  SieveRule
} from '../types/mail';

async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1/me/mailcow/suite/mail${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP fejl ${res.status}`);
  }
  return data as T;
}

export async function fetchFoldersApi(): Promise<MailFolder[]> {
  const res = await apiRequest<{ folders: MailFolder[] }>('/folders');
  return res.folders || [];
}

export async function createFolderApi(path: string): Promise<MailFolder[]> {
  const res = await apiRequest<{ folders: MailFolder[] }>('/folders', {
    method: 'POST',
    body: JSON.stringify({ path })
  });
  return res.folders || [];
}

export async function renameFolderApi(oldPath: string, newPath: string): Promise<MailFolder[]> {
  const res = await apiRequest<{ folders: MailFolder[] }>('/folders', {
    method: 'PUT',
    body: JSON.stringify({ oldPath, newPath })
  });
  return res.folders || [];
}

export async function deleteFolderApi(path: string): Promise<MailFolder[]> {
  const res = await apiRequest<{ folders: MailFolder[] }>('/folders', {
    method: 'DELETE',
    body: JSON.stringify({ path })
  });
  return res.folders || [];
}

export async function fetchFolderMessagesApi(params: {
  folder: string;
  limit?: number;
  page?: number;
  offset?: number;
  searchQuery?: string;
  searchAllFolders?: boolean;
}): Promise<{ messages: MailHeader[]; total: number; unread: number }> {
  const res = await apiRequest<{
    messages: Omit<MailHeader, 'id'>[];
    total: number;
    unread: number;
  }>('/messages', {
    method: 'POST',
    body: JSON.stringify(params)
  });

  const messages: MailHeader[] = (res.messages || []).map((m) => ({
    ...m,
    id: `${m.folder}::${m.uid}`
  }));

  return {
    messages,
    total: res.total || 0,
    unread: res.unread || 0
  };
}

export async function fetchMessageDetailApi(
  folder: string,
  uid: number,
  markSeen = true
): Promise<MailDetail> {
  const res = await apiRequest<{ message: Omit<MailDetail, 'id'> }>('/message', {
    method: 'POST',
    body: JSON.stringify({ folder, uid, markSeen })
  });
  return {
    ...res.message,
    id: `${res.message.folder}::${res.message.uid}`
  };
}

export function getEmlDownloadUrl(folder: string, uid: number): string {
  const query = new URLSearchParams({ folder, uid: String(uid) });
  return `/api/v1/me/mailcow/suite/mail/eml?${query}`;
}

export async function importEmlFile(folder: string, file: File): Promise<void> {
  if (!/\.eml$/i.test(file.name)) throw new Error('Vælg en .eml-fil.');
  if (file.size > 20 * 1024 * 1024) throw new Error('En .eml-fil må højst fylde 20 MiB.');
  const query = new URLSearchParams({ folder });
  const response = await fetch(`/api/v1/me/mailcow/suite/mail/eml?${query}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'message/rfc822' }, body: file
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Kunne ikke importere mailen.');
}

function mboxUrl(folder: string): string {
  return '/api/v1/me/mailcow/suite/mail/mbox?' + new URLSearchParams({ folder });
}

async function mboxRequest(folder: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(mboxUrl(folder), { ...options, credentials: 'same-origin' });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const error = result.error?.message ?? result.error;
    throw new Error(typeof error === 'string' ? error : `MBOX-overførslen mislykkedes (HTTP ${response.status}).`);
  }
  return response;
}

export async function importMboxFile(folder: string, file: File): Promise<{ imported: number; total: number }> {
  if (file.size > 20 * 1024 * 1024) throw new Error('En MBOX-fil må højst fylde 20 MiB.');
  const response = await mboxRequest(folder, {
    method: 'POST', headers: { 'Content-Type': 'application/mbox' }, body: file
  });
  return response.json();
}

export async function downloadMboxFile(folder: string): Promise<Blob> {
  return (await mboxRequest(folder)).blob();
}

export function fetchSogoSignatureApi(email: string): Promise<{ signature: string; html: boolean }> {
  return apiRequest('/aliases/sogo-signature?' + new URLSearchParams({ email }));
}

export function getAttachmentDownloadUrl(folder: string, uid: number, attachmentId: string, inline = false): string {
  const q = new URLSearchParams({
    folder,
    uid: String(uid),
    id: attachmentId
  });
  if (inline) q.set('inline', '1');
  return `/api/v1/me/mailcow/suite/mail/attachment?${q.toString()}`;
}

export async function updateFlagsApi(params: {
  folder: string;
  uids: number[];
  seen?: boolean;
  flagged?: boolean;
}): Promise<void> {
  await apiRequest('/flags', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}

export async function markAllFolderMessagesAsReadApi(
  folder: string
): Promise<{ markedCount: number }> {
  return apiRequest('/folder-mark-all-read', {
    method: 'POST',
    body: JSON.stringify({ folder })
  });
}

export async function emptyFolderApi(folder: string): Promise<{ deletedCount: number }> {
  return apiRequest('/folder-empty', {
    method: 'POST',
    body: JSON.stringify({ folder })
  });
}

export async function transferMessagesApi(params: {
  sourceFolder: string;
  targetFolder: string;
  uids: number[];
  mode: 'MOVE' | 'COPY';
}): Promise<void> {
  await apiRequest('/transfer', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}

export async function deleteMessagesApi(params: {
  folder: string;
  uids: number[];
  permanent?: boolean;
}): Promise<{ movedToTrash: boolean; trashFolder?: string }> {
  return apiRequest('/messages', {
    method: 'DELETE',
    body: JSON.stringify(params)
  });
}

export async function reportSpamStatusApi(params: {
  folder: string;
  uids: number[];
  isSpam: boolean;
}): Promise<{ targetFolder: string }> {
  return apiRequest('/spam', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}

export async function sendMailApi(params: {
  fromEmail: string;
  fromName?: string;
  saveAlias?: boolean;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
  references?: string[];
  replyFolder?: string;
  replyUid?: number;
  replaceDraft?: { folder: string; uid: number };
  attachments?: Array<{
    filename: string;
    contentType: string;
    contentBase64: string;
  }>;
}): Promise<{ messageId: string; aliases: SenderAlias[] }> {
  return apiRequest('/send', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}

export async function saveDraftApi(params: {
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
  replaceDraft?: { folder: string; uid: number };
  attachments?: Array<{
    filename: string;
    contentType: string;
    contentBase64: string;
  }>;
}): Promise<{ folder: string }> {
  return apiRequest('/drafts', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}

export async function fetchAliasesApi(): Promise<SenderAlias[]> {
  const res = await apiRequest<{ aliases: SenderAlias[] }>('/aliases');
  return res.aliases || [];
}

export async function syncMailcowAliasesApi(): Promise<{
  aliases: SenderAlias[];
  discoveredCount: number;
  sources: { sogoDav: boolean; mailcowApi: boolean };
}> {
  const res = await apiRequest<{
    aliases: SenderAlias[];
    discoveredCount: number;
    sources: { sogoDav: boolean; mailcowApi: boolean };
  }>('/aliases/sync', {
    method: 'POST'
  });
  return {
    aliases: res.aliases || [],
    discoveredCount: Number(res.discoveredCount || 0),
    sources: res.sources || { sogoDav: false, mailcowApi: false }
  };
}

export async function upsertAliasApi(params: {
  id?: string;
  email: string;
  displayName?: string;
  signature?: string;
  isDefault?: boolean;
}): Promise<SenderAlias[]> {
  const res = await apiRequest<{ aliases: SenderAlias[] }>('/aliases', {
    method: 'POST',
    body: JSON.stringify(params)
  });
  return res.aliases || [];
}

export async function deleteAliasApi(id: string): Promise<SenderAlias[]> {
  const res = await apiRequest<{ aliases: SenderAlias[] }>(`/aliases/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });
  return res.aliases || [];
}

export async function fetchSieveOverviewApi(): Promise<SieveOverview> {
  const res = await apiRequest<{ overview: SieveOverview }>('/sieve');
  return res.overview;
}

export async function fetchSpecificSieveScriptApi(
  scriptName: string
): Promise<{ scriptName: string; rawScript: string; rules: SieveRule[] }> {
  return apiRequest(`/sieve?script=${encodeURIComponent(scriptName)}`);
}

export async function saveSieveApi(params: {
  scriptName?: string;
  rules?: SieveRule[];
  rawScript?: string;
}): Promise<SieveOverview> {
  const res = await apiRequest<{ overview: SieveOverview }>('/sieve', {
    method: 'POST',
    body: JSON.stringify(params)
  });
  return res.overview;
}
