<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  Share2,
  Copy,
  Check,
  Trash2,
  X,
  Lock,
  ExternalLink,
  Link2,
  Users,
  UserPlus,
  Pencil,
  Eye,
  RefreshCw
} from 'lucide-vue-next';
import { useCalendarStore } from '../../stores/calendarStore';
import { useContactsStore } from '../../stores/contactsStore';
import type { CalendarSharePermission } from '../../types/calendar';

const store = useCalendarStore();
const contactsStore = useContactsStore();

const activeTab = ref<'USERS' | 'PUBLIC_LINK'>('USERS');

// Tab 1: Del med bruger (Læs / Skriv)
const shareCalendarId = ref('');
const recipientEmail = ref('');
const permission = ref<CalendarSharePermission>('read');
const isSharingUser = ref(false);
const showUserSuggestions = ref(false);

// Tab 2: Offentligt link (3. part, Read-Only)
const label = ref('');
const selectedCalendarIds = ref<string[]>([]);
const hideDetails = ref(false);
const expiryDays = ref(0);
const isCreating = ref(false);
const copiedToken = ref<string | null>(null);

const ownCalendars = computed(() =>
  store.calendars.filter(
    (c) => !c.isShared && !c.isSubscribed && !c.id.startsWith('sub::')
  )
);

const userSuggestions = computed(() => {
  if (!showUserSuggestions.value) return [];
  const q = recipientEmail.value.trim();
  if (!q) return [];
  return contactsStore.searchContactsForAutocomplete(q, 6);
});

function selectRecipientSuggestion(item: { name: string; email: string }) {
  recipientEmail.value = item.email.trim();
  showUserSuggestions.value = false;
}

function handleRecipientBlur() {
  window.setTimeout(() => {
    showUserSuggestions.value = false;
  }, 160);
}

watch(
  () => store.isShareModalOpen,
  (isOpen) => {
    if (!isOpen) return;
    activeTab.value = 'USERS';

    const pre = store.preselectedShareCalendarId;
    if (pre && ownCalendars.value.some((c) => c.id === pre)) {
      shareCalendarId.value = pre;
    } else {
      shareCalendarId.value = ownCalendars.value[0]?.id || '';
    }
    recipientEmail.value = '';
    permission.value = 'read';
    showUserSuggestions.value = false;

    if (pre) {
      selectedCalendarIds.value = [pre];
      const cal = store.getCalendarById(pre);
      label.value = cal ? cal.name : 'Delt kalender';
    } else {
      selectedCalendarIds.value = store.calendars.map((c) => c.id);
      label.value = 'Min Kalender';
    }
    hideDetails.value = false;
    expiryDays.value = 0;
  }
);

async function handleShareWithUser() {
  if (!shareCalendarId.value || !recipientEmail.value.trim()) return;
  isSharingUser.value = true;
  try {
    const saved = await store.shareCalendarWithUser({
      calendarId: shareCalendarId.value,
      recipientEmail: recipientEmail.value.trim(),
      permission: permission.value
    });
    if (saved) {
      recipientEmail.value = '';
    }
  } finally {
    isSharingUser.value = false;
  }
}

function buildShareUrl(token: string): string {
  const origin = window.location.origin;
  const pathname = window.location.pathname;
  return `${origin}${pathname}?share=${encodeURIComponent(token)}`;
}

async function copyShareUrl(token: string) {
  const url = buildShareUrl(token);
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copiedToken.value = token;
    store.notify('Delingslink kopieret!', 'Du kan nu sende linket til 3. part.', 'success');
    window.setTimeout(() => {
      if (copiedToken.value === token) copiedToken.value = null;
    }, 2500);
  } catch {
    store.notify('Kunne ikke kopiere automatisk', url, 'info');
  }
}

