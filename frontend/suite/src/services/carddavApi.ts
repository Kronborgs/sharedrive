import type { AddressBook, Contact } from '../types/contacts';
import { reportPausedMailcow } from './authApi';

export interface CardDavSyncResponse {
  ok: boolean;
  addressBooks: AddressBook[];
  contacts: Contact[];
  failedAddressBookIds?: string[];
  calendarColor?: string | null;
  syncedAt: string;
  error?: string;
}

export async function apiSyncCardDav(): Promise<CardDavSyncResponse> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/sync', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
  reportPausedMailcow(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Synkronisering med CardDAV-adressebog mislykkedes.');
  }
  return data as CardDavSyncResponse;
}

export async function apiSaveContact(contact: Contact): Promise<Contact> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/contacts', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ contact })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke gemme kontakten på serveren.');
  }
  return data.contact as Contact;
}

export async function apiToggleContactFavorite(
  contactId: string,
  starred: boolean,
  contact?: Contact
): Promise<{ starred: boolean; contact?: Contact }> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/favorite', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ contactId, starred, contact })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke opdatere favorit-status.');
  }
  return {
    starred: Boolean(data.starred),
    contact: data.contact as Contact | undefined
  };
}

export async function apiDeleteContact(vcardUrl: string, etag?: string): Promise<void> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/contacts', {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ vcardUrl, etag })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke slette kontakten på serveren.');
  }
}

export async function apiBulkUpdateContacts(
  contacts: Contact[]
): Promise<{ updatedCount: number; failedCount: number; contacts: Contact[] }> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/contacts/bulk-update', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ contacts })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke bulk-opdatere kontakter på serveren.');
  }
  return {
    updatedCount: Number(data.updatedCount || 0),
    failedCount: Number(data.failedCount || 0),
    contacts: (data.contacts || []) as Contact[]
  };
}

export async function apiBulkDeleteContacts(
  items: Array<{ id: string; vcardUrl?: string; etag?: string }>
): Promise<{ deletedCount: number; failedCount: number; deletedIds: string[] }> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/contacts/bulk-delete', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ items })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke slette de valgte kontakter på serveren.');
  }
  return {
    deletedCount: Number(data.deletedCount || 0),
    failedCount: Number(data.failedCount || 0),
    deletedIds: (data.deletedIds || []) as string[]
  };
}

export async function apiBulkSetFavorite(
  starred: boolean,
  items: Array<{ contactId: string; contact?: Contact }>
): Promise<{ starred: boolean; updatedCount: number; contacts: Contact[] }> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/favorites/bulk', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ starred, items })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke opdatere favorit-status for de valgte kontakter.');
  }
  return {
    starred: Boolean(data.starred),
    updatedCount: Number(data.updatedCount || 0),
    contacts: (data.contacts || []) as Contact[]
  };
}

export async function apiImportVcf(
  addressBookId: string,
  vcfContent: string
): Promise<{ importedCount: number; failedCount: number; contacts: Contact[] }> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/import', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ addressBookId, vcfContent })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke importere .vcf-filen.');
  }
  return {
    importedCount: data.importedCount || 0,
    failedCount: data.failedCount || 0,
    contacts: data.contacts || []
  };
}

export async function apiExportVcf(contacts: Contact[]): Promise<string> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/export', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ contacts })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke eksportere kontakter.');
  }
  return data.vcfContent as string;
}

export async function apiSaveContactCalendarColor(
  calendarColor: string | null
): Promise<string | null> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/prefs', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ calendarColor })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke gemme farvevalg.');
  }
  return (data.calendarColor as string | null) ?? null;
}

export async function apiFetchContactPhoto(params: {
  email?: string;
  url?: string;
}): Promise<string | null> {
  const res = await fetch('/api/v1/me/mailcow/suite/carddav/fetch-photo', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke hente profilbillede.');
  }
  return (data.photoDataUrl as string | null) ?? null;
}
