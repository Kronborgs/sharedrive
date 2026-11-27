<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  Search,
  RefreshCw,
  Wifi,
  WifiOff,
  Plus,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Upload,
  Copy,
  Download
} from 'lucide-vue-next';
import { useContactsStore } from '../../stores/contactsStore';
import { useSuiteStore } from '../../stores/suiteStore';
import { useTheme } from '../../composables/useTheme';
import ThemePicker from '../shared/ThemePicker.vue';
import SuiteModuleSwitcher from '../shared/SuiteModuleSwitcher.vue';
import SuiteTopActions from '../shared/SuiteTopActions.vue';

const props = defineProps<{
  sidebarCollapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void;
}>();

const store = useContactsStore();
const suiteStore = useSuiteStore();
const { currentTheme } = useTheme();
const isImporting = ref(false);
const selectedBook = computed(() => store.addressBooks.find(book => book.id === store.selectedAddressBookId));
const directorySelection = computed(() => {
  const book = selectedBook.value;
  if (!book?.isDirectory) return [];
  const contacts = store.selectedContacts.length ? store.selectedContacts : store.contacts.filter(contact => contact.id === store.selectedContactId);
  return contacts.filter(contact => contact.addressBookId === book.id);
});

async function handleVcfUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || isImporting.value) return;

  const current = selectedBook.value;
  const targetBook = current && !current.readOnly && current.canCreate !== false ? current : store.defaultWritableAddressBook;
  if (!targetBook) {
    suiteStore.notify(
      'Ingen skrivbar adressebog',
      'Kan ikke importere, da der ikke findes en skrivbar adressebog.',
      'warning'
    );
    return;
  }

  isImporting.value = true;
  try {
    const imported = await store.importVcfFile(targetBook.id, await file.text());
    if (imported) store.selectedAddressBookId = targetBook.id;
  } catch (err: any) {
    suiteStore.notify(
      'Import fejlede',
      err?.message || 'Kunne ikke læse .vcf-filen.',
      'error'
    );
  } finally {
    isImporting.value = false;
  }
}

async function copyFromDirectory() {
  const target = store.defaultWritableAddressBook;
  if (!target || !directorySelection.value.length || isImporting.value) return;
  isImporting.value = true;
  try {
    const imported = await store.copyDirectoryContacts(target.id, directorySelection.value);
    if (imported) store.selectedAddressBookId = target.id;
  } catch (error) {
    suiteStore.notify('Kunne ikke kopiere kontakter', error instanceof Error ? error.message : undefined, 'error');
  } finally {
    isImporting.value = false;
  }
}
</script>

<template>
  <header
    class="px-3 sm:px-4 flex items-center justify-between gap-3 select-none relative z-30 transition-all duration-300"
    :class="
      currentTheme.wallpaper
        ? 'mx-2.5 mt-2.5 h-14 rounded-2xl border backdrop-blur-xl shadow-lg'
        : 'h-16 bg-slate-900/95 border-b border-slate-800'
    "
    :style="
      currentTheme.wallpaper
        ? { backgroundColor: currentTheme.surface, borderColor: currentTheme.border }
        : undefined
    "
  >
    <!-- Venstre: Sidebar Toggle, Suite Modulskifter & Kontakt-antal -->
    <div class="flex items-center gap-2.5 shrink-0">
      <button
        type="button"
        class="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
        :title="props.sidebarCollapsed ? 'Vis sidepanel' : 'Skjul sidepanel'"
        @click="emit('toggle-sidebar')"
      >
        <PanelLeftOpen v-if="props.sidebarCollapsed" class="w-4 h-4 text-blue-400" />
        <PanelLeftClose v-else class="w-4 h-4" />
      </button>

      <SuiteModuleSwitcher />

      <span class="hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/25 border border-white/10 text-[11px] text-slate-300 shrink-0">
        {{ store.contacts.length }} kontakter
      </span>
    </div>

    <!-- Midt: Øjeblikkelig Lokal Kontaktsøgning -->
    <div class="relative flex-1 max-w-md min-w-0">
      <div class="relative flex items-center">
        <Search class="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
        <input
          v-model="store.searchQuery"
          type="text"
          placeholder="Søg i kontakter (navn, e-mail, telefon, firma, gruppe)..."
          class="w-full pl-9 pr-8 py-1.5 text-sm rounded-xl text-slate-100 focus:outline-none transition"
          :class="
            currentTheme.wallpaper
              ? 'bg-black/30 border border-white/15 placeholder-slate-300/60 focus:border-white/35 focus:ring-1 focus:ring-white/25'
              : 'bg-slate-950/90 border border-slate-800 placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
          "
        />
        <button
          v-if="store.searchQuery"
          type="button"
          class="absolute right-2.5 text-slate-400 hover:text-slate-200"
          @click="store.searchQuery = ''"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    <!-- Højre: vCard Import/Eksport, Tema, Sync & Ny kontakt -->
    <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
      <label
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium cursor-pointer focus-within:ring-2 focus-within:ring-blue-400 transition"
        title="Importér kontakter fra .vcf (vCard) fil"
      >
        <Upload class="w-3.5 h-3.5 text-emerald-400" />
        <span class="hidden md:inline">Importér .vcf</span>
        <input
          type="file"
          accept=".vcf,.vcard,text/vcard"
          class="sr-only"
          aria-label="Importér kontakter (.vcf)"
          :disabled="isImporting"
          @change="handleVcfUpload"
        />
      </label>

      <button
        v-if="directorySelection.length && store.defaultWritableAddressBook"
        type="button"
        :disabled="isImporting"
        :title="`Kopiér til ${store.defaultWritableAddressBook.name}`"
        aria-label="Kopiér valgte GAL-kontakter"
        class="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
        @click="copyFromDirectory"
      >
        <Copy class="w-3.5 h-3.5" />
        <span class="hidden md:inline">Kopiér GAL-kontakter</span>
      </button>

      <button
        type="button"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
        aria-label="Eksportér kontakter (.vcf)"
        :title="
          store.selectedContactIds.length > 0
            ? `Eksportér ${store.selectedContactIds.length} valgte kontakt(er) som .vcf`
            : 'Eksportér viste kontakter som .vcf (vCard)'
        "
        @click="
          store.selectedContactIds.length > 0
            ? store.exportContactsVcf(store.selectedContacts)
            : store.exportContactsVcf()
        "
      >
        <Download class="w-3.5 h-3.5 text-blue-400" />
        <span class="hidden md:inline">
          {{ store.selectedContactIds.length > 0 ? `Eksportér (${store.selectedContactIds.length})` : 'Eksportér' }}
        </span>
      </button>

      <ThemePicker variant="topbar" />

      <button
        type="button"
        class="p-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition flex items-center gap-1.5 text-xs"
        :title="suiteStore.isOnline ? 'Synkronisér adressebøger fra Mailcow CardDAV' : 'Offline — Viser cachede kontakter'"
        aria-label="Synkronisér kontakter fra SOGo"
        @click="store.syncWithServer(false)"
      >
        <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin text-blue-400': store.isSyncing }" />
        <Wifi v-if="suiteStore.isOnline" class="w-3.5 h-3.5 text-emerald-400" />
        <WifiOff v-else class="w-3.5 h-3.5 text-amber-400" />
      </button>

      <button
        type="button"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg dav-theme-btn text-xs font-semibold shadow-sm transition"
        @click="store.openCreateContactModal()"
      >
        <Plus class="w-4 h-4" />
        <span class="hidden sm:inline">Ny kontakt</span>
      </button>

      <SuiteTopActions />
    </div>
  </header>
</template>
