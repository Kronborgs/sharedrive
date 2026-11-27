<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Trash2, X, Calendar as CalendarIcon, Search, AlertTriangle, CheckSquare, Square } from 'lucide-vue-next';
import { useCalendarStore, toDateOnlyString } from '../../stores/calendarStore';
import type { CalendarEvent } from '../../types/calendar';

const store = useCalendarStore();

const selectedCalendarId = ref<string>('ALL');
const cutoffDate = ref<string>(getOffsetDateStr(-90)); // Standard: ældre end 3 måneder
const titleFilter = ref<string>('');
const moveToTrash = ref<boolean>(false);
const excludedIds = ref<Set<string>>(new Set());
const isDeleting = ref<boolean>(false);

function getOffsetDateStr(daysOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return toDateOnlyString(d);
}

function setPreset(type: 'TODAY' | '1M' | '3M' | '6M' | '1Y' | 'YEAR_START') {
  const now = new Date();
  if (type === 'TODAY') {
    cutoffDate.value = toDateOnlyString(now);
  } else if (type === '1M') {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    cutoffDate.value = toDateOnlyString(d);
  } else if (type === '3M') {
    const d = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    cutoffDate.value = toDateOnlyString(d);
  } else if (type === '6M') {
    const d = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    cutoffDate.value = toDateOnlyString(d);
  } else if (type === '1Y') {
    const d = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    cutoffDate.value = toDateOnlyString(d);
  } else if (type === 'YEAR_START') {
    cutoffDate.value = `${now.getFullYear()}-01-01`;
  }
}

watch(
  () => store.isBulkDeleteModalOpen,
  (open) => {
    if (open) {
      excludedIds.value = new Set();
      if (
        selectedCalendarId.value !== 'ALL' &&
        !store.writableCalendars.some((c) => c.id === selectedCalendarId.value)
      ) {
        selectedCalendarId.value = 'ALL';
      }
    }
  }
);

watch([selectedCalendarId, cutoffDate, titleFilter], () => {
  excludedIds.value = new Set();
});

const writableCalIdSet = computed(() => new Set(store.writableCalendars.map((c) => c.id)));

