<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import {
  Users,
  Star,
  Camera,
  Mail,
  Phone,
  Building2,
  Cake,
  Heart,
  MapPin,
  Globe,
  FileText,
  Tag,
  Pencil,
  Trash2,
  Lock,
  ExternalLink,
  BookUser,
  Plus,
  CheckSquare,
  Square,
  X,
  Download,
  RefreshCw,
  ChevronLeft,
  Smartphone
} from 'lucide-vue-next';
import ContactsTopBar from './ContactsTopBar.vue';
import { useContactsStore } from '../../stores/contactsStore';
import { useSuiteStore } from '../../stores/suiteStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';
import { processContactPhotoFile } from '../../utils/contactPhoto';
import { resolveContactAvatarSrc, markGravatarFailed, gravatarEnabled, setGravatarEnabled } from '../../utils/gravatar';
import type { Contact } from '../../types/contacts';

const SIDEBAR_WIDTH_KEY = 'brogaard_contacts_sidebar_width_v1';
const LIST_WIDTH_KEY = 'brogaard_contacts_list_width_v1';
const SIDEBAR_COLLAPSED_KEY = 'brogaard_contacts_sidebar_collapsed_v1';

const store = useContactsStore();
const suiteStore = useSuiteStore();
const { currentTheme } = useTheme();
const { isMobile, isStandalonePwa, displayModeLabel } = useViewport();

const mobileDrawerOpen = ref(false);
const mobilePane = ref<'list' | 'detail'>('list');

const sidebarCollapsed = ref<boolean>(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');
const sidebarWidth = ref<number>(
  Math.min(360, Math.max(180, Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || 240))
);
const listWidth = ref<number>(
  Math.min(520, Math.max(260, Number(localStorage.getItem(LIST_WIDTH_KEY)) || 340))
);
const isResizing = ref(false);
const listScrollRef = ref<HTMLElement | null>(null);

const bulkTagInput = ref('');
const stagedTagsToAdd = ref<string[]>([]);
const bulkOrgInput = ref('');
const mergePrimaryId = ref('');

const allVisibleSelected = computed<boolean>(
  () =>
    store.filteredContacts.length > 0 &&
    store.filteredContacts.every((c) => store.isContactSelected(c.id))
);

const selectedEmailRecipients = computed<Array<{ email: string; name?: string }>>(() => {
  const list: Array<{ email: string; name?: string }> = [];
  for (const c of store.selectedContacts) {
    const primary = (c.emails || []).find((e) => e.value?.trim());
    if (primary) {
      list.push({ email: primary.value.trim(), name: c.fullName });
    }
  }
  return list;
});

const selectedContactsTagSummary = computed<Array<{ name: string; count: number }>>(() => {
  const counts = new Map<string, { name: string; count: number }>();
  for (const c of store.writableSelectedContacts) {
    const seenInContact = new Set<string>();
    for (const rawCat of c.categories || []) {
      const clean = rawCat.trim();
      const lower = clean.toLowerCase();
      if (!clean || seenInContact.has(lower)) continue;
      seenInContact.add(lower);
      const existing = counts.get(lower);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(lower, { name: clean, count: 1 });
      }
    }
  }
  return Array.from(counts.values()).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'da-DK')
  );
});

const parsedTagsToAdd = computed<string[]>(() => {
  const result: string[] = [];
  const seen = new Set<string>();
  const pushTag = (raw: string) => {
    const clean = raw.trim();
    const lower = clean.toLowerCase();
    if (!clean || seen.has(lower)) return;
    seen.add(lower);
    result.push(clean);
  };
  for (const tag of stagedTagsToAdd.value) pushTag(tag);
  for (const part of bulkTagInput.value.split(',')) pushTag(part);
  return result;
});

watch(
  () => store.selectionFocusId || store.selectedContactId,
  async (contactId) => {
    if (!contactId || !listScrollRef.value) return;
    await nextTick();
    const rows = listScrollRef.value.querySelectorAll<HTMLElement>('[data-contact-row-id]');
    for (const row of rows) {
      if (row.dataset.contactRowId === contactId) {
        row.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }
);

watch(
  () => store.selectedContactIds.length,
  (len) => {
    if (len === 0) {
      bulkTagInput.value = '';
      stagedTagsToAdd.value = [];
      bulkOrgInput.value = '';
      mergePrimaryId.value = '';
    }
  }
);

watch(
  () => store.writableSelectedContacts,
  (list) => {
    if (list.length === 0) {
      mergePrimaryId.value = '';
      return;
    }
    if (!list.some((c) => c.id === mergePrimaryId.value)) {
      const preferred =
        list.find((c) => Boolean(c.photoDataUrl)) ||
        list
          .slice()
          .sort(
            (a, b) =>
              b.emails.length + b.phones.length - (a.emails.length + a.phones.length)
          )[0] ||
        list[0];
      mergePrimaryId.value = preferred.id;
    }
  },
  { immediate: true }
);

function toggleSidebar() {
  if (isMobile.value) {
    mobileDrawerOpen.value = !mobileDrawerOpen.value;
    return;
  }
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed.value));
}

function selectBookFilter(bookId: string) {
  store.selectedAddressBookId = bookId;
  if (isMobile.value) {
    mobileDrawerOpen.value = false;
    mobilePane.value = 'list';
  }
}

function selectTagFilter(catName: string) {
  store.selectedCategory = store.selectedCategory === catName ? 'ALL' : catName;
  if (isMobile.value) {
    mobileDrawerOpen.value = false;
    mobilePane.value = 'list';
  }
}

function startResizeSidebar(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startX = e.clientX;
  const startWidth = sidebarWidth.value;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientX - startX;
    sidebarWidth.value = Math.min(360, Math.max(180, startWidth + delta));
  };

  const onMouseUp = () => {
    isResizing.value = false;
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value));
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function resetSidebarWidth() {
  sidebarWidth.value = 240;
  localStorage.setItem(SIDEBAR_WIDTH_KEY, '240');
}