async function handleCreateShare() {
  if (selectedCalendarIds.value.length === 0) return;
  isCreating.value = true;
  try {
    const created = await store.createShare({
      label: label.value.trim() || 'Delt kalender',
      calendarIds: selectedCalendarIds.value,
      hideDetails: hideDetails.value,
      expiresAt: expiryDays.value ? new Date(Date.now() + expiryDays.value * 86_400_000).toISOString() : undefined
    });
    if (created) {
      await copyShareUrl(created.token);
    }
  } finally {
    isCreating.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.isShareModalOpen"
      class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      @click.self="store.isShareModalOpen = false"
    >
      <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <!-- Header -->
        <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Share2 class="w-4 h-4 text-blue-400" />
            <h3 class="text-base font-bold text-slate-100">
              Del Kalender
            </h3>
          </div>
          <button
            type="button"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            @click="store.isShareModalOpen = false"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <!-- Tabs: Del med bruger (Læs/Skriv) vs Offentligt link -->
        <div class="px-5 pt-3 pb-1 border-b border-slate-800 bg-slate-950/60">
          <div class="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-900 border border-slate-800 text-xs">
            <button
              type="button"
              class="py-1.5 px-3 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition"
              :class="activeTab === 'USERS' ? 'dav-theme-btn shadow-sm' : 'text-slate-400 hover:text-slate-200'"
              @click="activeTab = 'USERS'"
            >
              <Users class="w-3.5 h-3.5" />
              <span>Del med bruger (Læs / Skriv)</span>
            </button>
            <button
              type="button"
              class="py-1.5 px-3 rounded-lg font-semibold flex items-center justify-center gap-1.5 transition"
              :class="activeTab === 'PUBLIC_LINK' ? 'dav-theme-btn shadow-sm' : 'text-slate-400 hover:text-slate-200'"
              @click="activeTab = 'PUBLIC_LINK'"
            >
              <Link2 class="w-3.5 h-3.5" />
              <span>Offentligt link (3. part)</span>
            </button>
          </div>
        </div>

        <!-- TAB 1: Del med bruger i systemet (Læs / Skriv) -->
        <div v-if="activeTab === 'USERS'" class="p-5 overflow-y-auto space-y-5 text-xs">
          <form class="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3.5" @submit.prevent="handleShareWithUser">
            <div class="flex items-center justify-between gap-2">
              <span class="font-semibold text-slate-200">Giv adgang til en anden bruger</span>
              <span class="text-[10.5px] text-slate-400">Læs eller Læs &amp; Skriv</span>
            </div>

            <div v-if="ownCalendars.length === 0" class="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[11px]">
              Du har ingen egne kalendere at dele lige nu (kun dine egne kalendere kan deles videre).
            </div>

            <template v-else>
              <div>
                <label class="block text-slate-400 font-medium mb-1">Vælg din kalender</label>
                <select
                  v-model="shareCalendarId"
                  class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                >
                  <option v-for="cal in ownCalendars" :key="cal.id" :value="cal.id">
                    {{ cal.name }}
                  </option>
                </select>
              </div>

              <div class="relative">
                <label class="block text-slate-400 font-medium mb-1">Brugerens e-mailadresse</label>
                <input
                  v-model="recipientEmail"
                  type="email"
                  required
                  autocomplete="off"
                  placeholder="f.eks. anne@ditdomæne.dk"
                  class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                  @focus="showUserSuggestions = true"
                  @blur="handleRecipientBlur"
                />

                <div
                  v-if="userSuggestions.length > 0"
                  class="absolute left-0 right-0 mt-1 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl max-h-44 overflow-y-auto z-40 divide-y divide-slate-800"
                >
                  <button
                    v-for="item in userSuggestions"
                    :key="item.email"
                    type="button"
                    class="w-full px-3 py-2 text-left hover:bg-slate-800 flex items-center justify-between gap-2 transition"
                    @mousedown.prevent="selectRecipientSuggestion(item)"
                  >
                    <span class="font-medium text-slate-100 truncate">{{ item.name }}</span>
                    <span class="text-[11px] text-slate-400 truncate">{{ item.email }}</span>
                  </button>
                </div>
              </div>

              <div>
                <label class="block text-slate-400 font-medium mb-1.5">Rettighedsniveau</label>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    class="p-2.5 rounded-xl border text-left transition space-y-0.5"
                    :class="
                      permission === 'read'
                        ? 'bg-amber-500/15 border-amber-500/50 text-amber-100'
                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                    "
                    @click="permission = 'read'"
                  >
                    <div class="flex items-center gap-1.5 font-semibold">
                      <Eye class="w-3.5 h-3.5 text-amber-400" />
                      <span>Kun læsning</span>
                    </div>
                    <p class="text-[10.5px] text-slate-400 leading-snug">
                      Modtageren kan se aftaler i kalenderen.
                    </p>
                  </button>

                  <button
                    type="button"
                    class="p-2.5 rounded-xl border text-left transition space-y-0.5"
                    :class="
                      permission === 'write'
                        ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-100'
                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
                    "
                    @click="permission = 'write'"
                  >
                    <div class="flex items-center gap-1.5 font-semibold">
                      <Pencil class="w-3.5 h-3.5 text-emerald-400" />
                      <span>Læs &amp; Skriv</span>
                    </div>
                    <p class="text-[10.5px] text-slate-400 leading-snug">
                      Modtageren kan oprette, redigere, flytte og slette aftaler.
                    </p>
                  </button>
                </div>
              </div>

              <button
                type="submit"
                :disabled="isSharingUser || !shareCalendarId || !recipientEmail.trim()"
                class="w-full py-2 rounded-xl dav-theme-btn disabled:opacity-50 font-semibold flex items-center justify-center gap-1.5 shadow transition"
              >
                <UserPlus class="w-4 h-4" />
                {{ isSharingUser ? 'Gemmer adgang...' : 'Del kalender med bruger' }}
              </button>
            </template>

            <p class="text-[11px] text-slate-400 leading-relaxed pt-1 border-t border-slate-800/80">
              Delingen gemmes direkte i Mailcow/SOGo – så den virker automatisk i både Sharedrive, SOGo Webmail, mobil og andre kalenderapps uden dobbelt-deling.
            </p>
          </form>

          <!-- Aktive bruger-delinger -->
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <h4 class="font-bold uppercase tracking-wider text-slate-400 text-[11px]">
                Brugere med adgang ({{ store.userShares.length }})
              </h4>
              <button
                type="button"
                :disabled="store.isLoadingUserShares"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-[10.5px] text-slate-300 hover:text-slate-100 disabled:opacity-50 transition"
                title="Opdatér status fra Mailcow/SOGo"
                @click="store.loadUserShares()"
              >
                <RefreshCw
                  class="w-3 h-3"
                  :class="store.isLoadingUserShares ? 'animate-spin' : ''"
                />
                <span>Opdatér</span>
              </button>
            </div>

            <div
              v-if="store.isLoadingUserShares && store.userShares.length === 0"
              class="p-5 text-center rounded-xl bg-slate-950/60 border border-slate-800 text-slate-400"
            >
              Henter eksisterende delinger fra SOGo...
            </div>

            <div
              v-else-if="store.userShares.length === 0"
              class="p-5 text-center rounded-xl bg-slate-950/60 border border-slate-800 text-slate-400"
            >
              Du har ikke delt nogen kalendere med andre brugere endnu.
            </div>

            <div
              v-for="uShare in store.userShares"
              :key="uShare.id"
              class="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3"
            >
              <div class="min-w-0 flex-1 space-y-0.5">
                <div class="flex items-center gap-2">
                  <span
                    class="w-2.5 h-2.5 rounded-full shrink-0"
                    :style="{ backgroundColor: uShare.calendarColor }"
                  ></span>
                  <span class="font-semibold text-slate-100 truncate">
                    {{
                      uShare.recipientDisplayName
                        ? `${uShare.recipientDisplayName} (${uShare.recipientEmail})`
                        : uShare.recipientEmail
                    }}
                  </span>
                  <span
                    v-if="uShare.source === 'sogo'"
                    class="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30 text-[9.5px] font-semibold shrink-0"
                    title="Gemt direkte i Mailcow/SOGo ACL"
                  >
                    SOGo
                  </span>
                </div>
                <div class="text-[11px] text-slate-400 truncate pl-4">
                  Kalender: {{ uShare.calendarName }}
                </div>
              </div>

              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  class="px-2.5 py-1 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1 transition"
                  :class="
                    uShare.permission === 'write'
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                      : 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25'
                  "
                  title="Klik for at skifte mellem Kun læsning og Læs & Skriv"
                  @click="
                    store.updateUserSharePermission(
                      uShare.id,
                      uShare.permission === 'write' ? 'read' : 'write'
                    )
                  "
                >
                  <Pencil v-if="uShare.permission === 'write'" class="w-3 h-3" />
                  <Eye v-else class="w-3 h-3" />
                  <span>{{ uShare.permission === 'write' ? 'Læs & Skriv' : 'Kun læsning' }}</span>
                </button>

                <button
                  type="button"
                  class="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition"
                  title="Tilbagekald adgang"
                  @click="store.revokeUserShare(uShare.id)"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- TAB 2: Offentligt link (3. part, Read-Only) -->
        <div v-else class="p-5 overflow-y-auto space-y-5 text-xs">
          <!-- Opret nyt delingslink -->
          <form class="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3.5" @submit.prevent="handleCreateShare">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-slate-200">Opret nyt delingslink</span>
              <span class="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold">
                <Lock class="w-3 h-3" /> Kun visning (Read-Only uden login)
              </span>
            </div>

            <div>
              <label class="block text-slate-400 font-medium mb-1">Navn / Titel på deling</label>
              <input
                v-model="label"
                type="text"
                required
                placeholder="F.eks. Carstens Kalender eller Vagtplan..."
                class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label class="block text-slate-400 font-medium mb-1.5">Vælg kalendere der skal indgå i linket</label>
              <div class="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                <label
                  v-for="cal in store.calendars"
                  :key="cal.id"
                  class="flex items-center gap-2.5 p-2 rounded-lg bg-slate-900 border border-slate-800 cursor-pointer hover:border-slate-700"
                >
                  <input
                    v-model="selectedCalendarIds"
                    type="checkbox"
                    :value="cal.id"
                    class="rounded border-slate-600 bg-slate-950 text-blue-600"
                  />
                  <span
                    class="w-2.5 h-2.5 rounded-full shrink-0"
                    :style="{ backgroundColor: cal.color }"
                  ></span>
                  <span class="text-slate-200 font-medium truncate">{{ cal.name }}</span>
                </label>
              </div>
            </div>

            <label class="flex items-center gap-2.5 pt-1 cursor-pointer">
              <input
                v-model="hideDetails"
                type="checkbox"
                class="rounded border-slate-600 bg-slate-900 text-blue-600"
              />
              <span class="text-slate-300">
                Anonymisér titler (vis kun <strong>"Optaget"</strong> + tidspunkt til modtageren)
              </span>
            </label>

            <label class="block space-y-1 text-slate-300">
              <span>Linket udløber</span>
              <select v-model.number="expiryDays" class="block w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5">
                <option :value="0">Udløber aldrig</option>
                <option :value="1">Efter 24 timer</option>
                <option :value="7">Efter 7 dage</option>
                <option :value="30">Efter 30 dage</option>
              </select>
            </label>
            <button
              type="submit"
              :disabled="isCreating || selectedCalendarIds.length === 0"
              class="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold flex items-center justify-center gap-1.5 shadow transition"
            >
              <Link2 class="w-4 h-4" />
              {{ isCreating ? 'Opretter delingslink...' : 'Opret & Kopiér offentligt link' }}
            </button>
          </form>

          <!-- Aktive delingslinks -->
          <div class="space-y-2">
            <h4 class="font-bold uppercase tracking-wider text-slate-400 text-[11px]">
              Dine delingslinks ({{ store.shares.length }})
            </h4>

            <div
              v-if="store.shares.length === 0"
              class="p-6 text-center rounded-xl bg-slate-950/60 border border-slate-800 text-slate-400"
            >
              Du har ingen delingslinks endnu.
            </div>

            <div
              v-for="share in store.shares"
              :key="share.token"
              class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="font-semibold text-slate-100 truncate">
                    {{ share.label }}
                  </div>
                  <p v-if="share.expiresAt" class="text-[11px] text-slate-400">
                    {{ Date.parse(share.expiresAt) <= Date.now() ? 'Udløbet' : 'Udløber ' + new Date(share.expiresAt).toLocaleString('da-DK') }}
                  </p>
                  <div class="text-[11px] text-slate-400 truncate">
                    Kalendere: {{ share.calendarNames.join(', ') }}
                    <span v-if="share.hideDetails" class="text-amber-300 ml-1">(Kun "Optaget")</span>
                  </div>
                </div>

                <div class="flex items-center gap-1.5 shrink-0">
                  <a
                    :href="buildShareUrl(share.token)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
                    title="Åbn delingslink i ny fane"
                  >
                    <ExternalLink class="w-3.5 h-3.5" />
                  </a>
                  <button
                    type="button"
                    class="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition"
                    title="Tilbagekald / slet dette delingslink"
                    @click="store.revokeShare(share.token)"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <input
                  type="text"
                  readonly
                  :value="buildShareUrl(share.token)"
                  class="flex-1 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800 text-[11px] text-slate-300 font-mono select-all focus:outline-none"
                />
                <button
                  type="button"
                  class="px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1 transition shrink-0"
                  :class="copiedToken === share.token
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700'"
                  @click="copyShareUrl(share.token)"
                >
                  <Check v-if="copiedToken === share.token" class="w-3.5 h-3.5" />
                  <Copy v-else class="w-3.5 h-3.5" />
                  {{ copiedToken === share.token ? 'Kopieret!' : 'Kopiér link' }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="px-5 py-3 border-t border-slate-800 flex justify-end">
          <button
            type="button"
            class="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
            @click="store.isShareModalOpen = false"
          >
            Luk
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