const matchingEvents = computed<CalendarEvent[]>(() => {
  if (!cutoffDate.value) return [];
  const cutoffMs = new Date(`${cutoffDate.value}T00:00:00`).getTime();
  if (Number.isNaN(cutoffMs)) return [];
  const q = titleFilter.value.trim().toLowerCase();

  return store.events
    .filter((ev) => {
      if (!writableCalIdSet.value.has(ev.calendarId)) return false;
      if (selectedCalendarId.value !== 'ALL' && ev.calendarId !== selectedCalendarId.value) {
        return false;
      }
      const endOrStart = ev.end || ev.start;
      const evMs = new Date(endOrStart).getTime();
      if (Number.isNaN(evMs) || evMs >= cutoffMs) return false;

      if (q) {
        const hay = `${ev.title} ${ev.location || ''} ${ev.description || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
});

const selectedToDeleteIds = computed<string[]>(() =>
  matchingEvents.value.filter((ev) => !excludedIds.value.has(ev.id)).map((ev) => ev.id)
);

function toggleExclude(id: string) {
  const next = new Set(excludedIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  excludedIds.value = next;
}

function toggleSelectAll() {
  if (excludedIds.value.size === 0) {
    excludedIds.value = new Set(matchingEvents.value.map((e) => e.id));
  } else {
    excludedIds.value = new Set();
  }
}

function formatEventDate(ev: CalendarEvent): string {
  const d = new Date(ev.start);
  if (Number.isNaN(d.getTime())) return ev.start.slice(0, 10);
  return d.toLocaleDateString('da-DK', {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  });
}

async function handleConfirmBulkDelete() {
  const ids = selectedToDeleteIds.value;
  if (ids.length === 0) return;

  const confirmMsg = moveToTrash.value
    ? `Er du sikker på, at du vil slette ${ids.length} gamle begivenheder og flytte dem til 30-dages papirkurven?`
    : `Er du sikker på, at du vil slette ${ids.length} gamle begivenheder PERMANENT?\n\nDette kan ikke fortrydes.`;

  if (!window.confirm(confirmMsg)) return;

  isDeleting.value = true;
  try {
    await store.bulkDeleteEvents(ids, moveToTrash.value);
    store.isBulkDeleteModalOpen = false;
  } finally {
    isDeleting.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.isBulkDeleteModalOpen"
      class="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4"
      @click.self="store.isBulkDeleteModalOpen = false"
    >
      <div class="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <!-- Header -->
        <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-rose-500/20 border border-rose-500/40 flex items-center justify-center text-rose-400">
              <Trash2 class="w-4 h-4" />
            </div>
            <div>
              <h3 class="text-base font-bold text-slate-100 leading-tight">
                Bulk-oprydning i gamle begivenheder
              </h3>
              <p class="text-[11px] text-slate-400">
                Find og slet gamle begivenheder før en valgt dato på tværs af dine kalendere
              </p>
            </div>
          </div>

          <button
            type="button"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            @click="store.isBulkDeleteModalOpen = false"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <!-- Body -->
        <div class="p-5 space-y-4 overflow-y-auto text-xs flex-1">
          <!-- Hurtigvalg af skæringsdato -->
          <div>
            <label class="block text-slate-300 font-semibold mb-1.5">
              Hurtigvalg af periode (slet alt før):
            </label>
            <div class="flex flex-wrap gap-1.5">
              <button
                type="button"
                class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[11px] font-medium transition"
                @click="setPreset('TODAY')"
              >
                Før i dag
              </button>
              <button
                type="button"
                class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[11px] font-medium transition"
                @click="setPreset('1M')"
              >
                Ældre end 1 måned
              </button>
              <button
                type="button"
                class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[11px] font-medium transition"
                @click="setPreset('3M')"
              >
                Ældre end 3 måneder
              </button>
              <button
                type="button"
                class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[11px] font-medium transition"
                @click="setPreset('6M')"
              >
                Ældre end 6 måneder
              </button>
              <button
                type="button"
                class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[11px] font-medium transition"
                @click="setPreset('YEAR_START')"
              >
                Før i år (1. jan)
              </button>
              <button
                type="button"
                class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[11px] font-medium transition"
                @click="setPreset('1Y')"
              >
                Ældre end 1 år
              </button>
            </div>
          </div>

          <!-- Filtre: Kalender + Dato + Søgeord -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label class="block text-slate-300 font-medium mb-1">Kalender</label>
              <select
                v-model="selectedCalendarId"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="ALL">Alle egne kalendere ({{ store.writableCalendars.length }})</option>
                <option
                  v-for="cal in store.writableCalendars"
                  :key="cal.id"
                  :value="cal.id"
                >
                  {{ cal.name }}
                </option>
              </select>
            </div>

            <div>
              <label class="flex items-center gap-1 text-slate-300 font-medium mb-1">
                <CalendarIcon class="w-3.5 h-3.5 text-blue-400" />
                Slet begivenheder før dato
              </label>
              <input
                v-model="cutoffDate"
                type="date"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label class="flex items-center gap-1 text-slate-300 font-medium mb-1">
                <Search class="w-3.5 h-3.5 text-blue-400" />
                Valgfrit tekstfilter
              </label>
              <input
                v-model="titleFilter"
                type="text"
                placeholder="Alle titler (eller søg)..."
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <!-- Sletningsmåde -->
          <div class="p-3 rounded-xl bg-slate-950/90 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                v-model="moveToTrash"
                type="checkbox"
                class="rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-0"
              />
              <span class="text-slate-200 font-medium">
                Gem en kopi i den lokale 30-dages papirkurv
              </span>
            </label>
            <span class="text-[11px] text-slate-400">
              {{ moveToTrash ? 'Kan gendannes i 30 dage' : 'Slettes permanent med det samme' }}
            </span>
          </div>

          <!-- Forhåndsvisning af fundne begivenheder -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-slate-200">
                Fundne begivenheder før {{ cutoffDate }}:
                <strong class="text-rose-400 ml-1">{{ selectedToDeleteIds.length }}</strong>
                <span v-if="excludedIds.size > 0" class="text-slate-400 font-normal">
                  (af {{ matchingEvents.length }} fundne)
                </span>
              </span>

              <button
                v-if="matchingEvents.length > 0"
                type="button"
                class="text-[11px] text-blue-400 hover:text-blue-300 font-medium"
                @click="toggleSelectAll"
              >
                {{ excludedIds.size === 0 ? 'Fravælg alle' : 'Vælg alle' }}
              </button>
            </div>

            <div
              v-if="matchingEvents.length === 0"
              class="p-6 rounded-xl bg-slate-950/60 border border-slate-800 text-center text-slate-400"
            >
              Ingen begivenheder fundet før {{ cutoffDate }}.
            </div>

            <div
              v-else
              class="max-h-60 overflow-y-auto rounded-xl bg-slate-950 border border-slate-800 divide-y divide-slate-800/80"
            >
              <div
                v-for="ev in matchingEvents.slice(0, 200)"
                :key="ev.id"
                class="px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-900/80 cursor-pointer"
                @click="toggleExclude(ev.id)"
              >
                <div class="flex items-center gap-2.5 min-w-0">
                  <CheckSquare
                    v-if="!excludedIds.has(ev.id)"
                    class="w-4 h-4 text-rose-400 shrink-0"
                  />
                  <Square
                    v-else
                    class="w-4 h-4 text-slate-600 shrink-0"
                  />
                  <span
                    class="w-2.5 h-2.5 rounded-full shrink-0"
                    :style="{ backgroundColor: store.getCalendarById(ev.calendarId)?.color || '#3b82f6' }"
                  ></span>
                  <span class="font-medium text-slate-200 truncate">{{ ev.title }}</span>
                </div>

                <div class="flex items-center gap-2 shrink-0 text-[11px] text-slate-400">
                  <span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                    {{ store.getCalendarById(ev.calendarId)?.name || 'Kalender' }}
                  </span>
                  <span>{{ formatEventDate(ev) }}</span>
                </div>
              </div>

              <div
                v-if="matchingEvents.length > 200"
                class="px-3 py-2 text-center text-[11px] text-slate-400 bg-slate-900/60"
              >
                ... og {{ matchingEvents.length - 200 }} flere gamle begivenheder
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-5 py-3.5 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between gap-3">
          <div class="flex items-center gap-1.5 text-[11px] text-amber-300/90">
            <AlertTriangle class="w-4 h-4 shrink-0" />
            <span>Abonnerede og skrivebeskyttede kalendere berøres aldrig.</span>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              class="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
              @click="store.isBulkDeleteModalOpen = false"
            >
              Annullér
            </button>
            <button
              type="button"
              :disabled="isDeleting || selectedToDeleteIds.length === 0"
              class="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 shadow transition"
              @click="handleConfirmBulkDelete"
            >
              <Trash2 class="w-3.5 h-3.5" />
              <span>
                {{
                  isDeleting
                    ? 'Sletter...'
                    : `Slet ${selectedToDeleteIds.length} begivenhed(er)`
                }}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