function startResizeList(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startX = e.clientX;
  const startWidth = listWidth.value;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientX - startX;
    listWidth.value = Math.min(520, Math.max(260, startWidth + delta));
  };

  const onMouseUp = () => {
    isResizing.value = false;
    localStorage.setItem(LIST_WIDTH_KEY, String(listWidth.value));
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function resetListWidth() {
  listWidth.value = 340;
  localStorage.setItem(LIST_WIDTH_KEY, '340');
}

const AVATAR_PALETTE = [
  '#2563eb',
  '#059669',
  '#7c3aed',
  '#db2777',
  '#d97706',
  '#0891b2',
  '#4f46e5',
  '#e11d48'
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function getInitials(contact: Contact): string {
  const parts = contact.fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return (contact.fullName.trim().slice(0, 2) || '?').toUpperCase();
}

function formatBirthdayLabel(bday: string): string {
  const match = bday.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return bday;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(year, month - 1, day);
  const formatted = dt.toLocaleDateString('da-DK', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  const now = new Date();
  let age = now.getFullYear() - year;
  if (
    now.getMonth() + 1 < month ||
    (now.getMonth() + 1 === month && now.getDate() < day)
  ) {
    age--;
  }
  return year >= 1900 && age >= 0 && age <= 130 ? `${formatted} (${age} år)` : formatted;
}

function formatAddressString(contact: Contact): string {
  if (!contact.address) return '';
  const hasCoreAddress = Boolean(
    contact.address.street?.trim() ||
    contact.address.postalCode?.trim() ||
    contact.address.city?.trim()
  );
  if (!hasCoreAddress) return '';
  return [
    contact.address.street,
    [contact.address.postalCode, contact.address.city].filter(Boolean).join(' '),
    contact.address.country
  ]
    .filter(Boolean)
    .join(', ');
}

function getMapsUrl(contact: Contact): string {
  const q = formatAddressString(contact);
  return q ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}` : '';
}

function getSafeWebsite(url?: string): string {
  if (!url) return '';
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : '';
}

function emailTypeLabel(type: string): string {
  if (type === 'work') return 'Arbejde';
  if (type === 'home') return 'Privat';
  return 'Anden';
}

function phoneTypeLabel(type: string): string {
  if (type === 'mobile') return 'Mobil';
  if (type === 'work') return 'Arbejde';
  if (type === 'home') return 'Privat';
  return 'Anden';
}

function confirmDelete(contact: Contact) {
  const ok = window.confirm(
    `Er du sikker på, at du vil slette kontakten "${contact.fullName}" fra Mailcow?`
  );
  if (ok) {
    void store.deleteContact(contact);
  }
}

function handleContactRowClick(contact: Contact, e: MouseEvent) {
  if (e.shiftKey) {
    store.selectContact(contact, { range: true });
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    store.selectContact(contact, { toggle: true });
    return;
  }
  store.selectContact(contact);
  if (isMobile.value) {
    mobilePane.value = 'detail';
  }
}

function isStagedTag(tagName: string): boolean {
  const lower = tagName.trim().toLowerCase();
  return stagedTagsToAdd.value.some((t) => t.trim().toLowerCase() === lower);
}

function toggleStagedTag(tagName: string) {
  const clean = tagName.trim();
  const lower = clean.toLowerCase();
  if (!clean) return;
  if (isStagedTag(clean)) {
    stagedTagsToAdd.value = stagedTagsToAdd.value.filter(
      (t) => t.trim().toLowerCase() !== lower
    );
  } else {
    stagedTagsToAdd.value = [...stagedTagsToAdd.value, clean];
  }
}

async function handleBulkAddTags() {
  if (store.isBulkUpdating || parsedTagsToAdd.value.length === 0) return;
  await store.bulkModifyTags(parsedTagsToAdd.value, []);
  bulkTagInput.value = '';
  stagedTagsToAdd.value = [];
}

async function handleBulkRemoveTag(tagName: string) {
  if (store.isBulkUpdating) return;
  await store.bulkModifyTags([], [tagName]);
}

async function handleBulkSetOrganization(clear = false) {
  if (store.isBulkUpdating) return;
  if (clear) {
    await store.bulkUpdateFields({ clearOrganization: true });
    bulkOrgInput.value = '';
    return;
  }
  const cleanOrg = bulkOrgInput.value.trim();
  if (!cleanOrg) return;
  const updated = await store.bulkUpdateFields({ organization: cleanOrg });
  if (updated > 0) {
    bulkOrgInput.value = '';
  }
}

function handleBulkSendEmail(field: 'bcc' | 'to' = 'bcc') {
  suiteStore.composeMailToMany(selectedEmailRecipients.value, field);
}

function confirmBulkDelete() {
  const writableCount = store.writableSelectedContacts.length;
  if (writableCount === 0) return;
  const readOnlyNote =
    store.readOnlySelectedCount > 0
      ? `\n\n(${store.readOnlySelectedCount} skrivebeskyttet(e) kontakt(er) springes over.)`
      : '';
  const ok = window.confirm(
    `Er du sikker på, at du vil slette ${writableCount} valgt(e) kontakt(er) fra Mailcow?${readOnlyNote}`
  );
  if (ok) {
    void store.bulkDeleteContacts();
  }
}

async function confirmMergeSelected() {
  const list = store.writableSelectedContacts;
  if (list.length < 2) return;
  const primary = list.find((c) => c.id === mergePrimaryId.value) || list[0];
  const secondaries = list.filter((c) => c.id !== primary.id);
  const ok = window.confirm(
    `Flet ${list.length} valgte kontakter sammen til "${primary.fullName}"?\n\nAlle e-mailadresser, telefonnumre, tags, noter og evt. manglende profilbillede samles på hovedkontakten, og de ${secondaries.length} øvrige dublet(ter) slettes.`
  );
  if (ok) {
    await store.mergeContacts(primary, secondaries);
  }
}

function countContactsInBook(bookId: string): number {
  return store.contacts.filter((c) => c.addressBookId === bookId).length;
}

async function handleQuickPhotoChange(e: Event, contact: Contact) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  try {
    const dataUrl = await processContactPhotoFile(file);
    await store.updateContactPhotoQuick(contact, dataUrl);
  } catch (err: any) {
    suiteStore.notify(
      'Kunne ikke indlæse billede',
      err?.message || 'Vælg venligst et gyldigt billede.',
      'error'
    );
  }
}
</script>

<template>
  <div
    class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden"
    :class="{ 'select-none': isResizing }"
  >
    <ContactsTopBar
      :sidebar-collapsed="isMobile ? !mobileDrawerOpen : sidebarCollapsed"
      @toggle-sidebar="toggleSidebar"
    />
    <p v-if="store.syncError" role="alert" class="mx-2.5 mt-2 rounded-lg border border-amber-500/30 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
      {{ store.syncError }}
    </p>

    <!-- Backdrop for mobil slide-over skuffe -->
    <div
      v-if="isMobile && mobileDrawerOpen"
      class="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm"
      @click="mobileDrawerOpen = false"
    ></div>

    <div
      class="flex-1 flex min-h-0 overflow-hidden relative"
      :class="[
        currentTheme.wallpaper ? 'px-2 sm:px-2.5 pb-2 sm:pb-2.5 pt-2' : '',
        isMobile && mobileDrawerOpen ? 'z-50' : 'z-10'
      ]"
    >
      <!-- Venstre sidepanel: Adressebøger & Grupper (Desktop fast / Mobil slide-over skuffe) -->
      <template v-if="isMobile ? mobileDrawerOpen : !sidebarCollapsed">
        <aside
          class="flex flex-col justify-between p-3 select-none overflow-y-auto shrink-0 transition-all duration-300"
          :class="[
            isMobile
              ? 'fixed left-2 top-2 bottom-2 z-50 rounded-2xl border backdrop-blur-xl shadow-2xl'
              : 'h-full',
            !isMobile &&
              (currentTheme.wallpaper
                ? 'rounded-2xl border backdrop-blur-xl shadow-lg'
                : 'bg-slate-900/90 border-r border-slate-800'),
            isMobile && !currentTheme.wallpaper ? 'bg-slate-900/95 border-slate-700' : ''
          ]"
          :style="{
            width: isMobile ? 'min(285px, 85vw)' : `${sidebarWidth}px`,
            ...(currentTheme.wallpaper
              ? { backgroundColor: currentTheme.surface, borderColor: currentTheme.border }
              : {})
          }"
        >
          <div class="space-y-5">
            <!-- Adressebøger -->
            <div class="space-y-1.5">
              <div class="flex items-center justify-between px-1">
                <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Adressebøger
                </span>
                <div class="flex items-center gap-1.5">
                  <span class="text-[10px] text-slate-500">
                    {{ store.addressBooks.length }}
                  </span>
                  <button
                    v-if="isMobile"
                    type="button"
                    class="p-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
                    title="Luk sidepanel"
                    @click="mobileDrawerOpen = false"
                  >
                    <X class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <button
                type="button"
                class="w-full px-2.5 py-2 rounded-xl flex items-center justify-between gap-2 text-xs transition"
                :class="
                  store.selectedAddressBookId === 'ALL'
                    ? 'dav-theme-btn font-semibold shadow-sm'
                    : 'text-slate-200 hover:bg-white/10'
                "
                @click="selectBookFilter('ALL')"
              >
                <span class="flex items-center gap-2 truncate">
                  <Users class="w-3.5 h-3.5 shrink-0" />
                  <span class="truncate">Alle kontakter</span>
                </span>
                <span class="text-[10.5px] opacity-80 shrink-0">{{ store.contacts.length }}</span>
              </button>

              <!-- Separat Favoritter-knap (Starred) -->
              <button
                type="button"
                class="w-full px-2.5 py-2 rounded-xl flex items-center justify-between gap-2 text-xs transition"
                :class="
                  store.selectedAddressBookId === 'FAVORITES'
                    ? 'dav-theme-btn font-semibold shadow-sm'
                    : 'text-slate-200 hover:bg-white/10'
                "
                @click="
                  selectBookFilter(
                    store.selectedAddressBookId === 'FAVORITES' ? 'ALL' : 'FAVORITES'
                  )
                "
              >
                <span class="flex items-center gap-2 truncate">
                  <Star
                    class="w-3.5 h-3.5 shrink-0"
                    :class="
                      store.selectedAddressBookId === 'FAVORITES'
                        ? 'fill-current text-amber-200'
                        : 'fill-amber-400 text-amber-400'
                    "
                  />
                  <span class="truncate">Favoritter</span>
                </span>
                <span class="text-[10.5px] opacity-80 shrink-0">{{ store.favoritesCount }}</span>
              </button>

              <button
                v-for="book in store.addressBooks"
                :key="book.id"
                type="button"
                class="w-full px-2.5 py-2 rounded-xl flex items-center justify-between gap-2 text-xs transition"
                :class="
                  store.selectedAddressBookId === book.id
                    ? 'dav-theme-btn font-semibold shadow-sm'
                    : 'text-slate-200 hover:bg-white/10'
                "
                @click="selectBookFilter(book.id)"
              >
                <span class="flex items-center gap-2 min-w-0">
                  <BookUser class="w-3.5 h-3.5 shrink-0" />
                  <span class="truncate">{{ book.name }}</span>
                  <Lock v-if="book.readOnly" class="w-3 h-3 text-amber-300 shrink-0" title="Skrivebeskyttet" />
                </span>
                <span class="text-[10.5px] opacity-80 shrink-0">{{ countContactsInBook(book.id) }}</span>
              </button>
            </div>

            <!-- Grupper / Kategorier -->
            <div v-if="store.allCategories.length > 0" class="space-y-1.5">
              <div class="flex items-center justify-between px-1">
                <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Grupper &amp; Tags
                </span>
                <button
                  v-if="store.selectedCategory !== 'ALL'"
                  type="button"
                  class="text-[10px] text-blue-400 hover:underline"
                  @click="store.selectedCategory = 'ALL'; if (isMobile) mobileDrawerOpen = false"
                >
                  Nulstil
                </button>
              </div>

              <div class="flex flex-wrap gap-1.5 px-1">
                <button
                  v-for="cat in store.allCategories"
                  :key="cat.name"
                  type="button"
                  class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border transition"
                  :class="
                    store.selectedCategory === cat.name
                      ? 'dav-theme-btn border-transparent font-semibold'
                      : 'bg-slate-800/70 border-slate-700/70 text-slate-300 hover:bg-slate-800'
                  "
                  @click="selectTagFilter(cat.name)"
                >
                  <Tag class="w-3 h-3" />
                  <span>{{ cat.name }}</span>
                  <span class="opacity-70 text-[10px]">({{ cat.count }})</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Bund: Fødselsdage & Mærkedage-status + visningstilstand -->
          <div class="pt-3 border-t border-white/10 space-y-2">
            <label class="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" :checked="gravatarEnabled()"
                @change="setGravatarEnabled(($event.target as HTMLInputElement).checked)" />
              Vis profilbilleder fra Gravatar
            </label>
            <div
              v-if="store.contactsWithSpecialDatesCount > 0"
              class="p-2.5 rounded-xl bg-pink-500/10 border border-pink-500/25 text-[11px] text-pink-200 flex items-start gap-2"
            >
              <Cake class="w-4 h-4 text-pink-400 shrink-0 mt-0.5" />
              <span>
                <strong>{{ store.contactsWithSpecialDatesCount }}</strong> kontakt(er) med fødselsdag/mærkedag vises automatisk i din kalender.
              </span>
            </div>

            <div
              v-if="isMobile"
              class="px-2.5 py-1.5 rounded-xl bg-black/25 border border-white/10 flex items-center justify-between text-[11px] text-slate-400"
            >
              <span class="flex items-center gap-1.5">
                <Smartphone class="w-3.5 h-3.5 text-blue-400" />
                <span>Visningstilstand</span>
              </span>
              <span
                class="font-semibold"
                :class="isStandalonePwa ? 'text-emerald-300' : 'text-slate-200'"
              >
                {{ displayModeLabel }}
              </span>
            </div>
          </div>
        </aside>

        <div
          v-if="!isMobile"
          class="cursor-col-resize transition-colors shrink-0 relative"
          :class="currentTheme.wallpaper ? 'w-2 bg-transparent hover:bg-white/15 active:bg-white/25 rounded-full my-2' : 'w-1.5 bg-slate-800/80 hover:bg-blue-500 active:bg-blue-400'"
          title="Træk for at tilpasse sidepanelets bredde (dobbeltklik for standardbredde)"
          @mousedown="startResizeSidebar"
          @dblclick="resetSidebarWidth"
        >
          <div class="absolute inset-y-0 -left-1 -right-1"></div>
        </div>
      </template>

      <!-- Midterste kolonne: Kontaktliste (A-Å) -->
      <section
        v-if="!isMobile || mobilePane === 'list'"
        class="flex flex-col min-h-0 overflow-hidden transition-all duration-300"
        :class="[
          isMobile ? 'w-full flex-1' : 'shrink-0',
          currentTheme.wallpaper
            ? 'rounded-2xl border backdrop-blur-lg shadow-xl'
            : 'bg-slate-900/60 border-r border-slate-800'
        ]"
        :style="{
          ...(!isMobile ? { width: `${listWidth}px` } : {}),
          ...(currentTheme.wallpaper
            ? { backgroundColor: currentTheme.gridBg, borderColor: currentTheme.border }
            : {})
        }"
      >
        <div
          class="h-11 px-3.5 border-b flex items-center justify-between gap-2 text-xs shrink-0"
          :class="currentTheme.wallpaper ? 'bg-black/25 border-white/10' : 'bg-slate-900/80 border-slate-800'"
        >
          <div class="flex items-center gap-2 min-w-0">
            <button
              v-if="store.filteredContacts.length > 0"
              type="button"
              class="p-0.5 rounded transition shrink-0"
              :class="allVisibleSelected ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'"
              :title="allVisibleSelected ? 'Fravælg alle viste' : 'Markér alle viste (Ctrl+A)'"
              @click="store.selectAllInCurrentList()"
            >
              <CheckSquare v-if="allVisibleSelected" class="w-4 h-4" />
              <Square v-else class="w-4 h-4" />
            </button>
            <span class="font-semibold text-slate-200 truncate">
              {{ store.selectedAddressBookId === 'FAVORITES' ? 'Favoritter' : 'Kontakter' }} ({{ store.filteredContacts.length }})
            </span>
            <span
              v-if="store.selectedContactIds.length > 0"
              class="px-1.5 py-0.5 rounded-full bg-blue-500/20 border border-blue-400/35 text-blue-300 text-[10.5px] font-semibold shrink-0"
            >
              {{ store.selectedContactIds.length }} valgt
            </span>
            <button
              v-if="store.selectedContactIds.length > 0"
              type="button"
              class="text-[10.5px] text-slate-400 hover:text-white underline shrink-0"
              title="Ryd markering (Esc)"
              @click="store.clearSelection()"
            >
              Ryd
            </button>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <span v-if="store.selectedCategory !== 'ALL'" class="text-[11px] text-blue-400 truncate max-w-[110px]">
              Tag: {{ store.selectedCategory }}
            </span>
            <button
              type="button"
              class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border transition"
              :class="
                store.selectedAddressBookId === 'FAVORITES'
                  ? 'bg-amber-500/20 border-amber-400/45 text-amber-200'
                  : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white'
              "
              :title="
                store.selectedAddressBookId === 'FAVORITES'
                  ? 'Vis alle kontakter'
                  : 'Vis kun favorit-kontakter'
              "
              @click="
                store.selectedAddressBookId =
                  store.selectedAddressBookId === 'FAVORITES' ? 'ALL' : 'FAVORITES'
              "
            >
              <Star
                class="w-3 h-3"
                :class="
                  store.selectedAddressBookId === 'FAVORITES' || store.favoritesCount > 0
                    ? 'fill-amber-400 text-amber-400'
                    : 'text-slate-400'
                "
              />
              <span>Favoritter</span>
            </button>
          </div>
        </div>

        <!-- Mobil Bulk-handlingsbjælke når kontakter er afkrydset -->
        <div
          v-if="isMobile && store.selectedContactIds.length > 0"
          class="px-3.5 py-2 border-b border-blue-400/25 bg-blue-500/15 flex items-center justify-between gap-2 text-xs shrink-0"
        >
          <span class="font-semibold text-blue-200">
            {{ store.selectedContactIds.length }} kontakt(er) markeret
          </span>
          <button
            type="button"
            class="px-3 py-1 rounded-lg dav-theme-btn text-xs font-semibold shadow-sm"
            @click="mobilePane = 'detail'"
          >
            Bulk-redigér →
          </button>
        </div>

        <div v-if="store.filteredContacts.length === 0" class="flex-1 flex flex-col items-center justify-center p-6 text-center text-xs text-slate-400 space-y-3">
          <Star v-if="store.selectedAddressBookId === 'FAVORITES'" class="w-8 h-8 text-amber-400/60" />
          <Users v-else class="w-8 h-8 text-slate-600" />
          <p v-if="store.searchQuery">Ingen kontakter matcher "{{ store.searchQuery }}".</p>
          <p v-else-if="store.selectedAddressBookId === 'FAVORITES'">
            Du har ingen favoritter endnu. Klik på stjernen ud for en kontakt for at føje den til Favoritter.
          </p>
          <p v-else>Ingen kontakter fundet i denne adressebog.</p>
          <button
            v-if="store.selectedAddressBookId !== 'FAVORITES'"
            type="button"
            class="px-3 py-1.5 rounded-lg dav-theme-btn text-xs font-semibold flex items-center gap-1.5"
            @click="store.openCreateContactModal()"
          >
            <Plus class="w-3.5 h-3.5" /> Opret ny kontakt
          </button>
        </div>

        <div v-else ref="listScrollRef" class="flex-1 overflow-y-auto divide-y divide-white/5">
          <div
            v-for="contact in store.filteredContacts"
            :key="contact.id"
            :data-contact-row-id="contact.id"
            role="button"
            tabindex="0"
            class="group w-full px-3 py-2.5 text-left flex items-center gap-2.5 transition cursor-pointer focus:outline-none select-none"
            :class="
              store.isContactSelected(contact.id)
                ? 'bg-blue-500/20 border-l-2 border-l-blue-400'
                : store.selectedContactId === contact.id
                  ? 'bg-blue-600/15 border-l-2 border-l-blue-500/70'
                  : 'hover:bg-white/5 border-l-2 border-l-transparent'
            "
            @click="handleContactRowClick(contact, $event)"
            @keydown.enter.prevent="store.selectContact(contact)"
          >
            <button
              type="button"
              class="p-0.5 rounded transition shrink-0"
              :class="
                store.isContactSelected(contact.id)
                  ? 'text-blue-400 opacity-100'
                  : store.selectedContactIds.length > 0
                    ? 'text-slate-500 opacity-100 hover:text-slate-200'
                    : 'text-slate-500 opacity-35 group-hover:opacity-100 focus:opacity-100 hover:text-slate-200'
              "
              :title="store.isContactSelected(contact.id) ? 'Fravælg kontakt' : 'Markér kontakt (Shift+Klik for område)'"
              @click.stop="store.toggleContactCheckbox(contact, $event.shiftKey)"
            >
              <CheckSquare v-if="store.isContactSelected(contact.id)" class="w-4 h-4" />
              <Square v-else class="w-4 h-4" />
            </button>

            <div
              class="w-9 h-9 rounded-full shrink-0 flex items-center justify-center text-xs font-bold text-white overflow-hidden shadow-sm border border-white/15"
              :style="!resolveContactAvatarSrc(contact, 80) ? { backgroundColor: getAvatarColor(contact.fullName) } : undefined"
            >
              <img
                v-if="resolveContactAvatarSrc(contact, 80)"
                :src="resolveContactAvatarSrc(contact, 80) || undefined"
                :alt="contact.fullName"
                referrerpolicy="no-referrer"
                loading="lazy"
                class="w-full h-full object-cover"
                @error="markGravatarFailed(resolveContactAvatarSrc(contact, 80))"
              />
              <span v-else>{{ getInitials(contact) }}</span>
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold text-slate-100 truncate">
                  {{ contact.fullName }}
                </span>
                <div class="flex items-center gap-1.5 shrink-0">
                  <Cake
                    v-if="contact.birthday"
                    class="w-3 h-3 text-pink-400 shrink-0"
                    :title="`Fødselsdag: ${contact.birthday}`"
                  />
                  <Heart
                    v-if="contact.anniversary"
                    class="w-3 h-3 text-rose-400 shrink-0"
                    :title="`${contact.anniversaryLabel || 'Bryllupsdag'}: ${contact.anniversary}`"
                  />
                  <button
                    type="button"
                    class="p-0.5 rounded-md transition"
                    :class="
                      contact.starred
                        ? 'text-amber-400 opacity-100'
                        : 'text-slate-500 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-amber-300'
                    "
                    :title="contact.starred ? 'Fjern fra favoritter' : 'Markér som favorit'"
                    :aria-label="contact.starred ? 'Fjern fra favoritter' : 'Markér som favorit'"
                    @click.stop="store.toggleFavorite(contact)"
                  >
                    <Star
                      class="w-3.5 h-3.5"
                      :class="contact.starred ? 'fill-amber-400 text-amber-400' : ''"
                    />
                  </button>
                </div>
              </div>
              <div class="text-[11px] text-slate-400 truncate">
                {{
                  contact.organization ||
                  contact.emails[0]?.value ||
                  contact.phones[0]?.value ||
                  'Ingen detaljer'
                }}
              </div>
              <div v-if="contact.categories.length > 0" class="flex items-center gap-1 mt-1 overflow-hidden">
                <span
                  v-for="cat in contact.categories.slice(0, 2)"
                  :key="cat"
                  class="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-blue-500/15 border border-blue-500/25 text-blue-300 text-[9.5px] truncate max-w-[90px]"
                >
                  {{ cat }}
                </span>
                <span
                  v-if="contact.categories.length > 2"
                  class="text-[9.5px] text-slate-400 shrink-0"
                >
                  +{{ contact.categories.length - 2 }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div
        v-if="!isMobile"
        class="cursor-col-resize transition-colors shrink-0 relative"
        :class="currentTheme.wallpaper ? 'w-2 bg-transparent hover:bg-white/15 active:bg-white/25 rounded-full my-2' : 'w-1.5 bg-slate-800/80 hover:bg-blue-500 active:bg-blue-400'"
        title="Træk for at tilpasse kontaktlistens bredde (dobbeltklik for standardbredde)"
        @mousedown="startResizeList"
        @dblclick="resetListWidth"
      >
        <div class="absolute inset-y-0 -left-1 -right-1"></div>
      </div>

      <!-- Højre kolonne: Kontaktkort -->
      <main
        v-if="!isMobile || mobilePane === 'detail'"
        class="flex-1 flex flex-col min-w-0 h-full overflow-y-auto transition-all duration-300"
        :class="
          currentTheme.wallpaper
            ? 'rounded-2xl border backdrop-blur-lg shadow-xl'
            : 'bg-slate-950'
        "
        :style="
          currentTheme.wallpaper
            ? { backgroundColor: currentTheme.gridBg, borderColor: currentTheme.border }
            : undefined
        "
      >
        <div
          v-if="isMobile"
          class="h-11 px-3 border-b flex items-center justify-between gap-2 shrink-0 sticky top-0 z-20 backdrop-blur-md"
          :class="currentTheme.wallpaper ? 'bg-black/35 border-white/10' : 'bg-slate-900/90 border-slate-800'"
        >
          <button
            type="button"
            class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 text-xs font-semibold transition"
            @click="mobilePane = 'list'"
          >
            <ChevronLeft class="w-4 h-4" />
            <span>Tilbage til kontakter</span>
          </button>
          <span
            v-if="store.selectedContactIds.length > 0"
            class="text-[11px] font-semibold text-blue-300"
          >
            {{ store.selectedContactIds.length }} valgt
          </span>
        </div>

        <!-- Bulk-redigering når kontakter er afkrydset -->
        <div v-if="store.selectedContactIds.length > 0" class="p-6 max-w-2xl w-full mx-auto space-y-5">
          <div class="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-white/10">
            <div class="flex items-center gap-3">
              <div class="w-11 h-11 rounded-2xl bg-blue-500/20 border border-blue-400/35 flex items-center justify-center text-blue-300 shrink-0">
                <Users class="w-5 h-5" />
              </div>
              <div>
                <div class="flex items-center gap-2 flex-wrap">
                  <h2 class="text-lg font-bold text-slate-100">Bulk-redigering</h2>
                  <span class="px-2 py-0.5 rounded-full bg-blue-500/20 border border-blue-400/35 text-blue-300 text-xs font-semibold">
                    {{ store.selectedContacts.length }} valgt
                  </span>
                </div>
                <p class="text-xs text-slate-400 mt-0.5">
                  Redigér tags, firma, favoritter eller eksportér flere kontakter på én gang.
                </p>
              </div>
            </div>

            <div class="flex items-center gap-2 flex-wrap">
              <button
                v-if="!allVisibleSelected && store.filteredContacts.length > 0"
                type="button"
                class="px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition"
                @click="store.selectAllInCurrentList()"
              >
                Markér alle ({{ store.filteredContacts.length }})
              </button>
              <button
                v-if="store.selectedContacts.length === 1"
                type="button"
                class="px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition"
                @click="store.clearSelection()"
              >
                Vis kontaktkort
              </button>
              <button
                type="button"
                class="px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white text-xs font-medium flex items-center gap-1 transition"
                title="Ryd markering (Esc)"
                @click="store.clearSelection()"
              >
                <X class="w-3.5 h-3.5" />
                <span>Ryd markering</span>
              </button>
            </div>
          </div>

          <div
            v-if="store.readOnlySelectedCount > 0"
            class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-center gap-2"
          >
            <Lock class="w-4 h-4 text-amber-300 shrink-0" />
            <span>
              <strong>{{ store.readOnlySelectedCount }}</strong> af de valgte kontakter ligger i en skrivebeskyttet adressebog. Tags, firma og sletning anvendes kun på de {{ store.writableSelectedContacts.length }} skrivbare kontakter.
            </span>
          </div>

          <!-- Valgte kontakter preview-chips -->
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="c in store.selectedContacts.slice(0, 24)"
              :key="c.id"
              class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800/90 border border-white/10 text-[11px] text-slate-200"
            >
              <span class="truncate max-w-[160px]">{{ c.fullName }}</span>
              <Lock
                v-if="store.isAddressBookReadOnly(c.addressBookId)"
                class="w-2.5 h-2.5 text-amber-300 shrink-0"
                title="Skrivebeskyttet"
              />
              <button
                type="button"
                class="text-slate-400 hover:text-white"
                title="Fjern fra markering"
                @click="store.toggleContactCheckbox(c)"
              >
                <X class="w-3 h-3" />
              </button>
            </span>
            <span
              v-if="store.selectedContacts.length > 24"
              class="inline-flex items-center px-2.5 py-1 rounded-full bg-slate-900 border border-white/10 text-[11px] text-slate-400"
            >
              +{{ store.selectedContacts.length - 24 }} flere
            </span>
          </div>

          <!-- Sektion 1: Tilføj & fjern tags / grupper -->
          <div class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-3.5 text-xs">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Tag class="w-3.5 h-3.5 text-blue-400" /> Tilføj &amp; fjern tags / grupper
            </div>

            <div class="flex flex-wrap sm:flex-nowrap items-center gap-2">
              <input
                v-model="bulkTagInput"
                type="text"
                placeholder="Skriv ét eller flere tags (kommasepareret, f.eks. Familie, Julekort)..."
                class="flex-1 min-w-[200px] px-3 py-2 rounded-xl bg-slate-950/90 border border-slate-700/80 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                @keydown.enter.prevent="handleBulkAddTags"
              />
              <button
                type="button"
                class="px-3.5 py-2 rounded-xl dav-theme-btn text-xs font-semibold flex items-center gap-1.5 shadow transition disabled:opacity-45 disabled:cursor-not-allowed shrink-0"
                :disabled="
                  store.isBulkUpdating ||
                  parsedTagsToAdd.length === 0 ||
                  store.writableSelectedContacts.length === 0
                "
                @click="handleBulkAddTags"
              >
                <RefreshCw v-if="store.isBulkUpdating" class="w-3.5 h-3.5 animate-spin" />
                <Plus v-else class="w-3.5 h-3.5" />
                <span>
                  Tilføj {{ parsedTagsToAdd.length > 1 ? `${parsedTagsToAdd.length} tags` : 'tag' }} til {{ store.writableSelectedContacts.length }}
                </span>
              </button>
            </div>

            <!-- Hurtigvalg af eksisterende tags -->
            <div v-if="store.allCategories.length > 0" class="space-y-1.5">
              <div class="text-[11px] text-slate-400">
                Vælg blandt eksisterende tags (klik for at tilvælge):
              </div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="cat in store.allCategories"
                  :key="cat.name"
                  type="button"
                  class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] border transition"
                  :class="
                    isStagedTag(cat.name)
                      ? 'bg-blue-500/25 border-blue-400/60 text-blue-200 font-semibold'
                      : 'bg-slate-800/70 border-slate-700/70 text-slate-300 hover:bg-slate-800'
                  "
                  @click="toggleStagedTag(cat.name)"
                >
                  <Plus v-if="!isStagedTag(cat.name)" class="w-3 h-3 opacity-70" />
                  <CheckSquare v-else class="w-3 h-3 text-blue-300" />
                  <span>{{ cat.name }}</span>
                </button>
              </div>
            </div>

            <!-- Aktive tags på valgte kontakter (fjern med ét klik) -->
            <div v-if="selectedContactsTagSummary.length > 0" class="pt-3 border-t border-white/10 space-y-1.5">
              <div class="text-[11px] text-slate-400">
                Tags på de valgte kontakter (klik × for at fjerne fra alle):
              </div>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="tag in selectedContactsTagSummary"
                  :key="tag.name"
                  class="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-200 text-[11px]"
                >
                  <Tag class="w-3 h-3 text-blue-400" />
                  <span>{{ tag.name }}</span>
                  <span class="text-[10px] text-blue-300/75">
                    ({{ tag.count }}/{{ store.writableSelectedContacts.length }})
                  </span>
                  <button
                    type="button"
                    class="p-0.5 rounded-full hover:bg-rose-500/30 text-blue-300 hover:text-rose-200 transition disabled:opacity-40"
                    :disabled="store.isBulkUpdating"
                    :title="`Fjern '${tag.name}' fra alle valgte`"
                    @click="handleBulkRemoveTag(tag.name)"
                  >
                    <X class="w-3 h-3" />
                  </button>
                </span>
              </div>
            </div>
          </div>

          <!-- Sektion 2: Firma / Organisation -->
          <div class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-3 text-xs">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Building2 class="w-3.5 h-3.5 text-emerald-400" /> Sæt firma / organisation (valgfrit)
            </div>
            <div class="flex flex-wrap sm:flex-nowrap items-center gap-2">
              <input
                v-model="bulkOrgInput"
                type="text"
                placeholder="F.eks. Jensen ApS"
                class="flex-1 min-w-[180px] px-3 py-2 rounded-xl bg-slate-950/90 border border-slate-700/80 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                @keydown.enter.prevent="handleBulkSetOrganization(false)"
              />
              <button
                type="button"
                class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition disabled:opacity-45 shrink-0"
                :disabled="
                  store.isBulkUpdating ||
                  !bulkOrgInput.trim() ||
                  store.writableSelectedContacts.length === 0
                "
                @click="handleBulkSetOrganization(false)"
              >
                Opdater firma
              </button>
              <button
                type="button"
                class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-rose-500/20 border border-slate-700 hover:border-rose-500/40 text-slate-300 hover:text-rose-200 text-xs font-medium transition disabled:opacity-45 shrink-0"
                :disabled="store.isBulkUpdating || store.writableSelectedContacts.length === 0"
                @click="handleBulkSetOrganization(true)"
              >
                Ryd firma
              </button>
            </div>
          </div>

          <!-- Flet duplikater (Merge kontakter) -->
          <div
            v-if="store.writableSelectedContacts.length >= 2"
            class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-3 text-xs"
          >
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Users class="w-3.5 h-3.5 text-blue-400" /> Flet dubletter (Merge kontakter)
            </div>
            <p class="text-[11px] text-slate-400 leading-relaxed">
              Samler alle e-mailadresser, telefonnumre, tags, noter og profilbillede på én valgt hovedkontakt og sletter de overskydende dubletter.
            </p>
            <div class="flex flex-wrap sm:flex-nowrap items-center gap-2">
              <select
                v-model="mergePrimaryId"
                class="flex-1 min-w-[180px] px-3 py-2 rounded-xl bg-slate-950/90 border border-slate-700/80 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option
                  v-for="c in store.writableSelectedContacts"
                  :key="c.id"
                  :value="c.id"
                >
                  Hovedkontakt: {{ c.fullName }}{{ c.emails[0]?.value ? ` (${c.emails[0].value})` : c.phones[0]?.value ? ` (${c.phones[0].value})` : '' }}
                </option>
              </select>
              <button
                type="button"
                class="px-3.5 py-2 rounded-xl dav-theme-btn text-xs font-semibold flex items-center gap-1.5 shadow transition disabled:opacity-45 shrink-0"
                :disabled="store.isBulkUpdating"
                @click="confirmMergeSelected"
              >
                <Users class="w-3.5 h-3.5" />
                <span>Flet {{ store.writableSelectedContacts.length }} kontakter til én</span>
              </button>
            </div>
          </div>

          <!-- Sektion 3: Hurtighandlinger -->
          <div class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-3 text-xs">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Hurtighandlinger
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-amber-500/20 border border-slate-700 hover:border-amber-400/40 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition disabled:opacity-45"
                :disabled="store.isBulkUpdating"
                @click="store.bulkSetFavorite(true)"
              >
                <Star class="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                <span>Tilføj til favoritter</span>
              </button>
              <button
                type="button"
                class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition disabled:opacity-45"
                :disabled="store.isBulkUpdating"
                @click="store.bulkSetFavorite(false)"
              >
                <Star class="w-3.5 h-3.5 text-slate-400" />
                <span>Fjern fra favoritter</span>
              </button>
              <button
                v-if="suiteStore.isAnyModuleEnabled('mail') && selectedEmailRecipients.length > 0"
                type="button"
                class="px-3 py-2 rounded-xl dav-theme-btn text-xs font-semibold flex items-center gap-1.5 shadow transition"
                @click="handleBulkSendEmail('bcc')"
              >
                <Mail class="w-3.5 h-3.5" />
                <span>Send e-mail (BCC til {{ selectedEmailRecipients.length }})</span>
              </button>
              <button
                type="button"
                class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition"
                @click="store.exportContactsVcf(store.selectedContacts)"
              >
                <Download class="w-3.5 h-3.5 text-blue-400" />
                <span>Eksportér valgte (.vcf)</span>
              </button>
              <button
                type="button"
                class="px-3 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-200 text-xs font-semibold flex items-center gap-1.5 transition disabled:opacity-45"
                :disabled="store.isBulkUpdating || store.writableSelectedContacts.length === 0"
                @click="confirmBulkDelete"
              >
                <Trash2 class="w-3.5 h-3.5" />
                <span>Slet valgte ({{ store.writableSelectedContacts.length }})</span>
              </button>
            </div>
          </div>
        </div>

        <div
          v-else-if="!store.selectedContact"
          class="flex-1 flex flex-col items-center justify-center p-8 text-center select-none"
        >
          <div class="w-14 h-14 rounded-2xl bg-slate-900/80 border border-white/10 flex items-center justify-center text-slate-500 mb-3">
            <BookUser class="w-7 h-7" />
          </div>
          <h3 class="text-sm font-bold text-slate-200">Vælg en kontakt for at se detaljer</h3>
          <p class="text-xs text-slate-400 mt-1 max-w-sm">
            Alle ændringer synkroniseres automatisk med din Mailcow CardDAV-adressebog og dine mobile enheder.
          </p>
        </div>

        <div v-else class="p-6 max-w-2xl w-full mx-auto space-y-6">
          <!-- Top Profilkort -->
          <div class="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-white/10">
            <div class="flex items-center gap-4 min-w-0">
              <label
                v-if="!store.isAddressBookReadOnly(store.selectedContact.addressBookId)"
                class="group relative w-16 h-16 rounded-2xl shrink-0 flex items-center justify-center text-xl font-bold text-white overflow-hidden shadow-lg border border-white/20 cursor-pointer"
                :style="!resolveContactAvatarSrc(store.selectedContact, 160) ? { backgroundColor: getAvatarColor(store.selectedContact.fullName) } : undefined"
                title="Klik for at uploade eller skifte kontaktbillede"
              >
                <img
                  v-if="resolveContactAvatarSrc(store.selectedContact, 160)"
                  :src="resolveContactAvatarSrc(store.selectedContact, 160) || undefined"
                  :alt="store.selectedContact.fullName"
                  referrerpolicy="no-referrer"
                  class="w-full h-full object-cover"
                  @error="markGravatarFailed(resolveContactAvatarSrc(store.selectedContact, 160))"
                />
                <span v-else>{{ getInitials(store.selectedContact) }}</span>
                <span
                  class="absolute inset-0 bg-black/55 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
                >
                  <Camera class="w-5 h-5 text-white drop-shadow" />
                </span>
                <input
                  type="file"
                  accept="image/*"
                  class="hidden"
                  @change="handleQuickPhotoChange($event, store.selectedContact)"
                />
              </label>
              <div
                v-else
                class="w-16 h-16 rounded-2xl shrink-0 flex items-center justify-center text-xl font-bold text-white overflow-hidden shadow-lg border border-white/20"
                :style="!resolveContactAvatarSrc(store.selectedContact, 160) ? { backgroundColor: getAvatarColor(store.selectedContact.fullName) } : undefined"
              >
                <img
                  v-if="resolveContactAvatarSrc(store.selectedContact, 160)"
                  :src="resolveContactAvatarSrc(store.selectedContact, 160) || undefined"
                  :alt="store.selectedContact.fullName"
                  referrerpolicy="no-referrer"
                  class="w-full h-full object-cover"
                  @error="markGravatarFailed(resolveContactAvatarSrc(store.selectedContact, 160))"
                />
                <span v-else>{{ getInitials(store.selectedContact) }}</span>
              </div>

              <div class="min-w-0 space-y-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <h2 class="text-xl font-bold text-slate-100 truncate">
                    {{ store.selectedContact.fullName }}
                  </h2>
                  <span
                    v-if="store.selectedContact.nickname"
                    class="text-xs text-slate-400"
                  >
                    "{{ store.selectedContact.nickname }}"
                  </span>
                </div>
                <p
                  v-if="store.selectedContact.title || store.selectedContact.organization"
                  class="text-xs text-slate-300 flex items-center gap-1.5"
                >
                  <Building2 class="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span>
                    {{ [store.selectedContact.title, store.selectedContact.organization].filter(Boolean).join(' • ') }}
                  </span>
                </p>
                <div v-if="store.selectedContact.categories.length > 0" class="flex flex-wrap gap-1.5 pt-1">
                  <span
                    v-for="cat in store.selectedContact.categories"
                    :key="cat"
                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-500/30 text-blue-300 text-[10.5px] font-medium"
                  >
                    <Tag class="w-2.5 h-2.5" /> {{ cat }}
                  </span>
                </div>
              </div>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                class="px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition"
                :class="
                  store.selectedContact.starred
                    ? 'bg-amber-500/20 border-amber-400/50 text-amber-200 hover:bg-amber-500/30'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
                "
                :title="
                  store.selectedContact.starred ? 'Fjern fra favoritter' : 'Tilføj til favoritter'
                "
                @click="store.toggleFavorite(store.selectedContact)"
              >
                <Star
                  class="w-3.5 h-3.5"
                  :class="
                    store.selectedContact.starred
                      ? 'fill-amber-400 text-amber-400'
                      : 'text-amber-300'
                  "
                />
                <span>{{ store.selectedContact.starred ? 'Favorit' : 'Favorit' }}</span>
              </button>

              <button
                v-if="suiteStore.isAnyModuleEnabled('mail') && store.selectedContact.emails.length > 0"
                type="button"
                class="px-3 py-1.5 rounded-xl dav-theme-btn text-xs font-semibold flex items-center gap-1.5 shadow transition"
                @click="suiteStore.composeMailTo(store.selectedContact.emails[0].value, store.selectedContact.fullName)"
              >
                <Mail class="w-3.5 h-3.5" />
                <span>Send e-mail</span>
              </button>

              <template v-if="!store.isAddressBookReadOnly(store.selectedContact.addressBookId)">
                <button
                  type="button"
                  class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition"
                  @click="store.openEditContactModal(store.selectedContact)"
                >
                  <Pencil class="w-3.5 h-3.5 text-blue-400" />
                  <span>Redigér</span>
                </button>
                <button
                  type="button"
                  class="p-2 rounded-xl bg-slate-800 hover:bg-rose-500/20 border border-slate-700 hover:border-rose-500/40 text-slate-300 hover:text-rose-300 transition"
                  title="Slet kontakt"
                  @click="confirmDelete(store.selectedContact)"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </template>
              <span
                v-else
                class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[11px] font-semibold"
              >
                <Lock class="w-3 h-3" /> Skrivebeskyttet
              </span>
            </div>
          </div>

          <!-- Detaljekort -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <!-- E-mailadresser -->
            <div class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-2.5">
              <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Mail class="w-3.5 h-3.5 text-blue-400" /> E-mailadresser
              </div>
              <div v-if="store.selectedContact.emails.length === 0" class="text-slate-500">
                Ingen e-mail registreret
              </div>
              <div
                v-for="(em, i) in store.selectedContact.emails"
                :key="i"
                class="flex items-center justify-between gap-2"
              >
                <button
                  v-if="suiteStore.isAnyModuleEnabled('mail')"
                  type="button"
                  class="text-blue-400 hover:text-blue-300 hover:underline font-medium truncate text-left"
                  title="Klik for at sende e-mail"
                  @click="suiteStore.composeMailTo(em.value, store.selectedContact?.fullName)"
                >
                  {{ em.value }}
                </button>
                <span v-else class="text-slate-200 truncate">{{ em.value }}</span>
                <span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px] shrink-0">
                  {{ emailTypeLabel(em.type) }}
                </span>
              </div>
            </div>

            <!-- Telefonnumre -->
            <div class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-2.5">
              <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Phone class="w-3.5 h-3.5 text-emerald-400" /> Telefonnumre
              </div>
              <div v-if="store.selectedContact.phones.length === 0" class="text-slate-500">
                Intet telefonnummer registreret
              </div>
              <div
                v-for="(ph, i) in store.selectedContact.phones"
                :key="i"
                class="flex items-center justify-between gap-2"
              >
                <a
                  :href="`tel:${ph.value}`"
                  class="text-emerald-300 hover:text-emerald-200 hover:underline font-medium truncate"
                >
                  {{ ph.value }}
                </a>
                <span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px] shrink-0">
                  {{ phoneTypeLabel(ph.type) }}
                </span>
              </div>
            </div>

            <!-- Fødselsdag -->
            <div
              v-if="store.selectedContact.birthday"
              class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-1.5"
            >
              <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Cake class="w-3.5 h-3.5 text-pink-400" /> Fødselsdag
              </div>
              <div class="text-slate-100 font-medium">
                {{ formatBirthdayLabel(store.selectedContact.birthday) }}
              </div>
            </div>

            <!-- Bryllupsdag / Mærkedag -->
            <div
              v-if="store.selectedContact.anniversary"
              class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-1.5"
            >
              <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Heart class="w-3.5 h-3.5 text-rose-400" />
                <span>{{ store.selectedContact.anniversaryLabel || 'Bryllupsdag' }}</span>
              </div>
              <div class="text-slate-100 font-medium">
                {{ formatBirthdayLabel(store.selectedContact.anniversary) }}
              </div>
            </div>

            <!-- Adresse -->
            <div
              v-if="formatAddressString(store.selectedContact)"
              class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-1.5"
            >
              <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center justify-between">
                <span class="flex items-center gap-1.5">
                  <MapPin class="w-3.5 h-3.5 text-rose-400" /> Adresse
                </span>
                <a
                  :href="getMapsUrl(store.selectedContact)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-[10.5px] text-blue-400 hover:underline inline-flex items-center gap-1"
                >
                  Kort <ExternalLink class="w-3 h-3" />
                </a>
              </div>
              <div class="text-slate-200 leading-relaxed">
                {{ formatAddressString(store.selectedContact) }}
              </div>
            </div>

            <!-- Hjemmeside -->
            <div
              v-if="getSafeWebsite(store.selectedContact.website)"
              class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-1.5 sm:col-span-2"
            >
              <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Globe class="w-3.5 h-3.5 text-sky-400" /> Hjemmeside
              </div>
              <a
                :href="getSafeWebsite(store.selectedContact.website)"
                target="_blank"
                rel="noopener noreferrer"
                class="text-sky-400 hover:underline inline-flex items-center gap-1 break-all"
              >
                <span>{{ getSafeWebsite(store.selectedContact.website) }}</span>
                <ExternalLink class="w-3 h-3 shrink-0" />
              </a>
            </div>
          </div>

          <!-- Noter -->
          <div
            v-if="store.selectedContact.notes"
            class="p-4 rounded-2xl bg-black/25 border border-white/10 space-y-2 text-xs"
          >
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <FileText class="w-3.5 h-3.5 text-amber-400" /> Noter
            </div>
            <p class="text-slate-200 whitespace-pre-wrap leading-relaxed">
              {{ store.selectedContact.notes }}
            </p>
          </div>
        </div>
      </main>
    </div>
  </div>
</template>
