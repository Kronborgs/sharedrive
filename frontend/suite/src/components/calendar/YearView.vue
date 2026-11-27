<script setup lang="ts">
import { computed, ref } from 'vue';
import { Calendar as CalendarIcon, Clock, ExternalLink } from 'lucide-vue-next';
import { useCalendarStore, toDateOnlyString } from '../../stores/calendarStore';
import { useTheme } from '../../composables/useTheme';
import type { CalendarEvent } from '../../types/calendar';

const props = defineProps<{
  year: number;
}>();

const emit = defineEmits<{
  (e: 'open-month', dateStr: string): void;
  (e: 'open-day', dateStr: string): void;
}>();

const store = useCalendarStore();
const todayYmd = toDateOnlyString(new Date());
const activeDayPopup = ref<string | null>(null);
let lastDayClickTime = 0;
let lastDayClicked = '';

const MONTH_NAMES = [
  'Januar',
  'Februar',
  'Marts',
  'April',
  'Maj',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'December'
];

const WEEKDAYS = ['M', 'T', 'O', 'T', 'F', 'L', 'S'];
const { currentTheme } = useTheme();

function getIsoWeekNumber(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month, day));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

interface YearDayEvent {
  event: CalendarEvent;
  color: string;
}

/**
 * Indekserer alle synlige begivenheder for det valgte år i én O(N)-gennemgang (~1-3 ms for 1.500+ events).
 */
const eventsByDay = computed(() => {
  const map = new Map<string, YearDayEvent[]>();
  const calColorMap = new Map(store.calendars.map((c) => [c.id, c.color || '#06b6d4']));
  const yearStartMs = new Date(props.year, 0, 1, 0, 0, 0, 0).getTime();
  const yearEndMs = new Date(props.year, 11, 31, 23, 59, 59, 999).getTime();

  for (const ev of store.visibleEvents) {
    const startMs = new Date(ev.start).getTime();
    if (Number.isNaN(startMs)) continue;
    const rawEndMs = ev.end ? new Date(ev.end).getTime() : startMs;
    const endMs = Number.isNaN(rawEndMs) ? startMs : rawEndMs;

    if (endMs < yearStartMs || startMs > yearEndMs) continue;

    const color = calColorMap.get(ev.calendarId) || store.getCalendarById(ev.calendarId)?.color || '#06b6d4';
    const clampedStart = new Date(Math.max(startMs, yearStartMs));
    const startDay = new Date(clampedStart.getFullYear(), clampedStart.getMonth(), clampedStart.getDate());

    // For heldagsbegivenheder er slutdato eksklusiv i iCal/FullCalendar
    const effectiveEndMs = ev.allDay && endMs > startMs ? endMs - 1 : endMs;
    const clampedEnd = new Date(Math.min(effectiveEndMs, yearEndMs));
    const endDay = new Date(clampedEnd.getFullYear(), clampedEnd.getMonth(), clampedEnd.getDate());

    const cursor = new Date(startDay);
    let safety = 0;
    while (cursor <= endDay && safety < 62) {
      const key = `${cursor.getFullYear()}-${pad2(cursor.getMonth() + 1)}-${pad2(cursor.getDate())}`;
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      list.push({ event: ev, color });
      cursor.setDate(cursor.getDate() + 1);
      safety++;
    }
  }

  return map;
});

interface DayCell {
  dateStr: string;
  dayNum: number;
  inMonth: boolean;
}

interface WeekRow {
  weekNum: number;
  days: DayCell[];
}

interface MonthBlock {
  monthIndex: number;
  name: string;
  firstDateStr: string;
  weeks: WeekRow[];
}

