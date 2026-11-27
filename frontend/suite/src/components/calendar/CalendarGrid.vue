<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import FullCalendar from '@fullcalendar/vue3';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import type {
  CalendarOptions,
  EventClickArg,
  EventContentArg,
  EventDropArg
} from '@fullcalendar/core';
import type { DateClickArg, EventResizeDoneArg } from '@fullcalendar/interaction';
import { Check, Copy, Scissors } from 'lucide-vue-next';
import { useCalendarStore, toDateOnlyString } from '../../stores/calendarStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';
import type { CalendarEvent, CalendarViewType } from '../../types/calendar';
import YearView from './YearView.vue';

const emit = defineEmits<{
  (e: 'title-change', title: string): void;
}>();

const store = useCalendarStore();
const calendarRef = ref<InstanceType<typeof FullCalendar> | null>(null);
const gridContainerRef = ref<HTMLElement | null>(null);
let lastClickTime = 0;
let lastClickedId = '';

const initialView = store.currentView === 'multiMonthYear' ? 'dayGridMonth' : store.currentView;
const yearViewYear = ref<number>(new Date().getFullYear());

function createSvgIcon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('w-3', 'h-3');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const { currentTheme } = useTheme();
const { isMobile } = useViewport();
const ICON_VIDEO_TPL = createSvgIcon(['m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5', 'M2 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z']);
const ICON_USERS_TPL = createSvgIcon(['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M22 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75']);
const ICON_LOCK_TPL = createSvgIcon(['M7 11V7a5 5 0 0 1 10 0v4', 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z']);

function renderEventContent(arg: EventContentArg) {
  const props = arg.event.extendedProps;
  const calColor = (props.calColor as string) || '#06b6d4';
  const isInClipboard = Boolean(props.isInClipboard);
  const clipboardMode = props.clipboardMode as string | null;
  const hasGuests = Boolean(props.hasGuests);
  const hasVideo = Boolean(props.hasVideo);
  const isReadOnly = Boolean(props.isReadOnly);
  const calendarName = (props.calendarName as string) || '';

  const root = document.createElement('div');
  root.setAttribute('data-dav-event-id', arg.event.id);
  root.className =
    'w-full px-1.5 py-[1px] flex items-center justify-between gap-1 overflow-hidden text-[10.5px] leading-[14px] cursor-pointer select-none rounded-[4px]';
  root.style.backgroundColor = calColor;
  root.style.borderLeft = '3px solid rgba(255, 255, 255, 0.5)';
  root.style.boxShadow = 'inset 0 0 0 1px rgba(255, 255, 255, 0.18)';
  root.title = `${arg.event.title} — Kalender: ${calendarName}${isInClipboard ? ' (I UDKLIPSHOLDER)' : ''}${hasGuests ? ' (Har mødedeltagere - Ctrl+C spærret)' : ''}`;

  const left = document.createElement('div');
  left.className = 'flex items-center gap-1 min-w-0 truncate text-white';
  left.style.textShadow = '0 1px 1px rgba(0, 0, 0, 0.45)';

  if (isInClipboard) {
    const badge = document.createElement('span');
    badge.className = 'px-1 py-0.2 rounded bg-black/50 text-emerald-300 text-[9px] font-bold uppercase shrink-0';
    badge.textContent = clipboardMode === 'CUT' ? 'KLIP' : 'KOPI';
    left.appendChild(badge);
  }

  if (arg.timeText) {
    const timeEl = document.createElement('span');
    timeEl.className = 'font-bold opacity-95 shrink-0';
    timeEl.textContent = arg.timeText;
    left.appendChild(timeEl);
  }

  const titleEl = document.createElement('span');
  titleEl.className = 'font-semibold truncate';
  titleEl.textContent = arg.event.title;
  left.appendChild(titleEl);

  root.appendChild(left);

  const showLock = isReadOnly && !store.isPublicShareMode;
  if (hasVideo || hasGuests || showLock) {
    const right = document.createElement('div');
    right.className = 'flex items-center gap-0.5 shrink-0 text-white/90';
    if (hasVideo) right.appendChild(ICON_VIDEO_TPL.cloneNode(true));
    if (hasGuests) right.appendChild(ICON_USERS_TPL.cloneNode(true));
    if (showLock) right.appendChild(ICON_LOCK_TPL.cloneNode(true));
    root.appendChild(right);
  }

  return { domNodes: [root] };
}

const fcEvents = computed(() => {
  const calendarMap = new Map(store.calendars.map((c) => [c.id, c]));
  const selectedSet = new Set(store.selectedEventIds);
  const clipSet = store.clipboardEventIds;
  const clipMode = store.clipboard.mode;
  const isShare = store.isPublicShareMode;

  return store.visibleEvents.map((ev) => {
    const cal = calendarMap.get(ev.calendarId) || store.getCalendarById(ev.calendarId);
    const calColor = cal?.color || '#06b6d4';
    const isSelected = selectedSet.has(ev.id);
    const isInClipboard = clipSet.has(ev.id);
    const clipboardMode = isInClipboard ? clipMode : null;
    const isReadOnly = isShare || store.isEventReadOnly(ev);
    const hasGuests = store.hasInvitedAttendees(ev);

    return {
      id: ev.id,
      title: ev.title,
      start: ev.start,
      end: ev.end,
      allDay: ev.allDay,
      display: 'block',
      editable: !isReadOnly,
      startEditable: !isReadOnly,
      durationEditable: !isReadOnly,
      backgroundColor: calColor,
      borderColor: isSelected
        ? '#f8fafc'
        : isInClipboard
          ? '#34d399'
          : calColor,
      textColor: '#ffffff',
      classNames: [
        'dav-event-box',
        isSelected ? 'dav-event-selected' : '',
        isInClipboard && clipboardMode === 'COPY' ? 'dav-event-copied' : '',
        isInClipboard && clipboardMode === 'CUT' ? 'dav-event-cut' : '',
        isReadOnly ? 'dav-event-readonly' : ''
      ].filter(Boolean),
      extendedProps: {
        eventId: ev.id,
        rawEvent: ev,
        calColor,
        isSelected,
        isInClipboard,
        clipboardMode,
        isReadOnly,
        hasGuests,
        hasVideo: Boolean(ev.videoUrl),
        calendarName: cal?.name || ''
      }
    };
  });
});

function updateSelectedDayHighlight() {
  if (!gridContainerRef.value) return;
  gridContainerRef.value
    .querySelectorAll<HTMLElement>('.dav-day-selected')
    .forEach((el) => el.classList.remove('dav-day-selected'));

  const targetYmd = (store.selectedDateStr || '').slice(0, 10);
  if (!targetYmd) return;

  gridContainerRef.value
    .querySelectorAll<HTMLElement>(`[data-date="${CSS.escape(targetYmd)}"]`)
    .forEach((el) => {
      if (el.classList.contains('fc-daygrid-day') || el.classList.contains('fc-timegrid-col')) {
        el.classList.add('dav-day-selected');
      }
    });
}

watch(
  () => store.selectedDateStr,
  () => {
    void nextTick(updateSelectedDayHighlight);
  }
);

function handleDateClick(arg: DateClickArg) {
  store.closeContextMenu();
  const clickedDateStr = arg.allDay ? toDateOnlyString(arg.date) : arg.dateStr;
  store.selectedDateStr = clickedDateStr;
  store.selectedEventIds = [];

  if (store.isPublicShareMode) return;

  const now = Date.now();
  if (now - lastClickTime < 320 && lastClickedId === `date:${clickedDateStr}`) {
    store.openCreateEventModal(clickedDateStr, arg.allDay);
  }
  lastClickTime = now;
  lastClickedId = `date:${clickedDateStr}`;
}

function handleEventClick(arg: EventClickArg) {
  arg.jsEvent.stopPropagation();
  store.closeContextMenu();

  const evId = arg.event.id;
  const ev = store.events.find((e) => e.id === evId) || (arg.event.extendedProps.rawEvent as CalendarEvent);
  if (!ev) return;

  store.selectedDateStr = toDateOnlyString(new Date(ev.start));

  if (store.isPublicShareMode) {
    store.openEditEventModal(ev);
    return;
  }

  if (arg.jsEvent.ctrlKey || arg.jsEvent.metaKey || arg.jsEvent.shiftKey) {
    if (store.selectedEventIds.includes(ev.id)) {
      store.selectedEventIds = store.selectedEventIds.filter((id) => id !== ev.id);
    } else {
      store.selectedEventIds = [...store.selectedEventIds, ev.id];
    }
    return;
  }

  store.selectedEventIds = [ev.id];

  const now = Date.now();
  if (now - lastClickTime < 350 && lastClickedId === `ev:${ev.id}`) {
    store.openEditEventModal(ev);
  }
  lastClickTime = now;
  lastClickedId = `ev:${ev.id}`;
}

function handleGridContextMenu(e: MouseEvent) {
  if (store.isPublicShareMode) return;
  e.preventDefault();
  const target = e.target as HTMLElement | null;
  if (!target) return;

  const eventContentEl = target.closest<HTMLElement>('[data-dav-event-id]');
  if (eventContentEl) {
    const evId = eventContentEl.getAttribute('data-dav-event-id');
    const ev = evId ? store.events.find((item) => item.id === evId) : undefined;
    if (ev) {
      if (!store.selectedEventIds.includes(ev.id)) {
        store.selectedEventIds = [ev.id];
      }
      store.selectedDateStr = toDateOnlyString(new Date(ev.start));
      store.openContextMenu({
        x: e.clientX,
        y: e.clientY,
        targetType: 'EVENT',
        event: ev,
        dateStr: toDateOnlyString(new Date(ev.start))
      });
      return;
    }
  }

  const dateEl = target.closest<HTMLElement>('[data-date]');
  const dateStr = dateEl?.getAttribute('data-date') || store.selectedDateStr;
  if (dateStr) {
    store.selectedDateStr = dateStr;
  }

  store.openContextMenu({
    x: e.clientX,
    y: e.clientY,
    targetType: 'DATE',
    event: null,
    dateStr: dateStr || store.selectedDateStr,
    allDay: true
  });
}

async function handleEventDrop(arg: EventDropArg) {
  const ev = store.events.find((e) => e.id === arg.event.id) || (arg.event.extendedProps.rawEvent as CalendarEvent);
  if (!ev || store.isEventReadOnly(ev)) {
    arg.revert();
    store.notify(
      'Skrivebeskyttet kalender (Read-Only)',
      'Du kan ikke flytte begivenheder i en skrivebeskyttet kalender.',
      'error'
    );
    return;
  }

  const newStart = arg.event.start
    ? arg.event.allDay
      ? toDateOnlyString(arg.event.start)
      : arg.event.start.toISOString()
    : ev.start;
  const newEnd = arg.event.end
    ? arg.event.allDay
      ? toDateOnlyString(arg.event.end)
      : arg.event.end.toISOString()
    : newStart;

  await store.saveEvent({
    ...ev,
    start: newStart,
    end: newEnd,
    allDay: arg.event.allDay
  });
}

async function handleEventResize(arg: EventResizeDoneArg) {
  const ev = store.events.find((e) => e.id === arg.event.id) || (arg.event.extendedProps.rawEvent as CalendarEvent);
  if (!ev || store.isEventReadOnly(ev)) {
    arg.revert();
    store.notify(
      'Skrivebeskyttet kalender (Read-Only)',
      'Du kan ikke ændre varighed i en skrivebeskyttet kalender.',
      'error'
    );
    return;
  }

  const newStart = arg.event.start
    ? arg.event.allDay
      ? toDateOnlyString(arg.event.start)
      : arg.event.start.toISOString()
    : ev.start;
  const newEnd = arg.event.end
    ? arg.event.allDay
      ? toDateOnlyString(arg.event.end)
      : arg.event.end.toISOString()
    : ev.end;

  await store.saveEvent({
    ...ev,
    start: newStart,
    end: newEnd
  });
}

const calendarOptions = computed<CalendarOptions>(() => ({
  plugins: [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin],
  initialView,
  locale: 'da',
  firstDay: 1,
  weekNumbers: true,
  weekText: 'Uge ',
  headerToolbar: false,
  height: '100%',
  expandRows: false,
  fixedWeekCount: false,
  dayMaxEvents: 7,
  noEventsText: 'Ingen begivenheder i denne periode',
  eventDisplay: 'block',
  eventContent: renderEventContent,
  moreLinkText: (num: number) => `+ ${num} flere`,
  navLinks: false,
  editable: !store.isPublicShareMode,
  selectable: false,
  nowIndicator: true,
  slotMinTime: '06:00:00',
  slotMaxTime: '23:00:00',
  allDayText: 'Heldag',
  eventTimeFormat: {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  },
  slotLabelFormat: {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  },
  events: fcEvents.value,
  dateClick: handleDateClick,
  eventClick: handleEventClick,
  eventDrop: handleEventDrop,
  eventResize: handleEventResize,
  datesSet: (info) => {
    emit('title-change', info.view.title);
    void nextTick(updateSelectedDayHighlight);
  }
}));

function goPrev() {
  if (store.currentView === 'multiMonthYear') {
    yearViewYear.value -= 1;
    emit('title-change', String(yearViewYear.value));
    return;
  }
  const api = calendarRef.value?.getApi();
  if (api) {
    api.prev();
    emit('title-change', api.view.title);
    void nextTick(updateSelectedDayHighlight);
  }
}

function goNext() {
  if (store.currentView === 'multiMonthYear') {
    yearViewYear.value += 1;
    emit('title-change', String(yearViewYear.value));
    return;
  }
  const api = calendarRef.value?.getApi();
  if (api) {
    api.next();
    emit('title-change', api.view.title);
    void nextTick(updateSelectedDayHighlight);
  }
}

function goToday() {
  const now = new Date();
  store.selectedDateStr = toDateOnlyString(now);
  if (store.currentView === 'multiMonthYear') {
    yearViewYear.value = now.getFullYear();
    emit('title-change', String(yearViewYear.value));
    return;
  }
  const api = calendarRef.value?.getApi();
  if (api) {
    api.today();
    emit('title-change', api.view.title);
    void nextTick(updateSelectedDayHighlight);
  }
}

function changeView(viewName: CalendarViewType) {
  const prevView = store.currentView;
  store.currentView = viewName;

  if (viewName === 'multiMonthYear') {
    const api = calendarRef.value?.getApi();
    const currentDate = api?.getDate() || new Date(store.selectedDateStr || Date.now());
    yearViewYear.value = Number.isNaN(currentDate.getTime()) ? new Date().getFullYear() : currentDate.getFullYear();
    emit('title-change', String(yearViewYear.value));
    return;
  }

  const api = calendarRef.value?.getApi();
  if (api) {
    void nextTick(() => {
      api.changeView(viewName);
      if (prevView === 'multiMonthYear') {
        api.updateSize();
      }
      emit('title-change', api.view.title);
      void nextTick(updateSelectedDayHighlight);
    });
  }
}

function jumpToDate(dateIso: string) {
  if (store.currentView === 'multiMonthYear') {
    const d = new Date(dateIso);
    if (!Number.isNaN(d.getTime())) {
      yearViewYear.value = d.getFullYear();
      emit('title-change', String(yearViewYear.value));
    }
    return;
  }
  const api = calendarRef.value?.getApi();
  if (api) {
    api.gotoDate(dateIso);
    emit('title-change', api.view.title);
    void nextTick(updateSelectedDayHighlight);
  }
}

function handleYearOpenMonth(dateStr: string) {
  store.selectedDateStr = dateStr;
  store.currentView = 'dayGridMonth';
  const api = calendarRef.value?.getApi();
  if (api) {
    void nextTick(() => {
      api.changeView('dayGridMonth', dateStr);
      api.updateSize();
      emit('title-change', api.view.title);
      void nextTick(updateSelectedDayHighlight);
    });
  }
}

function handleYearOpenDay(dateStr: string) {
  store.selectedDateStr = dateStr;
  store.currentView = 'timeGridDay';
  const api = calendarRef.value?.getApi();
  if (api) {
    void nextTick(() => {
      api.changeView('timeGridDay', dateStr);
      api.updateSize();
      emit('title-change', api.view.title);
      void nextTick(updateSelectedDayHighlight);
    });
  }
}

function updateSize() {
  const api = calendarRef.value?.getApi();
  if (api) {
    api.updateSize();
  }
}

onMounted(() => {
  const api = calendarRef.value?.getApi();
  if (api) {
    emit('title-change', api.view.title);
  }
  void nextTick(updateSelectedDayHighlight);
});

defineExpose({
  goPrev,
  goNext,
  goToday,
  changeView,
  jumpToDate,
  updateSize
});
</script>

<template>
  <div
    ref="gridContainerRef"
    class="flex-1 h-full overflow-hidden relative transition-all duration-300"
    :class="currentTheme.wallpaper ? 'bg-transparent p-0' : 'bg-slate-950 p-3'"
    @click="store.closeContextMenu()"
    @contextmenu="handleGridContextMenu"
  >
    <!-- Valgt mål-dato & markering i toppen af gitteret (kun desktop) -->
    <div v-if="!store.isPublicShareMode && !isMobile" class="flex mb-2 items-center justify-between text-xs px-1 text-slate-400">
      <div class="flex items-center gap-3 flex-wrap">
        <span>
          Aktiv mål-dato (<kbd class="px-1 py-0.5 bg-slate-800 text-slate-200 rounded text-[10px]">Ctrl+V</kbd>):
          <strong class="text-blue-400 font-semibold ml-1">{{ store.selectedDateStr.slice(0, 10) }}</strong>
        </span>
        <span
          v-if="store.selectedEventIds.length > 0"
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/20 border border-blue-500/40 text-blue-300 font-medium text-[11px]"
        >
          <Check class="w-3 h-3" />
          {{ store.selectedEventIds.length }} begivenhed(er) valgt — tryk Ctrl+C for at kopiere
        </span>
        <span
          v-if="store.clipboard.events.length > 0"
          class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-semibold text-[11px]"
        >
          <Copy v-if="store.clipboard.mode === 'COPY'" class="w-3 h-3" />
          <Scissors v-else class="w-3 h-3" />
          {{ store.clipboard.events.length }} i udklipsholder ({{ store.clipboard.events[0]?.title }})
        </span>
      </div>

      <!-- Hurtig farve-forklaring over synlige kalendere -->
      <div class="hidden md:flex items-center gap-3 text-[11px] overflow-x-auto">
        <span
          v-for="cal in store.visibleCalendars"
          :key="cal.id"
          class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-900 border border-slate-800 text-slate-200 font-medium shrink-0"
        >
          <span
            class="w-2.5 h-2.5 rounded-sm shrink-0"
            :style="{ backgroundColor: cal.color }"
          ></span>
          <span class="truncate max-w-[120px]">{{ cal.name }}</span>
        </span>
      </div>
    </div>

    <div
      :class="[
        store.isPublicShareMode || isMobile ? 'h-full' : 'h-[calc(100%-28px)]',
        currentTheme.wallpaper
          ? 'rounded-2xl overflow-hidden border backdrop-blur-lg shadow-xl'
          : 'rounded-2xl overflow-hidden border border-slate-800 bg-slate-900/50 shadow-inner'
      ]"
      :style="
        currentTheme.wallpaper
          ? { backgroundColor: currentTheme.gridBg, borderColor: currentTheme.border }
          : undefined
      "
    >
      <YearView
        v-if="store.currentView === 'multiMonthYear'"
        :year="yearViewYear"
        @open-month="handleYearOpenMonth"
        @open-day="handleYearOpenDay"
      />
      <FullCalendar
        v-show="store.currentView !== 'multiMonthYear'"
        ref="calendarRef"
        :options="calendarOptions"
      />
    </div>
  </div>
</template>
