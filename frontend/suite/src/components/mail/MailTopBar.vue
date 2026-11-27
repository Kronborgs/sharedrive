<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  Search,
  Undo2,
  RefreshCw,
  Wifi,
  WifiOff,
  Plus,
  X,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Keyboard,
  AtSign,
  Star,
  Paperclip,
  Filter,
  Columns,
  Rows,
  Clock,
  Check
} from 'lucide-vue-next';
import { useMailStore, type AutoRefreshMinutes } from '../../stores/mailStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';
import ThemePicker from '../shared/ThemePicker.vue';
import SuiteModuleSwitcher from '../shared/SuiteModuleSwitcher.vue';
import SuiteTopActions from '../shared/SuiteTopActions.vue';
import type { MailHeader } from '../../types/mail';

const props = defineProps<{
  sidebarCollapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void;
}>();

const store = useMailStore();
const { currentTheme } = useTheme();
const { isMobile } = useViewport();
const isSearchFocused = ref(false);
const isHelpOpen = ref(false);
const isSyncMenuOpen = ref(false);

const refreshOptions: Array<{ label: string; value: AutoRefreshMinutes }> = [
  { label: 'Hvert 1. minut', value: 1 },
  { label: 'Hvert 2. minut (Standard)', value: 2 },
  { label: 'Hvert 5. minut', value: 5 },
  { label: 'Hvert 10. minut', value: 10 },
  { label: 'Kun manuelt', value: 0 }
];

const showSearchDropdown = computed(
  () => isSearchFocused.value && store.searchQuery.trim().length > 0
);

function selectSearchResult(msg: MailHeader) {
  void store.openMessage(msg, false);
  isSearchFocused.value = false;
}

function handleSearchBlur() {
  window.setTimeout(() => {
    isSearchFocused.value = false;
  }, 180);
}

function formatSender(msg: MailHeader): string {
  const first = msg.from[0];
  if (!first) return 'Ukendt afsender';
  return first.name || first.address;
}