const months = computed<MonthBlock[]>(() => {
  const result: MonthBlock[] = [];

  for (let m = 0; m < 12; m++) {
    const firstOfMonth = new Date(props.year, m, 1);
    const daysInMonth = new Date(props.year, m + 1, 0).getDate();
    // Mandag = 0 .. Søndag = 6
    const startOffset = (firstOfMonth.getDay() + 6) % 7;

    const cells: DayCell[] = [];
    for (let i = 0; i < startOffset; i++) {
      cells.push({ dateStr: '', dayNum: 0, inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({
        dateStr: `${props.year}-${pad2(m + 1)}-${pad2(d)}`,
        dayNum: d,
        inMonth: true
      });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ dateStr: '', dayNum: 0, inMonth: false });
    }

    const weeks: WeekRow[] = [];
    for (let w = 0; w < cells.length; w += 7) {
      const slice = cells.slice(w, w + 7);
      const firstValid = slice.find((c) => c.inMonth);
      const weekNum = firstValid ? getIsoWeekNumber(props.year, m, firstValid.dayNum) : 0;
      weeks.push({ weekNum, days: slice });
    }

    result.push({
      monthIndex: m,
      name: MONTH_NAMES[m],
      firstDateStr: `${props.year}-${pad2(m + 1)}-01`,
      weeks
    });
  }

  return result;
});

const selectedDayEvents = computed(() => {
  const key = activeDayPopup.value || store.selectedDateStr.slice(0, 10);
  return eventsByDay.value.get(key) || [];
});

const activeDisplayDate = computed(() => activeDayPopup.value || store.selectedDateStr.slice(0, 10));

function formatTimeLabel(ev: CalendarEvent): string {
  if (ev.allDay) return 'Heldag';
  const d = new Date(ev.start);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
}

function handleDayClick(dateStr: string) {
  if (!dateStr) return;
  store.closeContextMenu();
  store.selectedDateStr = dateStr;
  store.selectedEventIds = [];
  activeDayPopup.value = dateStr;

  const now = Date.now();
  if (now - lastDayClickTime < 320 && lastDayClicked === dateStr) {
    emit('open-day', dateStr);
  }
  lastDayClickTime = now;
  lastDayClicked = dateStr;
}

function handleDayContextMenu(e: MouseEvent, dateStr: string) {
  if (!dateStr || store.isPublicShareMode) return;
  e.preventDefault();
  e.stopPropagation();
  store.selectedDateStr = dateStr;
  store.openContextMenu({
    x: e.clientX,
    y: e.clientY,
    targetType: 'DATE',
    event: null,
    dateStr,
    allDay: true
  });
}
</script>

