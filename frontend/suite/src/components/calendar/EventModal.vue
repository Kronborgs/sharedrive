<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  X,
  MapPin,
  Video,
  Users,
  Bell,
  Lock,
  Trash2,
  ExternalLink,
  CheckCircle2,
  HelpCircle,
  XCircle,
  UserPlus
} from 'lucide-vue-next';
import { useCalendarStore } from '../../stores/calendarStore';
import { useContactsStore } from '../../stores/contactsStore';
import { sharedriveRoomLink, useRoomSettings } from '../../services/roomLinks';
import RoomLinkPicker from '../shared/RoomLinkPicker.vue';
import type { Attendee, RsvpStatus } from '../../types/calendar';

const store = useCalendarStore();
const contactsStore = useContactsStore();
const { settings: roomSettings, failed: roomSettingsFailed } = useRoomSettings(() => store.isEventModalOpen && !store.isPublicShareMode);

const title = ref('');
const calendarId = ref('');
const allDay = ref(false);
const startDate = ref('');
const startTime = ref('09:00');
const endDate = ref('');
const endTime = ref('10:00');
const location = ref('');
const videoUrl = ref('');
const originalVideoUrl = computed(() => store.editingEvent?.videoUrl?.trim() ?? '');
const roomLink = computed(() => sharedriveRoomLink(videoUrl.value, window.location.origin));
const roomsEnabled = computed(() => roomSettings.value?.rooms_enabled);
const invalidRoomLink = computed(() => roomsEnabled.value === true && videoUrl.value.trim() !== '' && !roomLink.value && videoUrl.value.trim() !== originalVideoUrl.value);
const description = ref('');
const reminderMinutes = ref<number | null>(null);
const attendees = ref<Attendee[]>([]);
const newAttendeeEmail = ref('');
const showAttendeeSuggestions = ref(false);

const isExisting = computed(() => Boolean(store.editingEvent?.id));

const isReadOnly = computed(() => {
  if (store.editingEvent?.seriesOccurrence) return true;
  if (!calendarId.value) return false;
  return store.isCalendarReadOnly(calendarId.value);
});

const attendeeSuggestions = computed(() => {
  if (!showAttendeeSuggestions.value || isReadOnly.value) return [];
  const q = newAttendeeEmail.value.trim();
  if (!q) return [];
  return contactsStore.searchContactsForAutocomplete(q, 6);
});

const currentUserRsvp = computed<RsvpStatus | null>(() => {
  const email = (store.session?.username || '').toLowerCase().trim();
  const found = attendees.value.find((a) => a.email.toLowerCase().trim() === email);
  return found ? found.partstat : null;
});

watch(
  () => store.editingEvent,
  (ev) => {
    if (!ev) return;
    title.value = ev.title || '';
    calendarId.value = ev.calendarId || store.defaultWritableCalendar?.id || '';
    allDay.value = Boolean(ev.allDay);

    if (ev.allDay) {
      startDate.value = ev.start.slice(0, 10);
      endDate.value = (ev.end || ev.start).slice(0, 10);
      startTime.value = '09:00';
      endTime.value = '10:00';
    } else {
      const sDt = new Date(ev.start);
      const eDt = new Date(ev.end || ev.start);
      startDate.value = toLocalDateInput(sDt);
      startTime.value = toLocalTimeInput(sDt);
      endDate.value = toLocalDateInput(eDt);
      endTime.value = toLocalTimeInput(eDt);
    }

    location.value = ev.location || '';
    videoUrl.value = ev.videoUrl || '';
    description.value = ev.description || '';
    reminderMinutes.value = ev.reminderMinutes !== undefined ? ev.reminderMinutes : null;
    attendees.value = ev.attendees ? [...ev.attendees] : [];
    newAttendeeEmail.value = '';
    showAttendeeSuggestions.value = false;
  },
  { immediate: true }
);