function formatShortDate(iso: string): string {
  const dt = new Date(iso);
  return dt.toLocaleString('da-DK', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function toggleLayout() {
  store.setLayoutMode(
    store.layoutMode === 'THREE_COL' ? 'ROUNDCUBE_SPLIT' : 'THREE_COL'
  );
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
    <!-- Venstre: Sidebar Toggle, Suite Modulskifter & Hurtige Filtre -->
    <div class="flex items-center gap-2.5 shrink-0">
      <button
        type="button"
        class="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
        :title="props.sidebarCollapsed ? 'Vis sidepanel' : 'Skjul sidepanel (mere plads til e-mails)'"
        @click="emit('toggle-sidebar')"
      >
        <PanelLeftOpen v-if="props.sidebarCollapsed" class="w-4 h-4 text-blue-400" />
        <PanelLeftClose v-else class="w-4 h-4" />
      </button>

      <SuiteModuleSwitcher />

      <div class="h-6 w-px bg-slate-800 hidden xl:block"></div>

      <!-- Hurtige filtre: Alle / Ulæste / Stjerner / Vedhæftninger -->
      <div
        class="hidden xl:flex items-center p-0.5 rounded-lg border text-xs transition"
        :class="currentTheme.wallpaper ? 'bg-black/30 border-white/15' : 'bg-slate-950 border-slate-800'"
      >
        <button
          type="button"
          class="px-2.5 py-1 rounded-md font-medium transition"
          :class="store.filterMode === 'ALL' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="store.filterMode = 'ALL'"
        >
          Alle
        </button>
        <button
          type="button"
          class="px-2.5 py-1 rounded-md font-medium transition"
          :class="store.filterMode === 'UNREAD' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="store.filterMode = 'UNREAD'"
        >
          Ulæste
        </button>
        <button
          type="button"
          class="px-2 py-1 rounded-md font-medium transition flex items-center gap-1"
          :class="store.filterMode === 'FLAGGED' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          title="Stjernemarkerede"
          @click="store.filterMode = 'FLAGGED'"
        >
          <Star class="w-3 h-3" />
          <span class="hidden 2xl:inline">Stjerner</span>
        </button>
        <button
          type="button"
          class="px-2 py-1 rounded-md font-medium transition flex items-center gap-1"
          :class="store.filterMode === 'ATTACHMENTS' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          title="Kun e-mails med vedhæftede filer"
          @click="store.filterMode = 'ATTACHMENTS'"
        >
          <Paperclip class="w-3 h-3" />
        </button>
      </div>
    </div>

    <!-- Midt: Øjeblikkelig Global Søgning i ALLE mapper -->
    <div class="relative flex-1 max-w-sm xl:max-w-md min-w-0">
      <form class="relative flex items-center" @submit.prevent="store.runServerSearch(false)">
        <Search class="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
        <input
          v-model="store.searchQuery"
          type="text"
          placeholder="Søg i alle mapper inkl. Papirkurv (emne, afsender, tekst)..."
          class="w-full pl-9 pr-8 py-1.5 text-sm rounded-xl text-slate-100 focus:outline-none transition"
          :class="
            currentTheme.wallpaper
              ? 'bg-black/30 border border-white/15 placeholder-slate-300/60 focus:border-white/35 focus:ring-1 focus:ring-white/25'
              : 'bg-slate-950/90 border border-slate-800 placeholder-slate-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
          "
          @focus="isSearchFocused = true"
          @blur="handleSearchBlur"
        />
        <button
          v-if="store.searchQuery"
          type="button"
          class="absolute right-2.5 text-slate-400 hover:text-slate-200"
          @click="store.searchQuery = ''"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </form>

      <div
        v-if="showSearchDropdown"
        class="absolute left-0 right-0 mt-1.5 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl max-h-80 overflow-y-auto z-50 divide-y divide-slate-800/80"
      >
        <div
          v-if="store.searchResults.length === 0"
          class="p-4 text-xs text-slate-400 text-center space-y-2"
        >
          <div v-if="store.isSyncing">Søger i alle mapper på IMAP-serveren...</div>
          <div v-else>Ingen e-mails matcher "{{ store.searchQuery }}"</div>
        </div>
        <button
          v-for="msg in store.searchResults"
          :key="msg.id"
          type="button"
          class="w-full text-left px-3.5 py-2.5 hover:bg-slate-800/90 flex items-center justify-between gap-3 transition"
          @mousedown.prevent="selectSearchResult(msg)"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <span
              class="w-2 h-2 rounded-full shrink-0"
              :class="msg.seen ? 'bg-slate-600' : 'bg-blue-500'"
            ></span>
            <div class="truncate">
              <div class="text-xs font-medium text-slate-100 truncate">{{ msg.subject }}</div>
              <div class="text-[11px] text-slate-400 truncate flex items-center gap-1.5">
                <span class="px-1.5 py-0.2 rounded bg-slate-800 border border-slate-700 text-blue-300 text-[10px] font-semibold">
                  {{ store.getFolderDisplayName(msg.folder) }}
                </span>
                <span class="truncate">{{ formatSender(msg) }}</span>
              </div>
            </div>
          </div>
          <span class="text-[11px] text-slate-400 whitespace-nowrap shrink-0">
            {{ formatShortDate(msg.date) }}
          </span>
        </button>
      </div>
    </div>

    <!-- Højre: Layout-skifter, Sieve-Filtre, Aliaser, Undo, Tema, Hjælp, Sync, Ny e-mail & Konto -->
    <div class="flex items-center gap-1.5 shrink-0">
      <button
        v-if="!isMobile"
        type="button"
        class="inline-flex p-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
        :title="store.layoutMode === 'THREE_COL' ? 'Visning: 3-kolonne Widescreen (Klik for Split-visning)' : 'Visning: Klassisk Split (Klik for 3-kolonne)'"
        @click="toggleLayout"
      >
        <Rows v-if="store.layoutMode === 'THREE_COL'" class="w-3.5 h-3.5 text-blue-400" />
        <Columns v-else class="w-3.5 h-3.5 text-emerald-400" />
      </button>

      <button
        v-if="!isMobile"
        type="button"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
        title="Sieve Mail-Filtre & Regler (Mailcow / SOGo port 4190)"
        @click="store.openSieveModal()"
      >
        <Filter class="w-3.5 h-3.5 text-purple-400" />
        <span class="hidden 2xl:inline">Filtre</span>
      </button>

      <button
        v-if="!isMobile"
        type="button"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
        title="Administrér dine afsender-aliaser og signaturer"
        @click="store.isAliasModalOpen = true"
      >
        <AtSign class="w-3.5 h-3.5 text-blue-400" />
        <span class="hidden 2xl:inline">Aliaser</span>
        <span class="px-1.5 py-0.2 rounded-full bg-blue-500/20 text-blue-300 text-[10px] font-semibold">
          {{ store.aliases.length }}
        </span>
      </button>

      <button
        v-if="!isMobile"
        type="button"
        :disabled="store.undoStack.length === 0"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
        title="Fortryd seneste handling (Ctrl+Z)"
        @click="store.triggerUndo()"
      >
        <Undo2 class="w-3.5 h-3.5" />
        <span class="hidden 2xl:inline">Fortryd</span>
        <span
          v-if="store.undoStack.length > 0"
          class="px-1.5 py-0.2 rounded-full bg-blue-500/30 text-blue-300 text-[10px]"
        >
          {{ store.undoStack.length }}
        </span>
      </button>

      <ThemePicker variant="topbar" />

      <div v-if="!isMobile" class="relative">
        <button
          type="button"
          class="p-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
          title="Hurtige genveje & hjælp"
          @click="isHelpOpen = !isHelpOpen"
        >
          <HelpCircle class="w-4 h-4 text-blue-400" />
        </button>

        <div
          v-if="isHelpOpen"
          class="fixed inset-0 z-40"
          @click="isHelpOpen = false"
        ></div>
        <div
          v-if="isHelpOpen"
          class="absolute right-0 mt-2 w-80 rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-4 z-50 text-xs space-y-3"
        >
          <div class="flex items-center justify-between border-b border-slate-800 pb-2">
            <span class="flex items-center gap-1.5 font-bold text-slate-100">
              <Keyboard class="w-4 h-4 text-blue-400" />
              Hurtige Genveje &amp; Hjælp
            </span>
            <button
              type="button"
              class="text-slate-400 hover:text-slate-200"
              @click="isHelpOpen = false"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>

          <div class="grid grid-cols-2 gap-y-2 text-[11px] text-slate-300">
            <span>Skift Mail / Kalender / Kontakter:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Alt + 1 / 2 / 3</kbd>
            <span>Ny e-mail:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + N</kbd>
            <span>Send e-mail (i editor):</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + Enter</kbd>
            <span>Næste / Forrige mail:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">↓ / ↑</kbd>
            <span>Kopiér / Klip mail:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl+C / Ctrl+X</kbd>
            <span>Indsæt i aktiv mappe:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + V</kbd>
            <span>Fortryd handling:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + Z</kbd>
            <span>Markér alle i mappe:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + A</kbd>
            <span>Slet til papirkurv:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Delete</kbd>
          </div>
        </div>
      </div>

      <!-- Offline / Online & Sync -->
      <div class="relative">
        <button
          type="button"
          class="px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition flex items-center gap-1.5 text-xs"
          :title="store.isOnline ? 'Online — Klik for synkronisering og auto-opdatering' : 'Offline — Viser cachede e-mails fra IndexedDB'"
          @click="isSyncMenuOpen = !isSyncMenuOpen"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin text-blue-400': store.isSyncing }" />
          <Wifi v-if="store.isOnline && !isMobile" class="w-3.5 h-3.5 text-emerald-400" />
          <WifiOff v-else-if="!store.isOnline" class="w-3.5 h-3.5 text-amber-400" />
          <span
            v-if="store.autoRefreshMinutes > 0"
            class="px-1.5 py-0.2 rounded-full bg-blue-500/20 text-blue-300 text-[10px] font-semibold"
          >
            {{ store.autoRefreshMinutes }}m
          </span>
          <span
            v-else
            class="px-1.5 py-0.2 rounded-full bg-slate-700 text-slate-400 text-[10px]"
          >
            Manuel
          </span>
        </button>

        <div
          v-if="isSyncMenuOpen"
          class="fixed inset-0 z-40"
          @click="isSyncMenuOpen = false"
        ></div>

        <div
          v-if="isSyncMenuOpen"
          class="absolute right-0 mt-2 w-64 rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-3 z-50 text-xs space-y-2.5"
        >
          <div class="flex items-center justify-between border-b border-slate-800 pb-2">
            <span class="flex items-center gap-1.5 font-bold text-slate-100">
              <Clock class="w-3.5 h-3.5 text-blue-400" />
              Synkronisering &amp; Interval
            </span>
            <span v-if="store.lastSyncedAt" class="text-[10px] text-slate-400">
              Sidst: {{ store.lastSyncedAt }}
            </span>
          </div>

          <button
            type="button"
            :disabled="store.isSyncing"
            class="w-full py-2 px-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold flex items-center justify-center gap-1.5 shadow transition"
            @click="store.syncWithServer(false); isSyncMenuOpen = false"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': store.isSyncing }" />
            <span>{{ store.isSyncing ? 'Synkroniserer...' : 'Opdatér / Tjek for nye mails nu' }}</span>
          </button>

          <div class="pt-1 space-y-1">
            <div class="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-1">
              Automatisk opdatering
            </div>
            <button
              v-for="opt in refreshOptions"
              :key="opt.value"
              type="button"
              class="w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between transition"
              :class="store.autoRefreshMinutes === opt.value
                ? 'bg-blue-600/20 text-blue-300 font-semibold border border-blue-500/40'
                : 'hover:bg-slate-800 text-slate-300'"
              @click="store.setAutoRefreshMinutes(opt.value); isSyncMenuOpen = false"
            >
              <span>{{ opt.label }}</span>
              <Check v-if="store.autoRefreshMinutes === opt.value" class="w-3.5 h-3.5 text-blue-400" />
            </button>
          </div>
        </div>
      </div>

      <!-- Ny e-mail -->
      <button
        type="button"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg dav-theme-btn text-xs font-semibold shadow-sm transition"
        @click="store.openComposeModal('NEW')"
      >
        <Plus class="w-4 h-4" />
        <span class="hidden sm:inline">Ny e-mail</span>
      </button>

      <SuiteTopActions />
    </div>
  </header>
</template>
