import Dexie, { type Table } from 'dexie';
import type { MailFolder, MailHeader, MailDetail } from '../types/mail';
import type {
  CalendarSource,
  CalendarEvent,
  TrashItem,
  SyncQueueItem
} from '../types/calendar';
import type { AddressBook, Contact } from '../types/contacts';

export class SharedriveMailDatabase extends Dexie {
  mailFolders!: Table<MailFolder, string>;
  mailHeaders!: Table<MailHeader, string>;
  mailDetails!: Table<MailDetail, string>;

  calendars!: Table<CalendarSource, string>;
  events!: Table<CalendarEvent, string>;
  trash!: Table<TrashItem, string>;
  syncQueue!: Table<SyncQueueItem, number>;

  addressBooks!: Table<AddressBook, string>;
  contacts!: Table<Contact, string>;

  constructor(scope: string) {
    super('SharedriveMail:' + scope);

    this.version(1).stores({
      mailFolders: 'path, specialUse',
      mailHeaders: 'id, folder, uid, date, seen, flagged',
      mailDetails: 'id, folder, uid',
      calendars: 'id, name, readOnly, isShared, visible',
      events: 'id, uid, calendarId, start, end, title',
      trash: 'id, deletedAt, expiresAt',
      syncQueue: '++id, action, eventId, createdAt',
      addressBooks: 'id, name, readOnly, isShared',
      contacts: 'id, uid, addressBookId, fullName, lastName'
    });
  }
}

export let db: SharedriveMailDatabase;

export function setDatabaseScope(scope: string) {
  db = new SharedriveMailDatabase(scope);
}

/**
 * Rydder automatisk op i papirkurven for elementer, der er ældre end 30 dage.
 */
export async function purgeExpiredTrash(): Promise<number> {
  const nowIso = new Date().toISOString();
  const expired = await db.trash.where('expiresAt').below(nowIso).toArray();
  if (expired.length > 0) {
    await db.trash.bulkDelete(expired.map((item) => item.id));
  }
  return expired.length;
}

/**
 * Rydder al cached brugerdata i IndexedDB ved log ud.
 */
export async function clearAllSuiteCaches(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.mailFolders,
      db.mailHeaders,
      db.mailDetails,
      db.calendars,
      db.events,
      db.syncQueue,
      db.addressBooks,
      db.contacts
    ],
    async () => {
      await db.mailFolders.clear();
      await db.mailHeaders.clear();
      await db.mailDetails.clear();
      await db.calendars.clear();
      await db.events.clear();
      await db.syncQueue.clear();
      await db.addressBooks.clear();
      await db.contacts.clear();
    }
  );
}