function toLocalDateInput(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toLocalTimeInput(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${min}`;
}

function selectSuggestedAttendee(item: { name: string; email: string }) {
  const email = item.email.trim();
  if (!attendees.value.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
    attendees.value.push({
      email,
      name: item.name || email.split('@')[0],
      partstat: 'NEEDS-ACTION'
    });
  }
  newAttendeeEmail.value = '';
  showAttendeeSuggestions.value = false;
}

function handleAttendeeBlur() {
  window.setTimeout(() => {
    showAttendeeSuggestions.value = false;
  }, 160);
}

function addAttendee() {
  const email = newAttendeeEmail.value.trim();
  if (!email) return;
  if (!email.includes('@') && attendeeSuggestions.value.length > 0) {
    selectSuggestedAttendee(attendeeSuggestions.value[0]);
    return;
  }
  if (!email.includes('@')) return;
  if (!attendees.value.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
    attendees.value.push({
      email,
      name: email.split('@')[0],
      partstat: 'NEEDS-ACTION'
    });
  }
  newAttendeeEmail.value = '';
  showAttendeeSuggestions.value = false;
}

function removeAttendee(email: string) {
  attendees.value = attendees.value.filter((a) => a.email !== email);
}

async function handleSave() {
  if (isReadOnly.value || invalidRoomLink.value) return;

  let startIso: string;
  let endIso: string;

  if (allDay.value) {
    startIso = startDate.value;
    endIso = endDate.value || startDate.value;
  } else {
    const s = new Date(`${startDate.value}T${startTime.value}:00`);
    const e = new Date(`${endDate.value || startDate.value}T${endTime.value}:00`);
    if (e <= s) {
      e.setTime(s.getTime() + 30 * 60 * 1000);
    }
    startIso = s.toISOString();
    endIso = e.toISOString();
  }

  await store.saveEvent({
    id: store.editingEvent?.id || undefined,
    uid: store.editingEvent?.uid || undefined,
    calendarId: calendarId.value,
    title: title.value || '(Ingen titel)',
    start: startIso,
    end: endIso,
    allDay: allDay.value,
    location: location.value,
    videoUrl: roomLink.value || videoUrl.value.trim(),
    description: description.value,
    reminderMinutes: reminderMinutes.value,
    attendees: attendees.value
  });

  store.isEventModalOpen = false;
}

async function handleDelete() {
  if (!store.editingEvent?.id || isReadOnly.value) return;
  await store.deleteEventsByIds([store.editingEvent.id]);
  store.isEventModalOpen = false;
}

async function handleRsvp(status: RsvpStatus) {
  if (!store.editingEvent?.id) return;
  await store.respondToInvite(store.editingEvent.id, status);
  if (store.editingEvent?.attendees) {
    attendees.value = [...store.editingEvent.attendees];
  }
}

const mapsSearchUrl = computed(() => {
  if (!location.value.trim()) return '';
  if (/^https?:\/\//i.test(location.value.trim())) return location.value.trim();
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(location.value.trim())}`;
});

