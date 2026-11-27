<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Search,
  Undo2,
  RefreshCw,
  Wifi,
  WifiOff,
  Plus,
  Share2,
  Lock,
  X,
  HelpCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Keyboard,
  ShieldCheck,
  Pencil,
  Clock,
  Check
} from 'lucide-vue-next';
import { useCalendarStore, type CalendarAutoRefreshMinutes } from '../../stores/calendarStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';
import ThemePicker from '../shared/ThemePicker.vue';
import SuiteModuleSwitcher from '../shared/SuiteModuleSwitcher.vue';
import SuiteTopActions from '../shared/SuiteTopActions.vue';
import type { CalendarEvent, CalendarViewType } from '../../types/calendar';

const props = defineProps<{
  titleText: string;
  sidebarCollapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'prev'): void;
  (e: 'next'): void;
  (e: 'today'): void;
  (e: 'change-view', view: CalendarViewType): void;
  (e: 'jump-to-date', dateIso: string): void;
  (e: 'toggle-sidebar'): void;
}>();

const store = useCalendarStore();
const { currentTheme } = useTheme();
const { isMobile } = useViewport();
const isSearchFocused = ref(false);
const isHelpOpen = ref(false);
const isSyncMenuOpen = ref(false);

const refreshOptions: Array<{ label: string; value: CalendarAutoRefreshMinutes }> = [
  { label: 'Hvert 1. minut', value: 1 },
  { label: 'Hvert 2. minut (Standard)', value: 2 },
  { label: 'Hvert 5. minut', value: 5 },
  { label: 'Hvert 10. minut', value: 10 },
  { label: 'Kun manuelt', value: 0 }
];

const formattedLastSyncedAt = computed(() => {
  if (!store.lastSyncedAt) return '';
  const dt = new Date(store.lastSyncedAt);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
});

const showSearchDropdown = computed(
  () => isSearchFocused.value && store.searchQuery.trim().length > 0
);

function goToSearchResultDay(ev: CalendarEvent) {
  store.selectedEventIds = [ev.id];
  store.selectedDateStr = ev.start.slice(0, 10);
  emit('jump-to-date', ev.start);
  isSearchFocused.value = false;
}

function editSearchResult(ev: CalendarEvent) {
  store.selectedEventIds = [ev.id];
  store.selectedDateStr = ev.start.slice(0, 10);
  emit('jump-to-date', ev.start);
  store.openEditEventModal(ev);
  isSearchFocused.value = false;
}

function handleSearchBlur() {
  window.setTimeout(() => {
    isSearchFocused.value = false;
  }, 180);
}

