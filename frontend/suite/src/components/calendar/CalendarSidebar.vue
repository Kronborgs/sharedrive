<script setup lang="ts">
import {
  Lock,
  RotateCcw,
  Trash2,
  Clipboard,
  Scissors,
  Bell,
  ClipboardPaste,
  X,
  Clock,
  Plus,
  EyeOff,
  Share2,
  ArrowUpDown,
  Rss,
  Cake,
  Users,
  Pencil,
  Check,
  UserMinus,
  Search,
  UserPlus,
  Loader2,
  RefreshCw,
  Smartphone
} from 'lucide-vue-next';
import {
  useCalendarStore,
  BIRTHDAY_CALENDAR_ID
} from '../../stores/calendarStore';
import {
  useContactsStore,
  DEFAULT_CONTACT_CALENDAR_COLOR
} from '../../stores/contactsStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';
import { requestNotificationPermission } from '../../services/notifications';
import type {
  CalendarEvent,
  CalendarSource,
  SharedCalendarSearchResult
} from '../../types/calendar';
import { ref, computed, nextTick } from 'vue';

const props = defineProps<{
  width: number;
  mobileDrawer?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close-drawer'): void;
}>();

const store = useCalendarStore();
const contactsStore = useContactsStore();
const { isStandalonePwa, displayModeLabel } = useViewport();
const notifPermission = ref<string>(
  typeof window !== 'undefined' && 'Notification' in window
    ? Notification.permission
    : 'denied'
);

const { currentTheme } = useTheme();
const showNewCalendarForm = ref(false);
const addCalendarMode = ref<'SHARED' | 'CALDAV' | 'SUBSCRIBE'>('SUBSCRIBE');
const newCalendarName = ref('');
const newCalendarUrl = ref('');
const newCalendarColor = ref('#7c3aed');
const isCreatingCalendar = ref(false);

const sharedSearchQuery = ref('');
const sharedSearchResults = ref<SharedCalendarSearchResult[]>([]);
const isSearchingShared = ref(false);
const hasSearchedShared = ref(false);
const sharedSearchError = ref('');
const subscribingSharedUrl = ref<string | null>(null);
const showSharedSuggestions = ref(false);

const showLocalBirthdayCard = computed(
  () =>
    !store.isPublicShareMode &&
    contactsStore.contactsWithSpecialDatesCount > 0 &&
    !store.syncedBirthdayCalendar
);

const calendarSections = computed<Array<{ key: 'primary' | 'subscribed'; items: CalendarSource[] }>>(() => {
  const isSubscriptionGroup = (cal: CalendarSource) =>
    Boolean(cal.isSubscribed || cal.id.startsWith('sub::') || cal.isContactBirthdays);
  const primary = store.calendars
    .filter((c) => !isSubscriptionGroup(c))
    .sort((a, b) => a.name.localeCompare(b.name, 'da-DK'));
  const subscribed = store.calendars
    .filter((c) => isSubscriptionGroup(c))
    .sort((a, b) => {
      const aIsBday = Boolean(a.isContactBirthdays);
      const bIsBday = Boolean(b.isContactBirthdays);
      if (aIsBday !== bIsBday) return aIsBday ? 1 : -1;
      return a.name.localeCompare(b.name, 'da-DK');
    });

  const sections: Array<{ key: 'primary' | 'subscribed'; items: CalendarSource[] }> = [
    { key: 'primary', items: primary }
  ];
  if (subscribed.length > 0 || showLocalBirthdayCard.value) {
    sections.push({ key: 'subscribed', items: subscribed });
  }
  return sections;
});

const sharedContactSuggestions = computed(() => {
  if (!showSharedSuggestions.value) return [];
  const q = sharedSearchQuery.value.trim();
  if (!q) return [];
  return contactsStore.searchContactsForAutocomplete(q, 6);
});

function openSharedCalendarSearch() {
  if (showNewCalendarForm.value && addCalendarMode.value === 'SHARED') {
    showNewCalendarForm.value = false;
    return;
  }
  addCalendarMode.value = 'SHARED';
  showNewCalendarForm.value = true;
  if (!hasSearchedShared.value) {
    void runSharedCalendarSearch();
  }
}

function selectSharedTab() {
  addCalendarMode.value = 'SHARED';
  if (!hasSearchedShared.value) {
    void runSharedCalendarSearch();
  }
}

function selectSharedContactSuggestion(item: { name: string; email: string }) {
  sharedSearchQuery.value = item.email.trim();
  showSharedSuggestions.value = false;
  void runSharedCalendarSearch();
}

function handleSharedSearchBlur() {
  window.setTimeout(() => {
    showSharedSuggestions.value = false;
  }, 160);
}

async function runSharedCalendarSearch() {
  isSearchingShared.value = true;
  sharedSearchError.value = '';
  try {
    const q = sharedSearchQuery.value.trim();
    const matchedContacts = q
      ? contactsStore.searchContactsForAutocomplete(q, 6).map((c) => c.email)
      : [];
    sharedSearchResults.value = await store.searchSharedCalendars(q, matchedContacts);
  } catch (err: any) {
    sharedSearchError.value = err?.message || 'Kunne ikke søge efter delte kalendere i SOGo.';
    sharedSearchResults.value = [];
  } finally {
    hasSearchedShared.value = true;
    isSearchingShared.value = false;
  }
}

async function handleSubscribeShared(item: SharedCalendarSearchResult) {
  subscribingSharedUrl.value = item.url;
  try {
    await store.subscribeSharedCalendar(item);
  } finally {
    subscribingSharedUrl.value = null;
  }
}

