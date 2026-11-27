import { suiteStorage } from '../sharedrive-storage';
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { db } from '../db/database';
import { useSuiteStore } from './suiteStore';
import type { AddressBook, Contact } from '../types/contacts';
import {
  apiSyncCardDav,
  apiSaveContact,
  apiToggleContactFavorite,
  apiSaveContactCalendarColor,
  apiDeleteContact,
  apiBulkUpdateContacts,
  apiBulkDeleteContacts,
  apiBulkSetFavorite,
  apiImportVcf,
  apiExportVcf
} from '../services/carddavApi';

export const DEFAULT_CONTACT_CALENDAR_COLOR = '#ec4899';
const CONTACT_CAL_COLOR_STORAGE_KEY = 'brogaard_contact_calendar_color_v1';

export interface ContactSenderContext {
  senderName: string;
  senderEmail: string;
  emailImages: string[];
}

function toPlainObject<T>(val: T): T {
  if (val === null || val === undefined) return val;
  return JSON.parse(JSON.stringify(val)) as T;
}

export const useContactsStore = defineStore('contacts', () => {
  const suiteStore = useSuiteStore();

  const addressBooks = ref<AddressBook[]>([]);
  const contacts = ref<Contact[]>([]);
  const isSyncing = ref(false);
  const isSaving = ref(false);
  const lastSyncedAt = ref<string | null>(null);
  const contactsMutationCounter = ref(0);

  const selectedAddressBookId = ref<string>('ALL');
  const selectedCategory = ref<string>('ALL');
  const searchQuery = ref<string>('');
  const selectedContactId = ref<string | null>(null);
  const selectedContactIds = ref<string[]>([]);
  const selectionAnchorId = ref<string | null>(null);
  const selectionFocusId = ref<string | null>(null);
  const isBulkUpdating = ref(false);

  const editingContact = ref<Contact | null>(null);
  const isContactModalOpen = ref<boolean>(false);
  const senderContext = ref<ContactSenderContext | null>(null);
  const contactCalendarColor = ref<string>(
    suiteStorage.getItem(CONTACT_CAL_COLOR_STORAGE_KEY) || DEFAULT_CONTACT_CALENDAR_COLOR
  );

  const writableAddressBooks = computed(() =>
    addressBooks.value.filter((b) => !b.readOnly)
  );

  const defaultWritableAddressBook = computed<AddressBook | undefined>(
    () => writableAddressBooks.value[0] || addressBooks.value[0]
  );

  const allCategories = computed<Array<{ name: string; count: number }>>(() => {
    const counts = new Map<string, number>();
    for (const c of contacts.value) {
      for (const cat of c.categories || []) {
        const clean = cat.trim();
        if (!clean) continue;
        counts.set(clean, (counts.get(clean) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'da-DK'));
  });

  const contactsWithBirthdaysCount = computed<number>(
    () => contacts.value.filter((c) => Boolean(c.birthday && /^\d{4}-\d{2}-\d{2}/.test(c.birthday))).length
  );

  const contactsWithAnniversariesCount = computed<number>(
    () => contacts.value.filter((c) => Boolean(c.anniversary && /^\d{4}-\d{2}-\d{2}/.test(c.anniversary))).length
  );

  const contactsWithSpecialDatesCount = computed<number>(
    () =>
      contacts.value.filter(
        (c) =>
          Boolean(c.birthday && /^\d{4}-\d{2}-\d{2}/.test(c.birthday)) ||
          Boolean(c.anniversary && /^\d{4}-\d{2}-\d{2}/.test(c.anniversary))
      ).length
  );

  const favoritesCount = computed<number>(
    () => contacts.value.filter((c) => Boolean(c.starred)).length
  );

  const filteredContacts = computed<Contact[]>(() => {
    const q = searchQuery.value.trim().toLowerCase();
    return contacts.value
      .filter((c) => {
        if (selectedAddressBookId.value === 'FAVORITES') {
          if (!c.starred) return false;
        } else if (
          selectedAddressBookId.value !== 'ALL' &&
          c.addressBookId !== selectedAddressBookId.value
        ) {
          return false;
        }
        if (
          selectedCategory.value !== 'ALL' &&
          !(c.categories || []).includes(selectedCategory.value)
        ) {
          return false;
        }
        if (!q) return true;

        const haystack = [
          c.fullName,
          c.firstName,
          c.lastName,
          c.nickname || '',
          c.organization || '',
          c.title || '',
          c.notes || '',
          ...(c.emails || []).map((e) => e.value),
          ...(c.phones || []).map((p) => p.value),
          ...(c.categories || [])
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'da-DK'));
  });

  const selectedContact = computed<Contact | null>(() => {
    if (!selectedContactId.value) return null;
    return contacts.value.find((c) => c.id === selectedContactId.value) || null;
  });

  const selectedContacts = computed<Contact[]>(() => {
    if (selectedContactIds.value.length === 0) return [];
    const idSet = new Set(selectedContactIds.value);
    return contacts.value
      .filter((c) => idSet.has(c.id))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'da-DK'));
  });

  const writableSelectedContacts = computed<Contact[]>(() =>
    selectedContacts.value.filter((c) => !isAddressBookReadOnly(c.addressBookId))
  );

  const readOnlySelectedCount = computed<number>(
    () => selectedContacts.value.length - writableSelectedContacts.value.length
  );

  function isContactSelected(id: string): boolean {
    return selectedContactIds.value.includes(id);
  }

  function clearSelection(): void {
    selectedContactIds.value = [];
  }

  function getAddressBookById(id: string): AddressBook | undefined {
    return addressBooks.value.find((b) => b.id === id);
  }

  function isAddressBookReadOnly(id: string): boolean {
    return Boolean(getAddressBookById(id)?.readOnly);
  }

  async function hydrateSession() {
    try {
      const [cachedBooks, cachedContacts] = await Promise.all([
        db.addressBooks.toArray(),
        db.contacts.toArray()
      ]);
      if (cachedBooks.length > 0) addressBooks.value = cachedBooks;
      if (cachedContacts.length > 0) contacts.value = cachedContacts;
    } catch {
      // Ignorér IndexedDB fejl
    }

    if (suiteStore.isOnline) {
      await syncWithServer(true);
    }
  }

  const syncError = ref('');

  async function syncWithServer(silent = false) {
    if (!suiteStore.isAuthenticated || suiteStore.isPublicShareMode || isSyncing.value) return;
    isSyncing.value = true;
    try {
      const res = await apiSyncCardDav();
      const plainBooks = toPlainObject(res.addressBooks || []);
      const failed = new Set(res.failedAddressBookIds);
      const previous = contacts.value.filter(contact => failed.has(contact.addressBookId));
      const plainContacts = toPlainObject([...(res.contacts || []), ...previous]);

      addressBooks.value = plainBooks;
      contacts.value = plainContacts;
      syncError.value = failed.size
        ? 'Nogle adressebøger kunne ikke synkroniseres fra SOGo. Tidligere hentede kontakter vises fortsat.'
        : '';
      if (!failed.size) lastSyncedAt.value = res.syncedAt;
      if (res.calendarColor && /^#[0-9a-fA-F]{6}$/.test(res.calendarColor)) {
        contactCalendarColor.value = res.calendarColor.toLowerCase();
        suiteStorage.setItem(CONTACT_CAL_COLOR_STORAGE_KEY, contactCalendarColor.value);
      } else if (res.calendarColor === null) {
        contactCalendarColor.value = DEFAULT_CONTACT_CALENDAR_COLOR;
        suiteStorage.removeItem(CONTACT_CAL_COLOR_STORAGE_KEY);
      }

      await db.transaction('rw', db.addressBooks, db.contacts, async () => {
        await db.addressBooks.clear();
        await db.contacts.clear();
        if (plainBooks.length > 0) await db.addressBooks.bulkPut(plainBooks);
        if (plainContacts.length > 0) await db.contacts.bulkPut(plainContacts);
      });

      selectedContactIds.value = selectedContactIds.value.filter((id) =>
        plainContacts.some((c) => c.id === id)
      );
      if (selectedContactId.value && !plainContacts.some((c) => c.id === selectedContactId.value)) {
        selectedContactId.value = plainContacts[0]?.id || null;
      } else if (!selectedContactId.value && plainContacts.length > 0) {
        selectedContactId.value = plainContacts[0].id;
      }

      if (!silent && syncError.value) {
        suiteStore.notify('Delvis synkronisering', syncError.value, 'warning');
      } else if (!silent) {
        suiteStore.notify(
          'Kontakter synkroniseret',
          `Hentede ${plainContacts.length} kontakt(er) fra CardDAV.`,
          'success'
        );
      }
    } catch (err: any) {
      syncError.value = 'Kontakter kunne ikke synkroniseres fra SOGo. Prøv at synkronisere igen.';
      if (!silent) {
        suiteStore.notify(
          'CardDAV synkroniseringsfejl',
          err?.message || 'Kunne ikke kontakte Mailcow CardDAV.',
          'error'
        );
      }
    } finally {
      isSyncing.value = false;
    }
  }

  function openCreateContactModal(prefill?: {
    fullName?: string;
    email?: string;
    emailImages?: string[];
  }) {
    const book = defaultWritableAddressBook.value;
    if (!book || book.readOnly) {
      suiteStore.notify(
        'Ingen skrivbar adressebog',
        'Alle tilgængelige adressebøger er skrivebeskyttede.',
        'warning'
      );
      return;
    }

    const fullName = (prefill?.fullName || '').trim();
    const parts = fullName ? fullName.split(/\s+/) : [];
    const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '';
    const lastName = parts.length > 1 ? parts[parts.length - 1] : '';
    const cleanEmail = (prefill?.email || '').trim();

    senderContext.value = cleanEmail
      ? {
          senderName: fullName,
          senderEmail: cleanEmail,
          emailImages: prefill?.emailImages || []
        }
      : null;

    editingContact.value = {
      id: '',
      uid: '',
      addressBookId: book.id,
      fullName,
      firstName,
      lastName,
      nickname: '',
      organization: '',
      title: '',
      emails: cleanEmail
        ? [{ type: 'other', value: cleanEmail, pref: true }]
        : [{ type: 'home', value: '', pref: true }],
      phones: [{ type: 'mobile', value: '', pref: true }],
      birthday: '',
      anniversary: '',
      anniversaryLabel: 'Bryllupsdag',
      address: { street: '', city: '', postalCode: '', country: '' },
      website: '',
      notes: '',
      categories: [],
      starred: selectedAddressBookId.value === 'FAVORITES',
      photoDataUrl: undefined
    };
    isContactModalOpen.value = true;
  }

  function openEditContactModal(contact: Contact) {
    senderContext.value = null;
    editingContact.value = toPlainObject({
      ...contact,
      emails: contact.emails.length > 0 ? contact.emails : [{ type: 'home', value: '' }],
      phones: contact.phones.length > 0 ? contact.phones : [{ type: 'mobile', value: '' }],
      anniversary: contact.anniversary || '',
      anniversaryLabel: contact.anniversaryLabel || 'Bryllupsdag',
      address: contact.address || { street: '', city: '', postalCode: '', country: '' },
      categories: contact.categories || [],
      starred: Boolean(contact.starred)
    });
    isContactModalOpen.value = true;
  }

  function openMergeSenderIntoContact(
    contact: Contact,
    sender: { fullName?: string; email: string; emailImages?: string[] }
  ) {
    if (isAddressBookReadOnly(contact.addressBookId)) {
      suiteStore.notify(
        'Skrivebeskyttet adressebog',
        `"${contact.fullName}" ligger i en skrivebeskyttet adressebog og kan ikke ændres.`,
        'warning'
      );
      return;
    }

    const cleanEmail = sender.email.trim();
    const cloned = toPlainObject({
      ...contact,
      emails: (contact.emails || []).map((e) => ({ ...e })),
      phones: contact.phones.length > 0 ? contact.phones.map((p) => ({ ...p })) : [{ type: 'mobile', value: '' }],
      anniversary: contact.anniversary || '',
      anniversaryLabel: contact.anniversaryLabel || 'Bryllupsdag',
      address: contact.address || { street: '', city: '', postalCode: '', country: '' },
      categories: [...(contact.categories || [])],
      starred: Boolean(contact.starred)
    });

    if (
      cleanEmail &&
      !cloned.emails.some((e) => e.value.trim().toLowerCase() === cleanEmail.toLowerCase())
    ) {
      cloned.emails.push({
        type: cloned.emails.length === 0 ? 'home' : 'other',
        value: cleanEmail,
        pref: cloned.emails.length === 0
      });
    } else if (cloned.emails.length === 0) {
      cloned.emails.push({ type: 'home', value: '' });
    }

    senderContext.value = {
      senderName: (sender.fullName || contact.fullName || '').trim(),
      senderEmail: cleanEmail,
      emailImages: sender.emailImages || []
    };
    editingContact.value = cloned;
    isContactModalOpen.value = true;
  }

  async function saveContact(input: Contact): Promise<Contact | null> {
    if (isAddressBookReadOnly(input.addressBookId)) {
      suiteStore.notify('Skrivebeskyttet', 'Adressebogen er skrivebeskyttet.', 'error');
      return null;
    }

    isSaving.value = true;
    try {
      const cleaned: Contact = toPlainObject({
        ...input,
        emails: (input.emails || []).filter((e) => e.value.trim().length > 0),
        phones: (input.phones || []).filter((p) => p.value.trim().length > 0),
        categories: (input.categories || []).map((c) => c.trim()).filter(Boolean)
      });

      const saved = toPlainObject(await apiSaveContact(cleaned));

      if (input.id && input.id !== saved.id) {
        contacts.value = contacts.value.filter((c) => c.id !== input.id);
        await db.contacts.delete(input.id).catch(() => {});
      }

      const idx = contacts.value.findIndex((c) => c.id === saved.id);
      if (idx !== -1) {
        contacts.value[idx] = saved;
      } else {
        contacts.value.push(saved);
      }
      await db.contacts.put(saved).catch(() => {});
      selectedContactId.value = saved.id;
      senderContext.value = null;
      isContactModalOpen.value = false;
      contactsMutationCounter.value += 1;

      suiteStore.notify('Kontakt gemt', `"${saved.fullName}" er synkroniseret til Mailcow.`, 'success');
      return saved;
    } catch (err: any) {
      suiteStore.notify(
        'Kunne ikke gemme kontakt',
        err?.message || 'Fejl ved gem på CardDAV-serveren.',
        'error'
      );
      return null;
    } finally {
      isSaving.value = false;
    }
  }

  async function toggleFavorite(contact: Contact): Promise<void> {
    const idx = contacts.value.findIndex((c) => c.id === contact.id);
    if (idx === -1) return;

    const prevStarred = Boolean(contacts.value[idx].starred);
    const nextStarred = !prevStarred;

    const optimistic: Contact = toPlainObject({
      ...contacts.value[idx],
      starred: nextStarred
    });
    contacts.value[idx] = optimistic;
    await db.contacts.put(optimistic).catch(() => {});

    try {
      const canWriteVcard = !isAddressBookReadOnly(optimistic.addressBookId);
      const res = await apiToggleContactFavorite(
        optimistic.id,
        nextStarred,
        canWriteVcard ? optimistic : undefined
      );
      if (res.contact) {
        const plainSaved = toPlainObject({ ...res.contact, starred: nextStarred });
        const curIdx = contacts.value.findIndex((c) => c.id === optimistic.id || c.id === plainSaved.id);
        if (curIdx !== -1) {
          contacts.value[curIdx] = plainSaved;
        }
        await db.contacts.put(plainSaved).catch(() => {});
      }
    } catch (err: any) {
      const revertIdx = contacts.value.findIndex((c) => c.id === contact.id);
      if (revertIdx !== -1) {
        const reverted = toPlainObject({ ...contacts.value[revertIdx], starred: prevStarred });
        contacts.value[revertIdx] = reverted;
        await db.contacts.put(reverted).catch(() => {});
      }
      suiteStore.notify(
        'Kunne ikke opdatere favorit',
        err?.message || 'Prøv igen om et øjeblik.',
        'error'
      );
    }
  }

  async function updateContactPhotoQuick(
    contact: Contact,
    photoDataUrl: string | null
  ): Promise<Contact | null> {
    return saveContact({
      ...toPlainObject(contact),
      photoDataUrl
    });
  }

  async function setContactCalendarColor(newColor: string | null): Promise<void> {
    const clean =
      typeof newColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(newColor.trim())
        ? newColor.trim().toLowerCase()
        : null;

    if (clean) {
      contactCalendarColor.value = clean;
      suiteStorage.setItem(CONTACT_CAL_COLOR_STORAGE_KEY, clean);
    } else {
      contactCalendarColor.value = DEFAULT_CONTACT_CALENDAR_COLOR;
      suiteStorage.removeItem(CONTACT_CAL_COLOR_STORAGE_KEY);
    }

    if (suiteStore.isAuthenticated && !suiteStore.isPublicShareMode && suiteStore.isOnline) {
      try {
        await apiSaveContactCalendarColor(clean);
      } catch {
        // Bevares lokalt ved midlertidig netværksfejl
      }
    }
  }

  async function deleteContact(contact: Contact): Promise<boolean> {
    if (isAddressBookReadOnly(contact.addressBookId)) {
      suiteStore.notify('Skrivebeskyttet', 'Adressebogen er skrivebeskyttet.', 'error');
      return false;
    }

    try {
      if (contact.vcardUrl) {
        await apiDeleteContact(contact.vcardUrl, contact.etag);
      }
      contacts.value = contacts.value.filter((c) => c.id !== contact.id);
      selectedContactIds.value = selectedContactIds.value.filter((id) => id !== contact.id);
      await db.contacts.delete(contact.id).catch(() => {});
      if (selectedContactId.value === contact.id) {
        selectedContactId.value = filteredContacts.value[0]?.id || null;
      }
      contactsMutationCounter.value += 1;
      suiteStore.notify('Kontakt slettet', `"${contact.fullName}" blev slettet fra adressebogen.`, 'info');
      return true;
    } catch (err: any) {
      suiteStore.notify('Kunne ikke slette kontakt', err?.message || 'CardDAV fejl.', 'error');
      return false;
    }
  }

  async function importVcfFile(addressBookId: string, vcfContent: string): Promise<number> {
    if (isAddressBookReadOnly(addressBookId)) {
      suiteStore.notify('Skrivebeskyttet adressebog', 'Vælg en skrivbar adressebog.', 'error');
      return 0;
    }

    const res = await apiImportVcf(addressBookId, vcfContent);
    const plain = toPlainObject(res.contacts);
    for (const c of plain) {
      const idx = contacts.value.findIndex((item) => item.id === c.id);
      if (idx !== -1) {
        contacts.value[idx] = c;
      } else {
        contacts.value.push(c);
      }
    }
    await db.contacts.bulkPut(plain).catch(() => {});
    if (res.importedCount > 0) {
      contactsMutationCounter.value += 1;
    }
    suiteStore.notify(
      'Kontakter importeret (.vcf)',
      `Importerede ${res.importedCount} kontakt(er) til Mailcow.`,
      'success'
    );
    return res.importedCount;
  }

  async function exportContactsVcf(list?: Contact[]): Promise<void> {
    const targets = toPlainObject(list && list.length > 0 ? list : filteredContacts.value);
    if (targets.length === 0) {
      suiteStore.notify('Ingen kontakter', 'Der er ingen kontakter at eksportere.', 'warning');
      return;
    }
    const vcfContent = await apiExportVcf(targets);
    const blob = new Blob([vcfContent], { type: 'text/vcard;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const datePart = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `brogaard-kontakter-${datePart}.vcf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    suiteStore.notify(
      'Kontakter eksporteret (.vcf)',
      `Downloadede ${targets.length} kontakt(er) som vCard.`,
      'success'
    );
  }

  function findContactByEmail(email: string): Contact | null {
    const clean = email.trim().toLowerCase();
    if (!clean) return null;
    return (
      contacts.value.find((c) =>
        (c.emails || []).some((e) => e.value.trim().toLowerCase() === clean)
      ) || null
    );
  }

  function normalizeMatchText(raw?: string): string {
    return (raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function findBestWritableNameMatch(name: string): Contact | null {
    const target = normalizeMatchText(name);
    if (!target || target.length < 2) return null;

    for (const c of contacts.value) {
      if (isAddressBookReadOnly(c.addressBookId)) continue;
      const fullNorm = normalizeMatchText(c.fullName);
      const joinedNorm = normalizeMatchText(`${c.firstName || ''} ${c.lastName || ''}`);
      if (fullNorm === target || (joinedNorm && joinedNorm === target)) {
        return c;
      }
    }
    return null;
  }

  function findMatchingWritableContacts(
    name: string,
    query?: string,
    limit = 8
  ): Contact[] {
    const q = normalizeMatchText(query);
    const nameNorm = normalizeMatchText(name);
    const nameTokens = nameNorm
      .split(/[\s,._-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);

    const scored: Array<{ contact: Contact; score: number }> = [];

    for (const c of contacts.value) {
      if (isAddressBookReadOnly(c.addressBookId)) continue;

      const haystack = normalizeMatchText(
        [
          c.fullName,
          c.firstName,
          c.lastName,
          c.nickname || '',
          c.organization || '',
          ...(c.emails || []).map((e) => e.value),
          ...(c.phones || []).map((p) => p.value)
        ].join(' ')
      );

      if (q) {
        if (!haystack.includes(q)) continue;
        let score = 10;
        if (normalizeMatchText(c.fullName).startsWith(q)) score += 20;
        if (nameNorm && normalizeMatchText(c.fullName) === nameNorm) score += 50;
        scored.push({ contact: c, score });
      } else if (nameNorm || nameTokens.length > 0) {
        let score = 0;
        const fullNorm = normalizeMatchText(c.fullName);
        if (nameNorm && fullNorm === nameNorm) {
          score += 100;
        } else if (nameNorm && fullNorm.includes(nameNorm)) {
          score += 50;
        }
        for (const tok of nameTokens) {
          if (fullNorm.includes(tok)) score += 20;
          else if (haystack.includes(tok)) score += 10;
        }
        if (score > 0) {
          scored.push({ contact: c, score });
        }
      }
    }

    if (scored.length === 0 && !q) {
      return contacts.value
        .filter((c) => !isAddressBookReadOnly(c.addressBookId))
        .slice()
        .sort((a, b) => a.fullName.localeCompare(b.fullName, 'da-DK'))
        .slice(0, limit);
    }

    return scored
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.contact.fullName.localeCompare(b.contact.fullName, 'da-DK')
      )
      .slice(0, limit)
      .map((x) => x.contact);
  }

  async function mergeContacts(
    primaryContact: Contact,
    secondaryContacts: Contact[]
  ): Promise<Contact | null> {
    if (isAddressBookReadOnly(primaryContact.addressBookId)) {
      suiteStore.notify(
        'Skrivebeskyttet kontakt',
        'Den valgte hovedkontakt ligger i en skrivebeskyttet adressebog.',
        'warning'
      );
      return null;
    }

    const secondaries = secondaryContacts.filter(
      (c) => c.id !== primaryContact.id && !isAddressBookReadOnly(c.addressBookId)
    );
    if (secondaries.length === 0) {
      suiteStore.notify(
        'Ingen dubletter at flette',
        'Vælg mindst to skrivbare kontakter for at flette dem.',
        'warning'
      );
      return null;
    }

    const merged = toPlainObject(primaryContact);
    const emailSeen = new Set<string>(
      (merged.emails || []).map((e) => e.value.trim().toLowerCase()).filter(Boolean)
    );
    const phoneSeen = new Set<string>(
      (merged.phones || []).map((p) => p.value.replace(/[\s()-]+/g, '').toLowerCase()).filter(Boolean)
    );
    const catSeen = new Set<string>(
      (merged.categories || []).map((t) => t.trim().toLowerCase()).filter(Boolean)
    );
    const noteParts: string[] = [];
    if (merged.notes?.trim()) noteParts.push(merged.notes.trim());

    for (const sec of secondaries) {
      for (const em of sec.emails || []) {
        const cleanVal = em.value.trim();
        const key = cleanVal.toLowerCase();
        if (!cleanVal || emailSeen.has(key)) continue;
        emailSeen.add(key);
        merged.emails.push({ ...em, value: cleanVal, pref: merged.emails.length === 0 });
      }

      for (const ph of sec.phones || []) {
        const cleanVal = ph.value.trim();
        const key = cleanVal.replace(/[\s()-]+/g, '').toLowerCase();
        if (!cleanVal || phoneSeen.has(key)) continue;
        phoneSeen.add(key);
        merged.phones.push({ ...ph, value: cleanVal, pref: merged.phones.length === 0 });
      }

      for (const rawCat of sec.categories || []) {
        const cleanCat = rawCat.trim();
        const key = cleanCat.toLowerCase();
        if (!cleanCat || catSeen.has(key)) continue;
        catSeen.add(key);
        merged.categories.push(cleanCat);
      }

      if (sec.notes?.trim()) {
        const secNote = sec.notes.trim();
        if (!noteParts.some((n) => n === secNote)) {
          noteParts.push(secNote);
        }
      }

      if (!merged.firstName?.trim() && sec.firstName?.trim()) merged.firstName = sec.firstName.trim();
      if (!merged.lastName?.trim() && sec.lastName?.trim()) merged.lastName = sec.lastName.trim();
      if (!merged.nickname?.trim() && sec.nickname?.trim()) merged.nickname = sec.nickname.trim();
      if (!merged.organization?.trim() && sec.organization?.trim()) merged.organization = sec.organization.trim();
      if (!merged.title?.trim() && sec.title?.trim()) merged.title = sec.title.trim();
      if (!merged.birthday?.trim() && sec.birthday?.trim()) merged.birthday = sec.birthday.trim();
      if (!merged.anniversary?.trim() && sec.anniversary?.trim()) {
        merged.anniversary = sec.anniversary.trim();
        merged.anniversaryLabel = sec.anniversaryLabel || merged.anniversaryLabel || 'Bryllupsdag';
      }
      if (!merged.website?.trim() && sec.website?.trim()) merged.website = sec.website.trim();
      if (!merged.photoDataUrl && sec.photoDataUrl) merged.photoDataUrl = sec.photoDataUrl;

      const hasMergedAddr = Boolean(
        merged.address?.street?.trim() || merged.address?.city?.trim() || merged.address?.postalCode?.trim()
      );
      const hasSecAddr = Boolean(
        sec.address?.street?.trim() || sec.address?.city?.trim() || sec.address?.postalCode?.trim()
      );
      if (!hasMergedAddr && hasSecAddr && sec.address) {
        merged.address = { ...sec.address };
      }

      if (sec.starred) {
        merged.starred = true;
      }
    }

    merged.notes = noteParts.length > 0 ? noteParts.join('\n\n') : undefined;

    isBulkUpdating.value = true;
    try {
      // Gem altid hovedkontakten først — slet aldrig dubletter hvis gem fejler!
      const savedPrimary = toPlainObject(await apiSaveContact(merged));
      const pIdx = contacts.value.findIndex((c) => c.id === savedPrimary.id || c.id === primaryContact.id);
      if (pIdx !== -1) {
        contacts.value[pIdx] = savedPrimary;
      } else {
        contacts.value.push(savedPrimary);
      }
      await db.contacts.put(savedPrimary).catch(() => {});

      const delRes = await apiBulkDeleteContacts(
        secondaries.map((c) => ({
          id: c.id,
          vcardUrl: c.vcardUrl,
          etag: c.etag
        }))
      );
      const removedSet = new Set(
        delRes.deletedIds.length > 0
          ? delRes.deletedIds
          : delRes.failedCount === 0
            ? secondaries.map((c) => c.id)
            : []
      );
      const removedIds = Array.from(removedSet);
      if (removedIds.length > 0) {
        contacts.value = contacts.value.filter((c) => !removedSet.has(c.id));
        await db.contacts.bulkDelete(removedIds).catch(() => {});
      }

      selectedContactIds.value = [];
      selectedContactId.value = savedPrimary.id;
      selectionAnchorId.value = savedPrimary.id;
      selectionFocusId.value = savedPrimary.id;
      contactsMutationCounter.value += 1;

      suiteStore.notify(
        'Kontakter flettet',
        `Flettede ${removedIds.length + 1} kontakter sammen til "${savedPrimary.fullName}".`,
        'success'
      );
      return savedPrimary;
    } catch (err: any) {
      suiteStore.notify(
        'Kunne ikke flette kontakter',
        err?.message || 'Fejl ved fletning på CardDAV-serveren.',
        'error'
      );
      return null;
    } finally {
      isBulkUpdating.value = false;
    }
  }

  function hasContactWithEmail(email: string): boolean {
    return Boolean(findContactByEmail(email));
  }

  function searchContactsForAutocomplete(
    query: string,
    limit = 8
  ): Array<{ name: string; email: string; organization?: string }> {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const results: Array<{ name: string; email: string; organization?: string }> = [];
    const seenEmails = new Set<string>();

    const prioritized = [...contacts.value].sort(
      (a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred))
    );

    for (const c of prioritized) {
      for (const em of c.emails || []) {
        const addr = em.value.trim();
        if (!addr || seenEmails.has(addr.toLowerCase())) continue;

        const haystack = `${c.fullName} ${c.nickname || ''} ${c.organization || ''} ${addr}`.toLowerCase();
        if (haystack.includes(q)) {
          seenEmails.add(addr.toLowerCase());
          results.push({
            name: c.fullName,
            email: addr,
            organization: c.organization
          });
          if (results.length >= limit) return results;
        }
      }
    }

    return results;
  }

  function toggleContactCheckbox(contact: Contact, range = false): void {
    const list = filteredContacts.value;
    if (range && selectionAnchorId.value) {
      const aIdx = list.findIndex((c) => c.id === selectionAnchorId.value);
      const bIdx = list.findIndex((c) => c.id === contact.id);
      if (aIdx !== -1 && bIdx !== -1) {
        const start = Math.min(aIdx, bIdx);
        const end = Math.max(aIdx, bIdx);
        const rangeIds = list.slice(start, end + 1).map((c) => c.id);
        const merged = new Set([...selectedContactIds.value, ...rangeIds]);
        selectedContactIds.value = Array.from(merged);
        selectionFocusId.value = contact.id;
        selectedContactId.value = contact.id;
        return;
      }
    }

    if (selectedContactIds.value.includes(contact.id)) {
      selectedContactIds.value = selectedContactIds.value.filter((id) => id !== contact.id);
    } else {
      selectedContactIds.value = [...selectedContactIds.value, contact.id];
    }
    selectionAnchorId.value = contact.id;
    selectionFocusId.value = contact.id;
    selectedContactId.value = contact.id;
  }

  function selectContact(
    contact: Contact,
    options?: { toggle?: boolean; range?: boolean }
  ): void {
    const list = filteredContacts.value;

    if (options?.range) {
      const anchorId = selectionAnchorId.value || selectedContactId.value || contact.id;
      const aIdx = list.findIndex((c) => c.id === anchorId);
      const bIdx = list.findIndex((c) => c.id === contact.id);
      if (aIdx !== -1 && bIdx !== -1) {
        const start = Math.min(aIdx, bIdx);
        const end = Math.max(aIdx, bIdx);
        selectedContactIds.value = list.slice(start, end + 1).map((c) => c.id);
        selectionAnchorId.value = anchorId;
        selectionFocusId.value = contact.id;
        selectedContactId.value = contact.id;
        return;
      }
    }

    if (options?.toggle) {
      if (
        selectedContactIds.value.length === 0 &&
        selectedContactId.value &&
        selectedContactId.value !== contact.id
      ) {
        selectedContactIds.value = [selectedContactId.value, contact.id];
      } else if (selectedContactIds.value.includes(contact.id)) {
        selectedContactIds.value = selectedContactIds.value.filter((id) => id !== contact.id);
      } else {
        selectedContactIds.value = [...selectedContactIds.value, contact.id];
      }
      selectionAnchorId.value = contact.id;
      selectionFocusId.value = contact.id;
      selectedContactId.value = contact.id;
      return;
    }

    selectedContactIds.value = [];
    selectedContactId.value = contact.id;
    selectionAnchorId.value = contact.id;
    selectionFocusId.value = contact.id;
  }

  function selectAllInCurrentList(): void {
    const visibleIds = filteredContacts.value.map((c) => c.id);
    if (visibleIds.length === 0) return;

    const currentSet = new Set(selectedContactIds.value);
    const allVisibleSelected = visibleIds.every((id) => currentSet.has(id));
    if (allVisibleSelected) {
      const visibleSet = new Set(visibleIds);
      selectedContactIds.value = selectedContactIds.value.filter((id) => !visibleSet.has(id));
    } else {
      for (const id of visibleIds) {
        currentSet.add(id);
      }
      selectedContactIds.value = Array.from(currentSet);
      if (!selectionAnchorId.value) selectionAnchorId.value = visibleIds[0];
      if (!selectionFocusId.value) selectionFocusId.value = visibleIds[0];
      if (!selectedContactId.value) selectedContactId.value = visibleIds[0];
    }
  }

  function navigateSelection(delta: 1 | -1, extendSelection = false) {
    const list = filteredContacts.value;
    if (list.length === 0) return;

    const baseId = selectionFocusId.value || selectedContactId.value;
    const currentIdx = baseId ? list.findIndex((c) => c.id === baseId) : -1;
    const nextIdx =
      currentIdx === -1
        ? delta > 0
          ? 0
          : list.length - 1
        : Math.max(0, Math.min(list.length - 1, currentIdx + delta));
    const target = list[nextIdx];
    if (!target) return;

    if (extendSelection) {
      const anchorId = selectionAnchorId.value || selectedContactId.value || target.id;
      const anchorIdx = list.findIndex((c) => c.id === anchorId);
      if (anchorIdx !== -1) {
        const start = Math.min(anchorIdx, nextIdx);
        const end = Math.max(anchorIdx, nextIdx);
        selectedContactIds.value = list.slice(start, end + 1).map((c) => c.id);
        selectionAnchorId.value = anchorId;
      } else {
        selectedContactIds.value = [target.id];
        selectionAnchorId.value = target.id;
      }
      selectionFocusId.value = target.id;
      selectedContactId.value = target.id;
    } else {
      selectedContactIds.value = [];
      selectedContactId.value = target.id;
      selectionAnchorId.value = target.id;
      selectionFocusId.value = target.id;
    }
  }

  async function bulkModifyTags(
    addTags: string[],
    removeTags: string[],
    targetContacts?: Contact[]
  ): Promise<number> {
    const addList: string[] = [];
    const addSeen = new Set<string>();
    for (const raw of addTags) {
      const clean = raw.trim();
      const lower = clean.toLowerCase();
      if (!clean || addSeen.has(lower)) continue;
      addSeen.add(lower);
      addList.push(clean);
    }

    const removeSet = new Set(
      removeTags.map((t) => t.trim().toLowerCase()).filter(Boolean)
    );
    if (addList.length === 0 && removeSet.size === 0) return 0;

    const sourceList = targetContacts || selectedContacts.value;
    const targets = sourceList.filter((c) => !isAddressBookReadOnly(c.addressBookId));
    const skippedReadOnly = sourceList.length - targets.length;

    if (targets.length === 0) {
      suiteStore.notify(
        'Ingen skrivbare kontakter',
        'De valgte kontakter ligger i skrivebeskyttede adressebøger og kan ikke redigeres.',
        'warning'
      );
      return 0;
    }

    const changedContacts: Contact[] = [];
    for (const c of targets) {
      const existing = (c.categories || []).map((t) => t.trim()).filter(Boolean);
      const nextCats = existing.filter((t) => !removeSet.has(t.toLowerCase()));
      const existingLower = new Set(nextCats.map((t) => t.toLowerCase()));
      for (const tag of addList) {
        if (!existingLower.has(tag.toLowerCase())) {
          nextCats.push(tag);
          existingLower.add(tag.toLowerCase());
        }
      }

      const isChanged =
        nextCats.length !== existing.length ||
        nextCats.some((tag, i) => tag !== existing[i]);
      if (isChanged) {
        changedContacts.push(
          toPlainObject({
            ...c,
            categories: nextCats
          })
        );
      }
    }

    if (changedContacts.length === 0) {
      suiteStore.notify(
        'Ingen ændringer',
        'De valgte kontakter havde allerede de ønskede tags.',
        'info'
      );
      return 0;
    }

    isBulkUpdating.value = true;
    try {
      const res = await apiBulkUpdateContacts(changedContacts);
      const plainSaved = toPlainObject(res.contacts || []);
      for (const saved of plainSaved) {
        const idx = contacts.value.findIndex((c) => c.id === saved.id);
        if (idx !== -1) {
          contacts.value[idx] = saved;
        }
      }
      if (plainSaved.length > 0) {
        await db.contacts.bulkPut(plainSaved).catch(() => {});
        contactsMutationCounter.value += 1;
      }

      const notes: string[] = [];
      if (skippedReadOnly > 0) notes.push(`${skippedReadOnly} skrivebeskyttet(e) sprunget over`);
      if (res.failedCount > 0) notes.push(`${res.failedCount} fejlede`);
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';

      suiteStore.notify(
        'Tags opdateret',
        `Opdaterede tags på ${res.updatedCount} kontakt(er) i Mailcow${suffix}.`,
        res.failedCount > 0 && res.updatedCount === 0 ? 'error' : 'success'
      );
      return res.updatedCount;
    } catch (err: any) {
      suiteStore.notify(
        'Bulk-opdatering fejlede',
        err?.message || 'Kunne ikke opdatere tags på de valgte kontakter.',
        'error'
      );
      return 0;
    } finally {
      isBulkUpdating.value = false;
    }
  }

  async function bulkUpdateFields(
    patch: {
      organization?: string;
      clearOrganization?: boolean;
      title?: string;
      clearTitle?: boolean;
    },
    targetContacts?: Contact[]
  ): Promise<number> {
    const sourceList = targetContacts || selectedContacts.value;
    const targets = sourceList.filter((c) => !isAddressBookReadOnly(c.addressBookId));
    const skippedReadOnly = sourceList.length - targets.length;

    if (targets.length === 0) {
      suiteStore.notify(
        'Ingen skrivbare kontakter',
        'De valgte kontakter ligger i skrivebeskyttede adressebøger.',
        'warning'
      );
      return 0;
    }

    const changedContacts: Contact[] = [];
    for (const c of targets) {
      let nextOrg = c.organization || '';
      let nextTitle = c.title || '';
      if (patch.clearOrganization) {
        nextOrg = '';
      } else if (typeof patch.organization === 'string') {
        nextOrg = patch.organization.trim();
      }
      if (patch.clearTitle) {
        nextTitle = '';
      } else if (typeof patch.title === 'string') {
        nextTitle = patch.title.trim();
      }

      if (nextOrg === (c.organization || '') && nextTitle === (c.title || '')) {
        continue;
      }

      changedContacts.push(
        toPlainObject({
          ...c,
          organization: nextOrg,
          title: nextTitle
        })
      );
    }

    if (changedContacts.length === 0) {
      suiteStore.notify('Ingen ændringer', 'Alle valgte kontakter havde allerede denne værdi.', 'info');
      return 0;
    }

    isBulkUpdating.value = true;
    try {
      const res = await apiBulkUpdateContacts(changedContacts);
      const plainSaved = toPlainObject(res.contacts || []);
      for (const saved of plainSaved) {
        const idx = contacts.value.findIndex((c) => c.id === saved.id);
        if (idx !== -1) {
          contacts.value[idx] = saved;
        }
      }
      if (plainSaved.length > 0) {
        await db.contacts.bulkPut(plainSaved).catch(() => {});
        contactsMutationCounter.value += 1;
      }

      const notes: string[] = [];
      if (skippedReadOnly > 0) notes.push(`${skippedReadOnly} skrivebeskyttet(e) sprunget over`);
      if (res.failedCount > 0) notes.push(`${res.failedCount} fejlede`);
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';

      suiteStore.notify(
        'Kontakter opdateret',
        `Opdaterede ${res.updatedCount} kontakt(er) i Mailcow${suffix}.`,
        res.failedCount > 0 && res.updatedCount === 0 ? 'error' : 'success'
      );
      return res.updatedCount;
    } catch (err: any) {
      suiteStore.notify(
        'Bulk-opdatering fejlede',
        err?.message || 'Kunne ikke opdatere felterne på de valgte kontakter.',
        'error'
      );
      return 0;
    } finally {
      isBulkUpdating.value = false;
    }
  }

  async function bulkSetFavorite(
    starred: boolean,
    targetContacts?: Contact[]
  ): Promise<number> {
    const sourceList = targetContacts || selectedContacts.value;
    const toChange = sourceList.filter((c) => Boolean(c.starred) !== starred);
    if (toChange.length === 0) {
      suiteStore.notify(
        'Ingen ændringer',
        starred
          ? 'Alle valgte kontakter er allerede markeret som favoritter.'
          : 'Ingen af de valgte kontakter er markeret som favoritter.',
        'info'
      );
      return 0;
    }

    const payloadItems = toChange.map((c) => {
      const writable = !isAddressBookReadOnly(c.addressBookId);
      return {
        contactId: c.id,
        contact: writable ? toPlainObject({ ...c, starred }) : undefined
      };
    });

    isBulkUpdating.value = true;
    try {
      const res = await apiBulkSetFavorite(starred, payloadItems);
      const updatedMap = new Map<string, Contact>();
      for (const uc of res.contacts || []) {
        updatedMap.set(uc.id, toPlainObject({ ...uc, starred }));
      }

      const toPersist: Contact[] = [];
      for (const t of toChange) {
        const nextContact = updatedMap.get(t.id) || toPlainObject({ ...t, starred });
        const idx = contacts.value.findIndex((c) => c.id === t.id);
        if (idx !== -1) {
          contacts.value[idx] = nextContact;
        }
        toPersist.push(nextContact);
      }
      if (toPersist.length > 0) {
        await db.contacts.bulkPut(toPersist).catch(() => {});
      }

      suiteStore.notify(
        starred ? 'Tilføjet til favoritter' : 'Fjernet fra favoritter',
        `${toChange.length} kontakt(er) blev opdateret.`,
        'success'
      );
      return res.updatedCount;
    } catch (err: any) {
      suiteStore.notify(
        'Favorit-opdatering fejlede',
        err?.message || 'Kunne ikke opdatere favorit-status.',
        'error'
      );
      return 0;
    } finally {
      isBulkUpdating.value = false;
    }
  }

  async function bulkDeleteContacts(targetContacts?: Contact[]): Promise<number> {
    const sourceList = targetContacts || selectedContacts.value;
    const targets = sourceList.filter((c) => !isAddressBookReadOnly(c.addressBookId));
    if (targets.length === 0) {
      suiteStore.notify(
        'Ingen skrivbare kontakter',
        'Ingen af de valgte kontakter kan slettes.',
        'warning'
      );
      return 0;
    }

    isBulkUpdating.value = true;
    try {
      const res = await apiBulkDeleteContacts(
        targets.map((c) => ({
          id: c.id,
          vcardUrl: c.vcardUrl,
          etag: c.etag
        }))
      );
      const removedSet = new Set(
        res.deletedIds.length > 0
          ? res.deletedIds
          : res.failedCount === 0
            ? targets.map((c) => c.id)
            : []
      );
      const removedIds = Array.from(removedSet);

      if (removedIds.length > 0) {
        contacts.value = contacts.value.filter((c) => !removedSet.has(c.id));
        selectedContactIds.value = selectedContactIds.value.filter((id) => !removedSet.has(id));
        await db.contacts.bulkDelete(removedIds).catch(() => {});
        if (selectedContactId.value && removedSet.has(selectedContactId.value)) {
          selectedContactId.value = filteredContacts.value[0]?.id || null;
        }
        contactsMutationCounter.value += 1;
      }

      const note = res.failedCount > 0 ? ` (${res.failedCount} fejlede)` : '';
      suiteStore.notify(
        'Kontakter slettet',
        `${res.deletedCount} kontakt(er) blev slettet fra adressebogen${note}.`,
        res.failedCount > 0 && res.deletedCount === 0 ? 'error' : 'info'
      );
      return res.deletedCount;
    } catch (err: any) {
      suiteStore.notify(
        'Kunne ikke slette kontakter',
        err?.message || 'CardDAV fejl ved bulk-sletning.',
        'error'
      );
      return 0;
    } finally {
      isBulkUpdating.value = false;
    }
  }

  function resetState() {
    syncError.value = '';
    addressBooks.value = [];
    contacts.value = [];
    selectedAddressBookId.value = 'ALL';
    selectedCategory.value = 'ALL';
    searchQuery.value = '';
    selectedContactId.value = null;
    selectedContactIds.value = [];
    selectionAnchorId.value = null;
    selectionFocusId.value = null;
    isBulkUpdating.value = false;
    senderContext.value = null;
    editingContact.value = null;
    isContactModalOpen.value = false;
  }

  return {
    addressBooks,
    contacts,
    isSyncing,
    isSaving,
    lastSyncedAt,
    contactsMutationCounter,
    selectedAddressBookId,
    selectedCategory,
    searchQuery,
    selectedContactId,
    selectedContactIds,
    selectionAnchorId,
    selectionFocusId,
    isBulkUpdating,
    selectedContacts,
    writableSelectedContacts,
    readOnlySelectedCount,
    isContactSelected,
    clearSelection,
    toggleContactCheckbox,
    selectContact,
    selectAllInCurrentList,
    navigateSelection,
    bulkModifyTags,
    bulkUpdateFields,
    bulkSetFavorite,
    bulkDeleteContacts,
    editingContact,
    isContactModalOpen,
    senderContext,
    writableAddressBooks,
    defaultWritableAddressBook,
    allCategories,
    contactsWithBirthdaysCount,
    contactsWithAnniversariesCount,
    contactsWithSpecialDatesCount,
    contactCalendarColor,
    favoritesCount,
    filteredContacts,
    selectedContact,
    getAddressBookById,
    isAddressBookReadOnly,
    hydrateSession,
    syncWithServer,
    syncError,
    openCreateContactModal,
    openEditContactModal,
    openMergeSenderIntoContact,
    saveContact,
    toggleFavorite,
    updateContactPhotoQuick,
    setContactCalendarColor,
    deleteContact,
    importVcfFile,
    exportContactsVcf,
    findContactByEmail,
    findBestWritableNameMatch,
    findMatchingWritableContacts,
    mergeContacts,
    hasContactWithEmail,
    searchContactsForAutocomplete,
    resetState
  };
});