function formatShortDateTime(ev: CalendarEvent): string {
  const dt = new Date(ev.start);
  if (ev.allDay) {
    return (
      dt.toLocaleDateString('da-DK', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' (Heldag)'
    );
  }
  return dt.toLocaleString('da-DK', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}
</script>

<template>
  <!-- Desktop TopBar (uændret 1-linje layout) -->
  <header
    v-if="!isMobile"
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
    <!-- Venstre: Sidebar Toggle, Suite Modulskifter & Kalender-navigation -->
    <div class="flex items-center gap-2.5 shrink-0">
      <button
        type="button"
        class="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
        :title="props.sidebarCollapsed ? 'Vis sidepanel' : 'Skjul sidepanel (mere plads til kalenderen)'"
        @click="emit('toggle-sidebar')"
      >
        <PanelLeftOpen v-if="props.sidebarCollapsed" class="w-4 h-4 text-blue-400" />
        <PanelLeftClose v-else class="w-4 h-4" />
      </button>

      <SuiteModuleSwitcher v-if="!store.isPublicShareMode" />

      <div v-else class="flex items-center gap-2.5">
        <div class="w-9 h-9 rounded-xl border flex items-center justify-center dav-theme-badge transition-colors">
          <CalendarIcon class="w-5 h-5" />
        </div>
        <div>
          <div class="font-bold text-slate-100 leading-tight tracking-tight flex items-center gap-2">
            {{ store.session?.shareLabel || 'Delt Kalender' }}
            <span
              class="inline-flex items-center gap-1 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border bg-amber-500/15 text-amber-300 border-amber-500/30"
            >
              <Lock class="w-2.5 h-2.5" /> Kun visning (Delt link)
            </span>
          </div>
          <p class="text-[11px] text-slate-400 hidden sm:block">
            Delt af {{ store.session?.username }}
          </p>
        </div>
      </div>

      <div class="h-6 w-px bg-slate-800 hidden md:block"></div>

      <!-- I dag & frem/tilbage -->
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          class="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          @click="emit('today')"
        >
          I dag
        </button>
        <div class="flex items-center bg-slate-800/80 rounded-lg border border-slate-700/80 p-0.5">
          <button
            type="button"
            class="p-1.5 rounded-md hover:bg-slate-700 text-slate-300 transition"
            title="Forrige periode"
            @click="emit('prev')"
          >
            <ChevronLeft class="w-4 h-4" />
          </button>
          <button
            type="button"
            class="p-1.5 rounded-md hover:bg-slate-700 text-slate-300 transition"
            title="Næste periode"
            @click="emit('next')"
          >
            <ChevronRight class="w-4 h-4" />
          </button>
        </div>
        <h1 class="text-sm sm:text-base font-semibold text-slate-100 capitalize ml-1.5 truncate max-w-[170px]">
          {{ props.titleText }}
        </h1>
      </div>
    </div>

    <!-- Midt: Øjeblikkelig Lokal Søgning -->
    <div class="relative flex-1 max-w-xs xl:max-w-md min-w-[70px] 2xl:min-w-[130px]">
      <div class="relative flex items-center">
        <Search class="w-4 h-4 text-slate-400 absolute left-3 pointer-events-none" />
        <input
          v-model="store.searchQuery"
          type="text"
          placeholder="Lyn-søg i kalenderen (titel, lokation)..."
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
      </div>

      <div
        v-if="showSearchDropdown"
        class="absolute left-0 right-0 mt-1.5 bg-slate-900/95 backdrop-blur-xl border border-slate-700/80 rounded-xl shadow-2xl max-h-80 overflow-y-auto z-50 divide-y divide-slate-800/80"
      >
        <div
          v-if="store.searchResults.length === 0"
          class="p-4 text-xs text-slate-400 text-center"
        >
          Ingen begivenheder matcher "{{ store.searchQuery }}"
        </div>
        <div
          v-for="ev in store.searchResults"
          :key="ev.id"
          class="w-full px-3.5 py-2.5 hover:bg-slate-800/90 flex items-center justify-between gap-2.5 transition cursor-pointer"
          @mousedown.prevent="goToSearchResultDay(ev)"
        >
          <div class="flex items-center gap-2.5 min-w-0 flex-1">
            <span
              class="w-2.5 h-2.5 rounded-full shrink-0"
              :style="{ backgroundColor: store.getCalendarById(ev.calendarId)?.color || '#3b82f6' }"
            ></span>
            <div class="truncate">
              <div class="text-xs font-medium text-slate-100 truncate">{{ ev.title }}</div>
              <div class="text-[11px] text-slate-400 truncate">
                {{ formatShortDateTime(ev) }} • {{ store.getCalendarById(ev.calendarId)?.name }}
                <span v-if="ev.location"> • {{ ev.location }}</span>
              </div>
            </div>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              class="px-2 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600 border border-blue-500/40 text-blue-300 hover:text-white text-[10.5px] font-semibold transition"
              title="Hop til dagen i kalenderen"
              @mousedown.stop.prevent="goToSearchResultDay(ev)"
            >
              Gå til dag
            </button>
            <button
              v-if="!store.isCalendarReadOnly(ev.calendarId)"
              type="button"
              class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[10.5px] font-medium transition"
              title="Åbn og redigér begivenheden"
              @mousedown.stop.prevent="editSearchResult(ev)"
            >
              <Pencil class="w-3 h-3" />
              <span>Redigér</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Højre -->
    <div class="flex items-center gap-1.5 shrink-0">
      <button
        v-if="!store.isPublicShareMode"
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

      <!-- Visningsskift -->
      <div
        class="flex items-center p-0.5 rounded-lg border text-xs transition"
        :class="currentTheme.wallpaper ? 'bg-black/30 border-white/15' : 'bg-slate-950 border-slate-800'"
      >
        <button
          type="button"
          class="px-2 py-1 rounded-md font-medium transition"
          :class="store.currentView === 'multiMonthYear' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'multiMonthYear')"
        >
          År
        </button>
        <button
          type="button"
          class="px-2 py-1 rounded-md font-medium transition"
          :class="store.currentView === 'dayGridMonth' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'dayGridMonth')"
        >
          Måned
        </button>
        <button
          type="button"
          class="px-2 py-1 rounded-md font-medium transition"
          :class="store.currentView === 'timeGridWeek' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'timeGridWeek')"
        >
          Uge
        </button>
        <button
          type="button"
          class="px-2 py-1 rounded-md font-medium transition"
          :class="store.currentView === 'timeGridDay' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'timeGridDay')"
        >
          Dag
        </button>
        <button
          type="button"
          class="px-2 py-1 rounded-md font-medium transition"
          :class="store.currentView === 'listMonth' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'listMonth')"
        >
          Liste
        </button>
      </div>

      <button
        v-if="!store.isPublicShareMode"
        type="button"
        class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
        title="Del kalender med 3. part via offentligt Read-Only link"
        @click="store.openShareModal()"
      >
        <Share2 class="w-3.5 h-3.5 text-blue-400" />
        <span class="hidden 2xl:inline">Del</span>
      </button>

      <ThemePicker variant="topbar" />

      <div v-if="!store.isPublicShareMode" class="relative hidden md:block">
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
            <span>Kopiér begivenhed:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + C</kbd>
            <span>Klip begivenhed:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + X</kbd>
            <span>Indsæt på valgt dag:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + V</kbd>
            <span>Fortryd handling:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + Z</kbd>
            <span>Slet til papirkurv:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Delete</kbd>
            <span>Markér flere aftaler:</span>
            <kbd class="justify-self-end px-2 py-0.5 bg-slate-800 border border-slate-700 text-slate-100 rounded text-[10px] font-semibold">Ctrl + Klik</kbd>
            <span>Opret / Redigér:</span>
            <span class="justify-self-end text-[10px] text-slate-400">Dobbeltklik</span>
            <span>Kontekstmenu:</span>
            <span class="justify-self-end text-[10px] text-slate-400">Højreklik</span>
          </div>

          <div class="pt-2 border-t border-slate-800 flex items-start gap-2 text-[11px] text-slate-400">
            <ShieldCheck class="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              <strong class="text-slate-200">Mødesikkerhed aktiv:</strong> Møder med andre inviterede deltagere spærres automatisk for <code class="text-slate-300">Ctrl+C</code>.
            </span>
          </div>
        </div>
      </div>

      <!-- Offline / Online & Sync -->
      <button
        v-if="store.isPublicShareMode"
        type="button"
        class="p-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition flex items-center gap-1.5 text-xs"
        :title="store.isOnline ? 'Online — Klik for at opdatere nu' : 'Offline'"
        @click="store.syncWithServer(false)"
      >
        <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin text-blue-400': store.isSyncing }" />
        <Wifi v-if="store.isOnline" class="w-3.5 h-3.5 text-emerald-400" />
        <WifiOff v-else class="w-3.5 h-3.5 text-amber-400" />
      </button>

      <div v-else class="relative">
        <button
          type="button"
          class="px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition flex items-center gap-1.5 text-xs"
          :title="store.isOnline ? 'Online — Klik for synkronisering og auto-opdatering' : 'Offline — Ændringer gemmes i kø i IndexedDB'"
          @click="isSyncMenuOpen = !isSyncMenuOpen"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin text-blue-400': store.isSyncing }" />
          <Wifi v-if="store.isOnline" class="w-3.5 h-3.5 text-emerald-400" />
          <WifiOff v-else class="w-3.5 h-3.5 text-amber-400" />
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
          <span
            v-if="store.syncQueue.length > 0"
            class="px-1.5 rounded-full bg-amber-500/30 text-amber-300 text-[10px]"
          >
            {{ store.syncQueue.length }}
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
            <span v-if="formattedLastSyncedAt" class="text-[10px] text-slate-400">
              Sidst: {{ formattedLastSyncedAt }}
            </span>
          </div>

          <button
            type="button"
            :disabled="store.isSyncing"
            class="w-full py-2 px-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold flex items-center justify-center gap-1.5 shadow transition"
            @click="store.syncWithServer(false); isSyncMenuOpen = false"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': store.isSyncing }" />
            <span>{{ store.isSyncing ? 'Synkroniserer...' : 'Synkronisér kalendere nu' }}</span>
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

      <button
        v-if="!store.isPublicShareMode"
        type="button"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg dav-theme-btn text-xs font-semibold shadow-sm transition"
        aria-label="Ny begivenhed"
        title="Ny begivenhed"
        @click="store.openCreateEventModal()"
      >
        <Plus class="w-4 h-4" />
        <span class="hidden 2xl:inline">Ny begivenhed</span>
      </button>

      <SuiteTopActions v-if="!store.isPublicShareMode" />
    </div>
  </header>

  <!-- Mobil TopBar: Stramt 2-linjers layout -->
  <header
    v-else
    class="px-2.5 py-2 flex flex-col gap-2 select-none relative z-30 transition-all duration-300"
    :class="
      currentTheme.wallpaper
        ? 'mx-2 mt-2 rounded-2xl border backdrop-blur-xl shadow-lg'
        : 'bg-slate-900/95 border-b border-slate-800'
    "
    :style="
      currentTheme.wallpaper
        ? { backgroundColor: currentTheme.surface, borderColor: currentTheme.border }
        : undefined
    "
  >
    <!-- Linje 1: Sidepanel + Periode/Måned + Sync / Ny begivenhed / Log ud -->
    <div class="flex items-center justify-between gap-1.5 w-full">
      <div class="flex items-center gap-1.5 min-w-0 flex-1">
        <button
          type="button"
          class="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition shrink-0"
          :title="props.sidebarCollapsed ? 'Vis sidepanel' : 'Skjul sidepanel'"
          @click="emit('toggle-sidebar')"
        >
          <PanelLeftOpen v-if="props.sidebarCollapsed" class="w-4 h-4 text-blue-400" />
          <PanelLeftClose v-else class="w-4 h-4" />
        </button>

        <div class="flex items-center bg-slate-800/80 rounded-lg border border-slate-700/80 p-0.5 shrink-0">
          <button
            type="button"
            class="p-1.5 rounded-md hover:bg-slate-700 text-slate-300 transition"
            title="Forrige periode"
            @click="emit('prev')"
          >
            <ChevronLeft class="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            class="p-1.5 rounded-md hover:bg-slate-700 text-slate-300 transition"
            title="Næste periode"
            @click="emit('next')"
          >
            <ChevronRight class="w-3.5 h-3.5" />
          </button>
        </div>

        <h1 class="text-sm font-semibold text-slate-100 capitalize truncate min-w-0">
          {{ props.titleText }}
        </h1>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <button
          v-if="store.isPublicShareMode"
          type="button"
          class="p-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition flex items-center gap-1 text-xs"
          :title="store.isOnline ? 'Online — Klik for at opdatere nu' : 'Offline'"
          @click="store.syncWithServer(false)"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin text-blue-400': store.isSyncing }" />
          <WifiOff v-if="!store.isOnline" class="w-3.5 h-3.5 text-amber-400" />
        </button>

        <div v-else class="relative">
          <button
            type="button"
            class="px-2 py-1.5 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition flex items-center gap-1 text-xs"
            :title="store.isOnline ? 'Synkronisering og auto-opdatering' : 'Offline'"
            @click="isSyncMenuOpen = !isSyncMenuOpen"
          >
            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin text-blue-400': store.isSyncing }" />
            <WifiOff v-if="!store.isOnline" class="w-3.5 h-3.5 text-amber-400" />
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
              Man.
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
              <span v-if="formattedLastSyncedAt" class="text-[10px] text-slate-400">
                Sidst: {{ formattedLastSyncedAt }}
              </span>
            </div>

            <button
              type="button"
              :disabled="store.isSyncing"
              class="w-full py-2 px-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold flex items-center justify-center gap-1.5 shadow transition"
              @click="store.syncWithServer(false); isSyncMenuOpen = false"
            >
              <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': store.isSyncing }" />
              <span>{{ store.isSyncing ? 'Synkroniserer...' : 'Synkronisér kalendere nu' }}</span>
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

        <button
          v-if="!store.isPublicShareMode"
          type="button"
          class="p-2 rounded-lg dav-theme-btn text-xs font-semibold shadow-sm transition"
          title="Opret ny begivenhed"
          @click="store.openCreateEventModal()"
        >
          <Plus class="w-4 h-4" />
        </button>

        <SuiteTopActions v-if="!store.isPublicShareMode" />
      </div>
    </div>

    <!-- Linje 2: I dag + 5 visninger + Tema -->
    <div class="flex items-center justify-between gap-1.5 w-full">
      <button
        type="button"
        class="px-2.5 py-1.5 text-[11.5px] font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition shrink-0"
        @click="emit('today')"
      >
        I dag
      </button>

      <div
        class="flex-1 flex items-center p-0.5 rounded-lg border text-[11px] transition min-w-0"
        :class="currentTheme.wallpaper ? 'bg-black/30 border-white/15' : 'bg-slate-950 border-slate-800'"
      >
        <button
          type="button"
          class="flex-1 text-center py-1 rounded-md font-medium transition"
          :class="store.currentView === 'multiMonthYear' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'multiMonthYear')"
        >
          År
        </button>
        <button
          type="button"
          class="flex-1 text-center py-1 rounded-md font-medium transition"
          :class="store.currentView === 'dayGridMonth' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'dayGridMonth')"
        >
          Måned
        </button>
        <button
          type="button"
          class="flex-1 text-center py-1 rounded-md font-medium transition"
          :class="store.currentView === 'timeGridWeek' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'timeGridWeek')"
        >
          Uge
        </button>
        <button
          type="button"
          class="flex-1 text-center py-1 rounded-md font-medium transition"
          :class="store.currentView === 'timeGridDay' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'timeGridDay')"
        >
          Dag
        </button>
        <button
          type="button"
          class="flex-1 text-center py-1 rounded-md font-medium transition"
          :class="store.currentView === 'listMonth' ? 'dav-theme-btn font-semibold' : 'text-slate-300/80 hover:text-white'"
          @click="emit('change-view', 'listMonth')"
        >
          Liste
        </button>
      </div>

      <div class="shrink-0">
        <ThemePicker variant="topbar" />
      </div>
    </div>
  </header>
</template>