const safeVideoUrl = computed(() => {
  const raw = videoUrl.value.trim();
  if (!raw) return '';
  return roomLink.value || (/^https?:\/\//i.test(raw) ? raw : '');
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.isEventModalOpen && store.editingEvent"
      class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4"
      @click.self="store.isEventModalOpen = false"
    >
      <div class="w-full max-w-xl bg-slate-900 border border-slate-700 rounded-none sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[100dvh] sm:h-auto sm:max-h-[90vh]">
        <!-- Header -->
        <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <h3 class="text-base font-bold text-slate-100">
              {{ isExisting ? (isReadOnly ? 'Begivenhedsdetaljer (Read-Only)' : 'Redigér begivenhed') : 'Opret ny begivenhed' }}
            </h3>
            <span
              v-if="isReadOnly"
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-xs font-semibold"
            >
              <Lock class="w-3 h-3" /> {{ store.editingEvent?.seriesOccurrence ? 'Forekomst i mødeserie' : 'Skrivebeskyttet' }}
            </span>
          </div>
          <button
            type="button"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            @click="store.isEventModalOpen = false"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <form class="p-5 space-y-4 overflow-y-auto text-xs" @submit.prevent="handleSave">
          <!-- Titel -->
          <div>
            <label class="block text-slate-400 font-medium mb-1">Titel</label>
            <input
              v-model="title"
              type="text"
              :disabled="isReadOnly"
              required
              placeholder="F.eks. Dagvagt, Deep Work eller Arkitekturmøde..."
              class="w-full px-3 py-2 text-sm bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
            />
          </div>

          <!-- Kalender & Heldag -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div class="sm:col-span-2">
              <label class="block text-slate-400 font-medium mb-1">Kalender</label>
              <select
                v-model="calendarId"
                :disabled="isReadOnly"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
              >
                <option
                  v-for="cal in store.calendars"
                  :key="cal.id"
                  :value="cal.id"
                  :disabled="cal.readOnly && cal.id !== calendarId"
                >
                  {{
                    cal.isShared && cal.owner
                      ? `${cal.name} (Delt af ${cal.owner})`
                      : cal.name
                  }}{{ cal.readOnly ? ' (Kun læsning)' : cal.isShared ? ' (Skrivbar)' : '' }}
                </option>
                <option
                  v-if="calendarId && !store.calendars.some((c) => c.id === calendarId)"
                  :value="calendarId"
                >
                  {{ store.getCalendarById(calendarId)?.name || 'Fødselsdage (Kontakter)' }} (Read-Only)
                </option>
              </select>
            </div>
            <label class="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 cursor-pointer">
              <input
                v-model="allDay"
                type="checkbox"
                :disabled="isReadOnly"
                class="rounded border-slate-600 bg-slate-900 text-blue-600"
              />
              <span class="text-slate-200 font-medium">Heldagsbegivenhed</span>
            </label>
          </div>

          <!-- Dato & Klokkeslæt -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-400 font-medium mb-1">Start</label>
              <div class="flex gap-2">
                <input
                  v-model="startDate"
                  type="date"
                  :disabled="isReadOnly"
                  class="flex-1 px-2.5 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
                />
                <input
                  v-if="!allDay"
                  v-model="startTime"
                  type="time"
                  :disabled="isReadOnly"
                  class="w-28 px-2.5 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
                />
              </div>
            </div>
            <div>
              <label class="block text-slate-400 font-medium mb-1">Slut</label>
              <div class="flex gap-2">
                <input
                  v-model="endDate"
                  type="date"
                  :disabled="isReadOnly"
                  class="flex-1 px-2.5 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
                />
                <input
                  v-if="!allDay"
                  v-model="endTime"
                  type="time"
                  :disabled="isReadOnly"
                  class="w-28 px-2.5 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
                />
              </div>
            </div>
          </div>

          <!-- Lokation & Videolink -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="flex items-center gap-1 text-slate-400 font-medium">
                  <MapPin class="w-3.5 h-3.5 text-rose-400" /> Lokation
                </label>
                <a
                  v-if="mapsSearchUrl"
                  :href="mapsSearchUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:underline"
                >
                  Åbn kort <ExternalLink class="w-3 h-3" />
                </a>
              </div>
              <input
                v-model="location"
                type="text"
                :disabled="isReadOnly"
                placeholder="Adresse eller mødelokale..."
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
              />
            </div>

            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="flex items-center gap-1 text-slate-400 font-medium">
                  <Video class="w-3.5 h-3.5 text-sky-400" /> {{ roomsEnabled ? 'Rooms-møde' : 'Videomøde-link' }}
                </label>
                <a
                  v-if="safeVideoUrl"
                  :href="safeVideoUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-semibold hover:underline"
                >
                  Deltag i videomøde <ExternalLink class="w-3 h-3" />
                </a>
              </div>
              <template v-if="!isReadOnly">
                <RoomLinkPicker v-if="roomsEnabled" v-model="videoUrl" />
                <input
                  v-else-if="roomsEnabled === false"
                  v-model="videoUrl"
                  type="url"
                  aria-label="Videomøde-link"
                  placeholder="https://meet.google.com/… eller Teams/Zoom"
                  class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
                />
                <p v-else class="text-slate-400">
                  {{ roomSettingsFailed ? 'Mødeindstillingen kunne ikke hentes.' : 'Henter mødeindstillingen…' }}
                </p>
                <p v-if="invalidRoomLink" class="mt-1 text-rose-300">Indsæt et Rooms-link fra denne Sharedrive.</p>
                <p v-else-if="roomsEnabled && !roomSettings?.rooms_voice_enabled" class="mt-1 text-slate-400">
                  Videoopkald er slået fra i Rooms.
                </p>
              </template>
            </div>
          </div>

          <!-- VALARM Påmindelse -->
          <div>
            <label class="flex items-center gap-1.5 text-slate-400 font-medium mb-1">
              <Bell class="w-3.5 h-3.5 text-amber-400" /> Browser-påmindelse (VALARM)
            </label>
            <select
              v-model="reminderMinutes"
              :disabled="isReadOnly"
              class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
            >
              <option :value="null">Ingen påmindelse</option>
              <option :value="0">Ved begivenhedens start</option>
              <option :value="5">5 minutter før</option>
              <option :value="10">10 minutter før</option>
              <option :value="15">15 minutter før</option>
              <option :value="30">30 minutter før</option>
              <option :value="60">1 time før</option>
            </select>
          </div>

          <!-- RSVP & Deltagere med Kontakt Autocomplete -->
          <div class="p-3.5 rounded-xl bg-slate-950/90 border border-slate-800 space-y-3">
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1.5 font-semibold text-slate-200">
                <Users class="w-4 h-4 text-purple-400" />
                Mødedeltagere &amp; RSVP
              </span>
              <span
                v-if="attendees.length > 0"
                class="text-[10px] px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30"
              >
                Ctrl+C spærret (Mødesikkerhed)
              </span>
            </div>

            <div v-if="!isReadOnly" class="relative">
              <div class="flex gap-2">
                <input
                  v-model="newAttendeeEmail"
                  type="text"
                  placeholder="Tilføj deltager (søg i kontakter eller skriv e-mail)..."
                  class="flex-1 px-3 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-blue-500"
                  @focus="showAttendeeSuggestions = true"
                  @input="showAttendeeSuggestions = true"
                  @blur="handleAttendeeBlur"
                  @keydown.enter.prevent="addAttendee"
                />
                <button
                  type="button"
                  class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1"
                  @click="addAttendee"
                >
                  <UserPlus class="w-3.5 h-3.5" /> Tilføj
                </button>
              </div>

              <div
                v-if="attendeeSuggestions.length > 0"
                class="absolute left-0 right-0 mt-1 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl max-h-44 overflow-y-auto z-50 divide-y divide-slate-800"
              >
                <button
                  v-for="item in attendeeSuggestions"
                  :key="item.email"
                  type="button"
                  class="w-full px-3 py-2 text-left hover:bg-slate-800 flex items-center justify-between gap-2 transition"
                  @mousedown.prevent="selectSuggestedAttendee(item)"
                >
                  <div class="truncate">
                    <span class="font-semibold text-slate-100">{{ item.name }}</span>
                    <span class="text-slate-400 ml-1.5">&lt;{{ item.email }}&gt;</span>
                  </div>
                  <span v-if="item.organization" class="text-[10px] text-slate-400 shrink-0">
                    {{ item.organization }}
                  </span>
                </button>
              </div>
            </div>

            <div v-if="attendees.length > 0" class="space-y-1.5">
              <div
                v-for="att in attendees"
                :key="att.email"
                class="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800"
              >
                <div class="truncate">
                  <span class="font-medium text-slate-200">{{ att.name || att.email }}</span>
                  <span class="text-slate-500 ml-1.5">({{ att.email }})</span>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <span
                    class="px-2 py-0.5 rounded text-[10px] font-semibold"
                    :class="{
                      'bg-emerald-500/20 text-emerald-300': att.partstat === 'ACCEPTED',
                      'bg-amber-500/20 text-amber-300': att.partstat === 'TENTATIVE',
                      'bg-rose-500/20 text-rose-300': att.partstat === 'DECLINED',
                      'bg-slate-800 text-slate-400': att.partstat === 'NEEDS-ACTION'
                    }"
                  >
                    {{
                      att.partstat === 'ACCEPTED'
                        ? 'Deltager'
                        : att.partstat === 'TENTATIVE'
                          ? 'Måske'
                          : att.partstat === 'DECLINED'
                            ? 'Afvist'
                            : 'Afventer'
                    }}
                  </span>
                  <button
                    v-if="!isReadOnly"
                    type="button"
                    class="text-slate-500 hover:text-rose-400"
                    @click="removeAttendee(att.email)"
                  >
                    <X class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <div v-if="isExisting && attendees.length > 0 && !store.editingEvent?.seriesOccurrence" class="pt-2 border-t border-slate-800 flex items-center justify-between gap-2">
              <span class="text-slate-400 font-medium">Dit mødesvar (RSVP):</span>
              <div class="flex items-center gap-1.5">
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-lg border flex items-center gap-1 font-medium transition"
                  :class="currentUserRsvp === 'ACCEPTED'
                    ? 'bg-emerald-600 text-white border-emerald-500'
                    : 'bg-slate-900 hover:bg-slate-800 text-emerald-300 border-slate-700'"
                  @click="handleRsvp('ACCEPTED')"
                >
                  <CheckCircle2 class="w-3.5 h-3.5" /> Deltager
                </button>
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-lg border flex items-center gap-1 font-medium transition"
                  :class="currentUserRsvp === 'TENTATIVE'
                    ? 'bg-amber-600 text-white border-amber-500'
                    : 'bg-slate-900 hover:bg-slate-800 text-amber-300 border-slate-700'"
                  @click="handleRsvp('TENTATIVE')"
                >
                  <HelpCircle class="w-3.5 h-3.5" /> Måske
                </button>
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-lg border flex items-center gap-1 font-medium transition"
                  :class="currentUserRsvp === 'DECLINED'
                    ? 'bg-rose-600 text-white border-rose-500'
                    : 'bg-slate-900 hover:bg-slate-800 text-rose-300 border-slate-700'"
                  @click="handleRsvp('DECLINED')"
                >
                  <XCircle class="w-3.5 h-3.5" /> Afvis
                </button>
              </div>
            </div>
          </div>

          <!-- Beskrivelse -->
          <div>
            <label class="block text-slate-400 font-medium mb-1">Beskrivelse / Noter</label>
            <textarea
              v-model="description"
              rows="3"
              :disabled="isReadOnly"
              placeholder="Fuld tekst-beskrivelse, dagsorden eller noter..."
              class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
            ></textarea>
          </div>

          <!-- Footer knapper -->
          <div class="pt-3 border-t border-slate-800 flex items-center justify-between">
            <div>
              <button
                v-if="isExisting && !isReadOnly"
                type="button"
                class="px-3 py-2 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 flex items-center gap-1.5 font-medium transition"
                @click="handleDelete"
              >
                <Trash2 class="w-3.5 h-3.5" /> Flyt til papirkurv
              </button>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition"
                @click="store.isEventModalOpen = false"
              >
                {{ isReadOnly ? 'Luk' : 'Annullér' }}
              </button>
              <button
                v-if="!isReadOnly"
                type="submit"
                :disabled="invalidRoomLink"
                class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow transition disabled:opacity-50"
              >
                Gem begivenhed
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