function formatOutgoingShareTooltip(cal: CalendarSource): string {
  return store
    .getOutgoingSharesForCalendar(cal)
    .map(
      (s) =>
        `${s.recipientEmail} (${s.permission === 'write' ? 'Læs & Skriv' : 'Kun læsning'})`
    )
    .join('\n');
}

const editingCalId = ref<string | null>(null);
const renameDraft = ref('');
const renameOnServer = ref(false);
const isRenamingCalendar = ref(false);
const renameInputRef = ref<HTMLInputElement | HTMLInputElement[] | null>(null);

function startRenameCalendar(cal: CalendarSource) {
  if (editingCalId.value === cal.id) {
    cancelRenameCalendar();
    return;
  }
  editingCalId.value = cal.id;
  renameDraft.value = cal.name;
  renameOnServer.value = !cal.isShared && !cal.isSubscribed && !cal.id.startsWith('sub::');
  void nextTick(() => {
    const el = Array.isArray(renameInputRef.value)
      ? renameInputRef.value[0]
      : renameInputRef.value;
    el?.focus();
    el?.select();
  });
}

function cancelRenameCalendar() {
  editingCalId.value = null;
  renameDraft.value = '';
}

async function submitRenameCalendar(cal: CalendarSource) {
  isRenamingCalendar.value = true;
  try {
    const trimmed = renameDraft.value.trim();
    const ok = await store.setCalendarNameOverride(
      cal.id,
      trimmed || null,
      renameOnServer.value
    );
    if (ok) {
      cancelRenameCalendar();
    }
  } finally {
    isRenamingCalendar.value = false;
  }
}

async function resetCalendarName(cal: CalendarSource) {
  isRenamingCalendar.value = true;
  try {
    const ok = await store.setCalendarNameOverride(cal.id, null, false);
    if (ok) {
      cancelRenameCalendar();
    }
  } finally {
    isRenamingCalendar.value = false;
  }
}

async function confirmLeaveSharedCalendar(cal: CalendarSource) {
  const ownerSuffix = cal.owner ? ` (delt af ${cal.owner})` : '';
  const ok = window.confirm(
    `Vil du forlade den delte kalender "${cal.name}"${ownerSuffix}?\n\nDine adgangsrettigheder fjernes, og kalenderen forsvinder fra din oversigt.`
  );
  if (ok) {
    await store.leaveSharedCalendar(cal.id);
  }
}

async function submitNewCalendar() {
  isCreatingCalendar.value = true;
  try {
    if (addCalendarMode.value === 'SUBSCRIBE') {
      const sub = await store.subscribeToCalendar(
        newCalendarUrl.value,
        newCalendarName.value || undefined,
        newCalendarColor.value
      );
      if (sub) {
        newCalendarName.value = '';
        newCalendarUrl.value = '';
        showNewCalendarForm.value = false;
      }
      return;
    }

    const created = await store.createCalendar(
      newCalendarName.value,
      newCalendarColor.value,
      newCalendarUrl.value || undefined
    );
    if (created) {
      newCalendarName.value = '';
      newCalendarUrl.value = '';
      showNewCalendarForm.value = false;
    }
  } finally {
    isCreatingCalendar.value = false;
  }
}

async function quickSubscribeDanishHolidays() {
  isCreatingCalendar.value = true;
  try {
    const sub = await store.subscribeToCalendar(
      'builtin://dk-holidays',
      'Danske Helligdage',
      '#e11d48'
    );
    if (sub) {
      showNewCalendarForm.value = false;
    }
  } finally {
    isCreatingCalendar.value = false;
  }
}

async function confirmDeleteCalendar(calId: string, name: string, isSubscribed = false) {
  const promptText = isSubscribed
    ? `Vil du afmelde abonnementet på "${name}"?\n\nKalenderen fjernes fra din oversigt.`
    : `Slet kalenderen "${name}" permanent?\n\nAlle begivenheder i kalenderen slettes også på serveren. Dette kan ikke fortrydes.`;
  const ok = window.confirm(promptText);
  if (ok) {
    await store.deleteCalendar(calId);
  }
}

async function confirmDisableBirthdaySync(cal: CalendarSource) {
  const ok = window.confirm(
    `Fjern "${cal.name}" fra Mailcow?\n\nKalenderen fjernes fra Mailcow (og dermed fra telefon/Thunderbird), og vises i stedet kun lokalt i Sharedrive.`
  );
  if (ok) {
    await store.disableBirthdaysMailcowSync(true);
  }
}

async function enableNotifications() {
  const perm = await requestNotificationPermission();
  notifPermission.value = perm;
  if (perm === 'granted') {
    store.notify('Browser-notifikationer aktiveret', 'Du får nu OS-påmindelser ved VALARM.', 'success');
  } else {
    store.notify('Notifikationer afvist', 'Tillad notifikationer i din browsers adresselinje.', 'warning');
  }
}

function handleColorChange(calId: string, event: Event) {
  const input = event.target as HTMLInputElement;
  if (input?.value) {
    void store.setCalendarColorOverride(calId, input.value);
  }
}