<template>
  <div
    class="h-full flex flex-col gap-2.5 p-2.5 overflow-hidden transition-colors duration-300"
    :class="currentTheme.wallpaper ? 'bg-transparent' : 'bg-slate-950'"
  >
    <!-- 12-måneders gitter (ultra-letvægts uden DOM-reflow) -->
    <div class="flex-1 overflow-y-auto pr-1">
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        <div
          v-for="month in months"
          :key="month.monthIndex"
          class="rounded-xl border p-2.5 flex flex-col transition-colors"
          :class="
            currentTheme.wallpaper
              ? 'bg-black/25 border-white/10 backdrop-blur-sm'
              : 'bg-slate-900/90 border-slate-800'
          "
        >
          <button
            type="button"
            class="flex items-center justify-between px-1 pb-2 mb-1.5 border-b border-slate-800 text-left group"
            title="Klik for at åbne månedsvisning"
            @click="emit('open-month', month.firstDateStr)"
          >
            <span class="text-xs font-bold text-slate-100 group-hover:text-blue-400 transition">
              {{ month.name }} {{ props.year }}
            </span>
            <ExternalLink class="w-3 h-3 text-slate-500 group-hover:text-blue-400 transition" />
          </button>

          <!-- Ugedage -->
          <div class="grid grid-cols-[24px_repeat(7,1fr)] gap-0.5 text-[10px] font-semibold text-slate-500 text-center mb-1">
            <span class="text-blue-400/70">U</span>
            <span v-for="(wd, idx) in WEEKDAYS" :key="idx">{{ wd }}</span>
          </div>

          <!-- Ugerækker -->
          <div class="space-y-0.5">
            <div
              v-for="(week, wIdx) in month.weeks"
              :key="wIdx"
              class="grid grid-cols-[24px_repeat(7,1fr)] gap-0.5 items-center"
            >
              <span class="text-[9px] font-bold text-blue-400/80 text-center select-none">
                {{ week.weekNum }}
              </span>

              <button
                v-for="(cell, dIdx) in week.days"
                :key="dIdx"
                type="button"
                :disabled="!cell.inMonth"
                class="h-8 rounded-md flex flex-col items-center justify-start pt-0.5 transition relative select-none"
                :class="[
                  !cell.inMonth
                    ? 'opacity-0 pointer-events-none'
                    : cell.dateStr === activeDisplayDate
                      ? 'bg-blue-600/25 ring-1 ring-blue-500 text-white'
                      : cell.dateStr === todayYmd
                        ? 'bg-blue-600/15 text-blue-300 font-bold'
                        : 'hover:bg-slate-800/80 text-slate-300'
                ]"
                :title="
                  cell.inMonth && (eventsByDay.get(cell.dateStr)?.length || 0) > 0
                    ? `${cell.dateStr}: ${eventsByDay.get(cell.dateStr)!.length} begivenhed(er) — dobbeltklik for dagsvisning`
                    : cell.dateStr
                "
                @click="handleDayClick(cell.dateStr)"
                @contextmenu="handleDayContextMenu($event, cell.dateStr)"
              >
                <span
                  class="text-[10.5px] leading-none"
                  :class="cell.dateStr === todayYmd ? 'px-1 py-0.5 rounded-full bg-blue-600 text-white' : ''"
                >
                  {{ cell.inMonth ? cell.dayNum : '' }}
                </span>

                <!-- Farvede prikker for begivenheder på dagen -->
                <div
                  v-if="cell.inMonth && eventsByDay.has(cell.dateStr)"
                  class="flex items-center justify-center gap-0.5 mt-1 max-w-full px-0.5"
                >
                  <span
                    v-for="(item, eIdx) in eventsByDay.get(cell.dateStr)!.slice(0, 3)"
                    :key="eIdx"
                    class="w-1.5 h-1.5 rounded-full shrink-0"
                    :style="{ backgroundColor: item.color }"
                  ></span>
                  <span
                    v-if="eventsByDay.get(cell.dateStr)!.length > 3"
                    class="text-[8px] leading-none font-bold text-slate-400"
                  >
                    +
                  </span>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Valgt dags begivenheder i bunden af årsvisningen -->
    <div
      class="shrink-0 rounded-xl border px-3 py-2 flex items-center justify-between gap-3 min-h-[46px] transition-colors"
      :class="
        currentTheme.wallpaper
          ? 'bg-black/30 border-white/10 backdrop-blur-md'
          : 'bg-slate-900 border-slate-800'
      "
    >
      <div class="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto">
        <span class="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-300 shrink-0">
          <CalendarIcon class="w-3.5 h-3.5" />
          {{ activeDisplayDate }}:
        </span>

        <span v-if="selectedDayEvents.length === 0" class="text-xs text-slate-500">
          Ingen begivenheder på denne dag (dobbeltklik på en dato for at åbne dagsvisning)
        </span>

        <div v-else class="flex items-center gap-1.5 overflow-x-auto py-0.5">
          <button
            v-for="item in selectedDayEvents"
            :key="item.event.id"
            type="button"
            class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold text-white shrink-0 hover:brightness-110 transition"
            :style="{ backgroundColor: item.color }"
            @click="store.openEditEventModal(item.event)"
          >
            <Clock class="w-3 h-3 opacity-85" />
            <span>{{ formatTimeLabel(item.event) }}</span>
            <span class="max-w-[160px] truncate">{{ item.event.title }}</span>
          </button>
        </div>
      </div>

      <button
        type="button"
        class="shrink-0 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 transition"
        @click="emit('open-day', activeDisplayDate)"
      >
        Åbn dag
      </button>
    </div>
  </div>
</template>