function formatEventTimeSpan(ev: CalendarEvent): string {
  const startDt = new Date(ev.start);
  const datePart = startDt.toLocaleDateString('da-DK', {
    weekday: 'short',
    day: '2-digit',
    month: 'short'
  });
  if (ev.allDay) {
    return `${datePart} • Heldag`;
  }
  const startTime = startDt.toLocaleTimeString('da-DK', {
    hour: '2-digit',
    minute: '2-digit'
  });
  const endDt = new Date(ev.end || ev.start);
  const endTime = endDt.toLocaleTimeString('da-DK', {
    hour: '2-digit',
    minute: '2-digit'
  });
  return `${datePart} • ${startTime} - ${endTime}`;
}

function removeSingleClipboardEvent(evId: string) {
  const remaining = store.clipboard.events.filter((e) => e.id !== evId);
  if (remaining.length === 0) {
    store.clearClipboard();
  } else {
    store.clipboard.events = remaining;
  }
}
</script>

<template>
  <aside
    class="flex flex-col justify-between p-3.5 select-none overflow-y-auto shrink-0 h-full transition-all duration-300"
    :class="
      currentTheme.wallpaper
        ? 'rounded-2xl border backdrop-blur-xl shadow-lg'
        : 'bg-slate-900/90'
    "
    :style="{
      width: props.mobileDrawer ? '100%' : `${props.width}px`,
      ...(currentTheme.wallpaper
        ? { backgroundColor: currentTheme.surface, borderColor: currentTheme.border }
        : {})
    }"
  >
    <!-- Top: Kalendere -->
    <div class="space-y-4">
      <div>
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-400 truncate">
            {{ store.isPublicShareMode ? 'Delte Kalendere' : 'Kalendere' }}
          </h2>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="text-[11px] text-slate-500">
              {{ store.calendars.length }}
            </span>
            <button
              v-if="props.mobileDrawer"
              type="button"
              class="p-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition"
              title="Luk kalenderpanel"
              @click="emit('close-drawer')"
            >
              <X class="w-3.5 h-3.5" />
            </button>
            <button
              v-if="!store.isPublicShareMode"
              type="button"
              class="p-1 rounded-md border transition"
              :class="
                showNewCalendarForm && addCalendarMode === 'SHARED'
                  ? 'bg-blue-600 text-white border-blue-500'
                  : 'bg-slate-800 hover:bg-blue-600 text-slate-300 hover:text-white border-slate-700'
              "
              title="Søg og tilføj delt kalender fra en anden bruger"
              @click="openSharedCalendarSearch"
            >
              <Search class="w-3.5 h-3.5" />
            </button>
            <button
              v-if="!store.isPublicShareMode"
              type="button"
              class="p-1 rounded-md bg-slate-800 hover:bg-blue-600 text-slate-300 hover:text-white border border-slate-700 transition"
              title="Tilføj eller opret ny kalender"
              @click="showNewCalendarForm = !showNewCalendarForm"
            >
              <Plus class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <!-- Diskret valg af aktiv kalender til nye aftaler & indsæt -->
        <div
          v-if="!store.isPublicShareMode && store.writableCalendars.length > 1"
          class="mb-2 flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-950/60 border border-slate-800/80"
          title="Mål-kalender når du opretter ny aftale eller bruger Ctrl+V"
        >
          <span class="text-[10.5px] text-slate-400 shrink-0">Skriv i:</span>
          <select
            v-model="store.activeTargetCalendarId"
            aria-label="Aktiv kalender til nye aftaler"
            class="flex-1 min-w-0 bg-transparent text-[11px] font-medium text-slate-200 focus:outline-none cursor-pointer truncate"
          >
            <option
              v-for="wCal in store.writableCalendars"
              :key="wCal.id"
              :value="wCal.id"
              class="bg-slate-900 text-slate-100"
            >
              {{ wCal.isShared && wCal.owner ? `${wCal.name} (${wCal.owner})` : wCal.name }}
            </option>
          </select>
        </div>

        <div
          v-if="showNewCalendarForm && !store.isPublicShareMode"
          class="mb-2.5 p-2.5 rounded-xl bg-slate-950 border border-blue-500/40 space-y-2"
        >
          <div class="grid grid-cols-3 gap-1 p-0.5 rounded-lg bg-slate-900 border border-slate-800 text-[10px] font-semibold">
            <button
              type="button"
              class="py-1 px-1 rounded-md transition truncate"
              :class="addCalendarMode === 'SHARED' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'"
              @click="selectSharedTab"
            >
              Delt
            </button>
            <button
              type="button"
              class="py-1 px-1 rounded-md transition truncate"
              :class="addCalendarMode === 'SUBSCRIBE' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'"
              @click="addCalendarMode = 'SUBSCRIBE'"
            >
              iCal (.ics)
            </button>
            <button
              type="button"
              class="py-1 px-1 rounded-md transition truncate"
              :class="addCalendarMode === 'CALDAV' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'"
              @click="addCalendarMode = 'CALDAV'"
            >
              Opret / DAV
            </button>
          </div>

          <div v-if="addCalendarMode === 'SHARED'" class="space-y-2">
            <form class="space-y-1.5" @submit.prevent="runSharedCalendarSearch">
              <div class="text-[10px] text-slate-400 leading-tight">
                Søg på en kollegas navn eller e-mail i Mailcow/SOGo (f.eks. <code class="text-slate-300">bruger@domæne.dk</code>):
              </div>

              <div class="relative flex items-center gap-1">
                <input
                  v-model="sharedSearchQuery"
                  type="text"
                  autocomplete="off"
                  placeholder="Navn eller bruger@domæne.dk..."
                  class="flex-1 min-w-0 px-2.5 py-1.5 text-[11px] bg-slate-900 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  @focus="showSharedSuggestions = true"
                  @blur="handleSharedSearchBlur"
                />
                <button
                  type="submit"
                  :disabled="isSearchingShared"
                  class="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[11px] font-semibold inline-flex items-center gap-1 shrink-0 transition"
                >
                  <Loader2 v-if="isSearchingShared" class="w-3 h-3 animate-spin" />
                  <Search v-else class="w-3 h-3" />
                  <span>Søg</span>
                </button>

                <div
                  v-if="sharedContactSuggestions.length > 0"
                  class="absolute left-0 right-0 top-full mt-1 rounded-lg bg-slate-900 border border-slate-700 shadow-2xl max-h-36 overflow-y-auto z-40 divide-y divide-slate-800"
                >
                  <button
                    v-for="item in sharedContactSuggestions"
                    :key="item.email"
                    type="button"
                    class="w-full px-2.5 py-1.5 text-left hover:bg-slate-800 flex items-center justify-between gap-1.5 transition"
                    @mousedown.prevent="selectSharedContactSuggestion(item)"
                  >
                    <span class="text-[11px] font-medium text-slate-100 truncate">{{ item.name }}</span>
                    <span class="text-[10px] text-slate-400 truncate">{{ item.email }}</span>
                  </button>
                </div>
              </div>
            </form>

            <div
              v-if="sharedSearchError"
              class="p-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[10.5px] text-rose-200"
            >
              {{ sharedSearchError }}
            </div>

            <div
              v-else-if="isSearchingShared && sharedSearchResults.length === 0"
              class="p-3 text-center rounded-lg bg-slate-900/70 border border-slate-800 text-[10.5px] text-slate-400 flex items-center justify-center gap-1.5"
            >
              <Loader2 class="w-3.5 h-3.5 animate-spin text-blue-400" />
              <span>Søger i Mailcow/SOGo...</span>
            </div>

            <div
              v-else-if="sharedSearchResults.length > 0"
              class="space-y-1.5 max-h-48 overflow-y-auto pr-0.5"
            >
              <div
                v-for="item in sharedSearchResults"
                :key="item.url"
                class="p-2 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between gap-2"
              >
                <div class="min-w-0 flex-1 space-y-0.5">
                  <div class="flex items-center gap-1.5">
                    <span
                      class="w-2 h-2 rounded-full shrink-0"
                      :style="{ backgroundColor: item.color }"
                    ></span>
                    <span class="text-[11px] font-semibold text-slate-100 truncate">
                      {{ item.name }}
                    </span>
                  </div>
                  <div class="text-[10px] text-slate-400 truncate">
                    Delt af {{
                      item.ownerDisplayName && item.owner && item.ownerDisplayName !== item.owner
                        ? `${item.ownerDisplayName} (${item.owner})`
                        : item.owner || 'bruger'
                    }}
                  </div>
                  <div>
                    <span
                      class="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold border"
                      :class="
                        item.sharePermission === 'write'
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                          : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      "
                    >
                      {{ item.sharePermission === 'write' ? 'Læs & Skriv' : 'Kun læsning' }}
                    </span>
                  </div>
                </div>

                <span
                  v-if="store.isSharedCalendarAlreadyAdded(item)"
                  class="px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold inline-flex items-center gap-1 shrink-0"
                >
                  <Check class="w-3 h-3" />
                  <span>Tilføjet</span>
                </span>
                <button
                  v-else
                  type="button"
                  :disabled="subscribingSharedUrl === item.url"
                  class="px-2 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[10.5px] font-semibold inline-flex items-center gap-1 shrink-0 transition"
                  @click="handleSubscribeShared(item)"
                >
                  <Loader2 v-if="subscribingSharedUrl === item.url" class="w-3 h-3 animate-spin" />
                  <UserPlus v-else class="w-3 h-3" />
                  <span>Tilføj</span>
                </button>
              </div>
            </div>

            <div
              v-else-if="hasSearchedShared && !isSearchingShared"
              class="p-2.5 rounded-lg bg-slate-900/70 border border-slate-800 text-[10.5px] text-slate-400 leading-snug"
            >
              Ingen delte kalendere fundet. Prøv hele e-mailadressen (f.eks. <code class="text-slate-300">bruger@domæne.dk</code>) og tjek at ejeren har delt kalenderen med dig i SOGo.
            </div>

            <div class="flex items-center justify-end">
              <button
                type="button"
                class="px-2 py-1 rounded-lg text-[11px] text-slate-300 hover:bg-slate-800"
                @click="showNewCalendarForm = false"
              >
                Luk
              </button>
            </div>
          </div>

          <form v-else class="space-y-2" @submit.prevent="submitNewCalendar">
            <template v-if="addCalendarMode === 'SUBSCRIBE'">
              <button
                type="button"
                :disabled="isCreatingCalendar"
                class="w-full py-1.5 px-2 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/40 text-rose-200 text-[11px] font-semibold flex items-center justify-center gap-1.5 transition disabled:opacity-50"
                @click="quickSubscribeDanishHolidays"
              >
                <svg class="w-4 h-3 rounded-[2px] shrink-0 shadow-sm" viewBox="0 0 28 20" xmlns="http://www.w3.org/2000/svg">
                  <rect width="28" height="20" fill="#c8102e" />
                  <rect x="8" y="0" width="3.5" height="20" fill="#ffffff" />
                  <rect x="0" y="8.25" width="28" height="3.5" fill="#ffffff" />
                </svg>
                <span>Tilføj Danske Helligdage (1-klik)</span>
              </button>

              <div class="text-[10px] text-slate-400 leading-tight pt-0.5">
                Eller indsæt iCal / <code class="text-slate-300">.ics</code> / <code class="text-slate-300">webcal://</code> link fra Google, Microsoft Outlook eller Apple iCloud:
              </div>

              <div>
                <input
                  v-model="newCalendarUrl"
                  type="text"
                  placeholder="https://... eller webcal://... (.ics)"
                  class="w-full px-2.5 py-1.5 text-[11px] bg-slate-900 border border-slate-700 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div class="flex items-center gap-2">
                <input
                  v-model="newCalendarName"
                  type="text"
                  placeholder="Valgfrit navn (hentes ellers automatisk)..."
                  class="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-blue-500"
                />
                <input
                  v-model="newCalendarColor"
                  type="color"
                  class="w-7 h-7 rounded-lg bg-transparent border border-slate-700 cursor-pointer shrink-0"
                  title="Vælg farve"
                />
              </div>
            </template>

            <template v-else>
              <div class="flex items-center gap-2">
                <input
                  v-model="newCalendarName"
                  type="text"
                  placeholder="Kalendernavn..."
                  class="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-blue-500"
                />
                <input
                  v-model="newCalendarColor"
                  type="color"
                  class="w-7 h-7 rounded-lg bg-transparent border border-slate-700 cursor-pointer shrink-0"
                  title="Vælg farve"
                />
              </div>
              <div>
                <input
                  v-model="newCalendarUrl"
                  type="text"
                  placeholder="Valgfri CalDAV URL..."
                  class="w-full px-2.5 py-1.5 text-[11px] bg-slate-900 border border-slate-700 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            </template>

            <div class="flex items-center justify-end gap-1.5">
              <button
                type="button"
                class="px-2 py-1 rounded-lg text-[11px] text-slate-300 hover:bg-slate-800"
                @click="showNewCalendarForm = false"
              >
                Annullér
              </button>
              <button
                type="submit"
                :disabled="isCreatingCalendar"
                class="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
              >
                {{
                  isCreatingCalendar
                    ? 'Henter...'
                    : addCalendarMode === 'SUBSCRIBE'
                      ? 'Abonnér'
                      : newCalendarUrl
                        ? 'Tilføj link'
                        : 'Opret ny'
                }}
              </button>
            </div>
          </form>
        </div>

        <div class="space-y-1.5">
          <template v-for="section in calendarSections" :key="section.key">
            <div
              v-if="section.key === 'subscribed'"
              class="pt-2.5 mt-2.5 border-t border-slate-800/80 flex items-center justify-between px-0.5"
            >
              <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                Abonnementer
              </span>
              <span class="text-[10px] text-slate-500">
                {{ section.items.length + (showLocalBirthdayCard ? 1 : 0) }}
              </span>
            </div>

            <div
              v-for="cal in section.items"
              :key="cal.id"
            class="group p-2 rounded-xl border transition space-y-1.5"
            :class="cal.visible
              ? 'bg-slate-800/60 border-slate-700/70'
              : 'bg-slate-900/40 border-slate-800/50 opacity-60'"
          >
            <div class="flex items-center justify-between gap-1.5">
              <label class="flex items-center gap-2 min-w-0 cursor-pointer flex-1">
                <input
                  type="checkbox"
                  :checked="cal.visible"
                  class="rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-0 cursor-pointer shrink-0"
                  @change="store.toggleCalendarVisibility(cal.id)"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1">
                    <Cake
                      v-if="cal.isContactBirthdays"
                      class="w-3 h-3 shrink-0"
                      :style="{ color: cal.color }"
                    />
                    <span
                      class="text-xs font-medium text-slate-100 truncate"
                      :title="
                        cal.localNameOverride && cal.serverName && cal.localNameOverride !== cal.serverName
                          ? `${cal.name} (Original: ${cal.serverName})`
                          : cal.name
                      "
                    >
                      {{ cal.name }}
                    </span>
                    <span
                      v-if="cal.isSubscribed || cal.id.startsWith('sub::')"
                      class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[9px] font-semibold shrink-0"
                      title="Abonneret kalender (opdateres automatisk, skrivebeskyttet)"
                    >
                      <Rss class="w-2.5 h-2.5" />
                    </span>
                    <span
                      v-else-if="cal.readOnly && !cal.isContactBirthdays"
                      class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[9px] font-semibold shrink-0"
                      title="Skrivebeskyttet kalender (Read-Only)"
                    >
                      <Lock class="w-2.5 h-2.5" />
                    </span>
                    <span
                      v-else-if="cal.isShared"
                      class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 text-[9px] font-semibold shrink-0"
                      title="Delt kalender (Skrivbar)"
                    >
                      <Users class="w-2.5 h-2.5" />
                    </span>
                  </div>
                  <div v-if="cal.isContactBirthdays" class="text-[10px] text-slate-400 truncate">
                    Auto-synk fra Kontakter
                  </div>
                  <div v-else-if="cal.isSubscribed || cal.id.startsWith('sub::')" class="text-[10px] text-slate-400 truncate">
                    {{ cal.owner || 'Kalender-abonnement' }}
                  </div>
                  <div v-else-if="cal.isShared || cal.owner" class="text-[10px] text-slate-400 truncate">
                    Delt af {{ cal.owner || 'ejer' }} • {{ cal.readOnly ? 'Kun læsning' : 'Skrivbar' }}
                  </div>
                  <div
                    v-else-if="store.getOutgoingSharesForCalendar(cal).length > 0"
                    class="mt-0.5"
                  >
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/30 text-[9.5px] text-blue-300 font-medium transition max-w-full"
                      :title="formatOutgoingShareTooltip(cal)"
                      @click.stop.prevent="store.openShareModal(cal.id)"
                    >
                      <Users class="w-2.5 h-2.5 shrink-0" />
                      <span class="truncate">
                        Delt med {{ store.getOutgoingSharesForCalendar(cal).length }}
                        {{ store.getOutgoingSharesForCalendar(cal).length === 1 ? 'bruger' : 'brugere' }}
                      </span>
                    </button>
                  </div>
                </div>
              </label>

              <div class="flex items-center gap-0.5 shrink-0">
                <template v-if="!store.isPublicShareMode">
                  <button
                    type="button"
                    class="p-1 rounded hover:bg-slate-700 transition"
                    :class="editingCalId === cal.id ? 'bg-slate-700 text-blue-300' : 'text-slate-400 hover:text-slate-100'"
                    title="Omdøb kalender / giv alias-navn"
                    @click="startRenameCalendar(cal)"
                  >
                    <Pencil class="w-3 h-3" />
                  </button>
                  <button
                    v-if="!cal.isShared && !cal.isSubscribed && !cal.id.startsWith('sub::')"
                    type="button"
                    class="p-1 rounded hover:bg-blue-500/20 text-slate-400 hover:text-blue-300 transition"
                    title="Del kalender med brugere (læs/skriv) eller offentligt link"
                    @click="store.openShareModal(cal.id)"
                  >
                    <Share2 class="w-3 h-3" />
                  </button>
                  <button
                    v-if="cal.isShared && !cal.isSubscribed && !cal.id.startsWith('sub::')"
                    type="button"
                    class="p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition"
                    title="Forlad delt kalender og fjern mine rettigheder"
                    @click="confirmLeaveSharedCalendar(cal)"
                  >
                    <UserMinus class="w-3 h-3" />
                  </button>
                  <button
                    v-if="(!cal.readOnly && !cal.isShared) || cal.isSubscribed || cal.id.startsWith('sub::') || cal.isContactBirthdays"
                    type="button"
                    class="p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition"
                    :title="
                      cal.isContactBirthdays
                        ? 'Fjern fødselsdagskalender fra Mailcow og stop synk'
                        : cal.isSubscribed || cal.id.startsWith('sub::')
                          ? 'Afmeld kalender-abonnement'
                          : 'Slet kalender (inkl. alle begivenheder)'
                    "
                    @click="
                      cal.isContactBirthdays
                        ? confirmDisableBirthdaySync(cal)
                        : confirmDeleteCalendar(cal.id, cal.name, Boolean(cal.isSubscribed || cal.id.startsWith('sub::')))
                    "
                  >
                    <Trash2 class="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    class="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition"
                    title="Skjul midlertidigt fra listen"
                    @click="store.hideCalendar(cal.id)"
                  >
                    <EyeOff class="w-3 h-3" />
                  </button>
                </template>

                <button
                  v-if="cal.localColorOverride && cal.localColorOverride !== cal.serverColor"
                  type="button"
                  class="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition"
                  title="Gendan serverfarve"
                  @click="store.setCalendarColorOverride(cal.id, null)"
                >
                  <RotateCcw class="w-3 h-3" />
                </button>
                <label
                  class="w-4 h-4 rounded-full border border-white/20 cursor-pointer flex items-center justify-center overflow-hidden shadow-inner ml-0.5"
                  :style="{ backgroundColor: cal.color }"
                  title="Klik for at ændre kalenderfarve (synkroniseres med Mailcow/SOGo)"
                >
                  <input
                    type="color"
                    :value="cal.color"
                    class="opacity-0 w-0 h-0"
                    @input="handleColorChange(cal.id, $event)"
                  />
                </label>
              </div>
            </div>

            <form
              v-if="editingCalId === cal.id && !store.isPublicShareMode"
              class="pt-2 border-t border-slate-700/60 space-y-1.5"
              @submit.prevent="submitRenameCalendar(cal)"
            >
              <div class="flex items-center gap-1">
                <input
                  ref="renameInputRef"
                  v-model="renameDraft"
                  type="text"
                  maxlength="80"
                  placeholder="F.eks. Annes kalender..."
                  class="flex-1 min-w-0 px-2 py-1 text-xs bg-slate-950 border border-slate-700 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  @keydown.escape.prevent="cancelRenameCalendar"
                />
                <button
                  type="submit"
                  :disabled="isRenamingCalendar"
                  class="p-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white transition disabled:opacity-50 shrink-0"
                  title="Gem navn"
                >
                  <Check class="w-3 h-3" />
                </button>
                <button
                  type="button"
                  class="p-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 transition shrink-0"
                  title="Annullér"
                  @click="cancelRenameCalendar"
                >
                  <X class="w-3 h-3" />
                </button>
              </div>

              <label
                v-if="!cal.isShared && !cal.isSubscribed && !cal.id.startsWith('sub::')"
                class="flex items-center gap-1.5 text-[10.5px] text-slate-300 cursor-pointer"
              >
                <input
                  v-model="renameOnServer"
                  type="checkbox"
                  class="rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-0 cursor-pointer shrink-0"
                />
                <span>Omdøb også på Mailcow/SOGo</span>
              </label>
              <div
                v-else
                class="text-[10px] text-slate-400 leading-tight"
              >
                Personligt alias-navn (synkroniseres på dine enheder)
              </div>

              <button
                v-if="cal.localNameOverride && cal.serverName && cal.localNameOverride !== cal.serverName"
                type="button"
                :disabled="isRenamingCalendar"
                class="w-full py-1 px-2 rounded-md bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-[10.5px] text-slate-300 flex items-center justify-center gap-1 transition disabled:opacity-50"
                @click="resetCalendarName(cal)"
              >
                <RotateCcw class="w-2.5 h-2.5 shrink-0" />
                <span class="truncate">Gendan originalt navn ({{ cal.serverName }})</span>
              </button>
            </form>
          </div>

          <!-- Automatisk Fødselsdags- & Mærkedagskalender fra Sharedrive Kontakter (CardDAV) -->
          <div
            v-if="section.key === 'subscribed' && showLocalBirthdayCard"
            class="p-2 rounded-xl border transition space-y-2"
            :class="store.showContactBirthdays
              ? 'bg-slate-800/60 border-slate-700/70'
              : 'bg-slate-900/40 border-slate-800/50 opacity-60'"
          >
            <div class="flex items-center justify-between gap-1.5">
              <label class="flex items-center gap-2 min-w-0 cursor-pointer flex-1">
                <input
                  type="checkbox"
                  :checked="store.showContactBirthdays"
                  class="rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-0 cursor-pointer shrink-0"
                  @change="store.toggleContactBirthdays()"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1">
                    <Cake
                      class="w-3 h-3 shrink-0"
                      :style="{ color: contactsStore.contactCalendarColor }"
                    />
                    <span class="text-xs font-medium text-slate-100 truncate">
                      {{
                        contactsStore.contactsWithAnniversariesCount > 0
                          ? 'Fødselsdage & Mærkedage'
                          : 'Fødselsdage'
                      }}
                    </span>
                  </div>
                  <div class="text-[10px] text-slate-400 truncate">
                    {{ contactsStore.contactsWithSpecialDatesCount }} kontakt(er) med datoer
                  </div>
                </div>
              </label>

              <div class="flex items-center gap-0.5 shrink-0">
                <button
                  v-if="contactsStore.contactCalendarColor.toLowerCase() !== DEFAULT_CONTACT_CALENDAR_COLOR"
                  type="button"
                  class="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition"
                  title="Gendan standardfarve"
                  @click="store.setCalendarColorOverride(BIRTHDAY_CALENDAR_ID, null)"
                >
                  <RotateCcw class="w-3 h-3" />
                </button>
                <label
                  class="w-4 h-4 rounded-full border border-white/20 cursor-pointer flex items-center justify-center overflow-hidden shadow-inner ml-0.5"
                  :style="{ backgroundColor: contactsStore.contactCalendarColor }"
                  title="Klik for at skifte kalenderfarve på fødselsdage og mærkedage"
                >
                  <input
                    type="color"
                    :value="contactsStore.contactCalendarColor"
                    class="opacity-0 w-0 h-0"
                    @input="handleColorChange(BIRTHDAY_CALENDAR_ID, $event)"
                  />
                </label>
              </div>
            </div>

            <button
              type="button"
              :disabled="store.isSyncingBirthdaysToMailcow || !store.isOnline"
              class="w-full py-1.5 px-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-[10.5px] font-semibold text-emerald-200 flex items-center justify-center gap-1.5 transition disabled:opacity-50"
              title="Opretter kalenderen direkte på Mailcow/SOGo så telefon (iOS/Android) og Thunderbird får den med"
              @click="store.syncBirthdaysToMailcow()"
            >
              <RefreshCw class="w-3 h-3 shrink-0" :class="store.isSyncingBirthdaysToMailcow ? 'animate-spin' : ''" />
              <span class="truncate">
                {{
                  store.isSyncingBirthdaysToMailcow
                    ? 'Synkroniserer...'
                    : 'Sync til Mailcow'
                }}
              </span>
            </button>
          </div>
          </template>
        </div>

        <button
          v-if="!store.isPublicShareMode && store.hiddenCalendarIds.length > 0"
          type="button"
          class="mt-2 w-full py-1 px-2 rounded-lg bg-slate-800/60 hover:bg-slate-800 border border-slate-700/70 text-[11px] text-slate-300 flex items-center justify-center gap-1.5 transition"
          @click="store.restoreHiddenCalendars()"
        >
          <RotateCcw class="w-3 h-3" />
          Vis {{ store.hiddenCalendarIds.length }} skjult(e) igen
        </button>

        <button
          v-if="!store.isPublicShareMode && store.dismissedSharedCount > 0"
          type="button"
          class="mt-1.5 w-full py-1 px-2 rounded-lg bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/35 text-[11px] text-blue-200 flex items-center justify-center gap-1.5 transition"
          @click="store.restoreDismissedSharedCalendars()"
        >
          <RotateCcw class="w-3 h-3" />
          Vis {{ store.dismissedSharedCount }} forladt(e) delt(e) kalender(e) igen
        </button>
      </div>

      <div
        v-if="store.isPublicShareMode"
        class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-1.5 text-xs text-amber-200"
      >
        <div class="flex items-center gap-1.5 font-semibold">
          <Lock class="w-4 h-4 text-amber-400 shrink-0" />
          <span class="truncate">Kun visning (Read-Only)</span>
        </div>
        <p class="text-[11px] text-slate-300 leading-relaxed">
          Du ser en offentligt delt kalender. Klik på en aftale for at se detaljer.
        </p>
      </div>
    </div>

    <!-- Bund: Udklipsholder + Del kalender + Papirkurv & Notifikationer -->
    <div v-if="!store.isPublicShareMode" class="space-y-2.5 pt-3 border-t border-slate-800">
      <div
        v-if="store.clipboard.events.length > 0"
        class="p-3 rounded-xl border transition-all space-y-2 bg-emerald-950/20 border-emerald-500/50 shadow-lg shadow-emerald-950/20"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1.5 text-xs font-bold text-slate-100 truncate">
            <Clipboard v-if="store.clipboard.mode !== 'CUT'" class="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <Scissors v-else class="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span class="truncate">Udklipsholder</span>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            <span
              class="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
              :class="store.clipboard.mode === 'CUT'
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'"
            >
              {{ store.clipboard.mode === 'CUT' ? 'KLIP' : 'KOPI' }} ({{ store.clipboard.events.length }})
            </span>
            <button
              type="button"
              class="p-0.5 rounded hover:bg-slate-800 text-slate-400 hover:text-rose-400 transition"
              title="Tøm udklipsholder"
              @click="store.clearClipboard()"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div class="space-y-2">
          <div class="max-h-40 overflow-y-auto space-y-1.5 pr-0.5">
            <div
              v-for="ev in store.clipboard.events"
              :key="ev.id"
              class="p-2 rounded-lg bg-slate-900/95 border border-slate-700/80 flex items-start justify-between gap-1.5"
            >
              <div class="flex items-start gap-2 min-w-0">
                <span
                  class="w-2 h-2 rounded-full shrink-0 mt-1"
                  :style="{ backgroundColor: store.getCalendarById(ev.calendarId)?.color || '#10b981' }"
                ></span>
                <div class="min-w-0">
                  <div class="text-xs font-semibold text-slate-100 truncate" :title="ev.title">
                    {{ ev.title }}
                  </div>
                  <div class="flex items-center gap-1 text-[10px] text-slate-400 mt-0.5">
                    <Clock class="w-2.5 h-2.5 shrink-0" />
                    <span class="truncate">{{ formatEventTimeSpan(ev) }}</span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                class="text-slate-500 hover:text-rose-400 p-0.5 shrink-0"
                title="Fjern fra udklipsholder"
                @click="removeSingleClipboardEvent(ev.id)"
              >
                <X class="w-3 h-3" />
              </button>
            </div>
          </div>

          <div class="pt-1.5 border-t border-slate-800/90 space-y-1.5">
            <div class="flex items-center justify-between text-[11px]">
              <span class="text-slate-400">Mål-dato:</span>
              <strong class="text-blue-400 font-semibold">{{ store.selectedDateStr.slice(0, 10) }}</strong>
            </div>
            <button
              type="button"
              class="w-full py-1.5 px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow transition"
              @click="store.pasteToDate()"
            >
              <ClipboardPaste class="w-3.5 h-3.5 shrink-0" />
              <span class="truncate">Indsæt her (Ctrl+V)</span>
            </button>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          class="flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl bg-blue-600/15 hover:bg-blue-600/25 border border-blue-500/30 text-xs text-blue-300 font-semibold transition"
          title="Del kalender med brugere (Læs/Skriv) eller offentligt link"
          @click="store.openShareModal()"
        >
          <Share2 class="w-3.5 h-3.5 shrink-0" />
          <span class="truncate">Del kalender</span>
        </button>

        <button
          type="button"
          class="flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl bg-slate-800/80 hover:bg-slate-800 border border-slate-700/80 text-xs text-slate-200 font-semibold transition"
          title="Importér eller eksportér kalender (.ics)"
          @click="store.openImportExportModal()"
        >
          <ArrowUpDown class="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span class="truncate">Import/Eksport</span>
        </button>
      </div>

      <div class="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          class="flex items-center justify-between px-2 py-2 rounded-xl bg-slate-800/70 hover:bg-slate-800 border border-slate-700/70 text-xs text-slate-200 transition"
          title="Åbn 30-dages papirkurv"
          @click="store.isTrashModalOpen = true"
        >
          <span class="flex items-center gap-1.5 font-medium truncate">
            <Trash2 class="w-3.5 h-3.5 text-rose-400 shrink-0" />
            <span class="truncate">Papirkurv</span>
          </span>
          <span class="px-1.5 py-0.5 rounded-full bg-slate-900 text-slate-300 text-[10px] font-semibold shrink-0">
            {{ store.trashItems.length }}
          </span>
        </button>

        <button
          type="button"
          class="flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-xs text-rose-300 font-semibold transition"
          title="Bulk-oprydning: Find og slet gamle begivenheder før en valgt dato"
          @click="store.isBulkDeleteModalOpen = true"
        >
          <Trash2 class="w-3.5 h-3.5 shrink-0" />
          <span class="truncate">Slet gamle</span>
        </button>
      </div>

      <button
        v-if="notifPermission !== 'granted'"
        type="button"
        class="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-800/50 hover:bg-slate-800 border border-slate-700/60 text-[11px] text-slate-300 transition"
        @click="enableNotifications"
      >
        <Bell class="w-3.5 h-3.5 shrink-0" />
        <span class="truncate">Aktivér påmindelser</span>
      </button>

      <div
        v-if="props.mobileDrawer"
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
</template>
