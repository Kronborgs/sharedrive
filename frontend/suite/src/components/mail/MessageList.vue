<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import {
  Star,
  Paperclip,
  Reply,
  Pencil,
  Trash2,
  MailOpen,
  Mail,
  CheckSquare,
  Square,
  ShieldAlert,
  ShieldCheck
} from 'lucide-vue-next';
import { useMailStore } from '../../stores/mailStore';
import { useTheme } from '../../composables/useTheme';
import type { MailHeader } from '../../types/mail';

const props = defineProps<{
  width?: number;
  height?: number;
  splitMode?: boolean;
  fullWidth?: boolean;
}>();

const emit = defineEmits<{
  (e: 'open-message', msg: MailHeader): void;
}>();

const store = useMailStore();
const { currentTheme } = useTheme();
const listScrollRef = ref<HTMLElement | null>(null);

function handleListScroll() {
  const el = listScrollRef.value;
  if (
    !el ||
    !store.hasMoreMessages ||
    store.isLoadingMore ||
    store.isLoadingAll ||
    store.isSyncing
  ) {
    return;
  }
  const distanceToBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
  if (distanceToBottom <= 220) {
    void store.loadMoreMessages();
  }
}

watch(
  () => store.selectionFocusId || store.activeMessageId,
  async (focusId) => {
    if (!focusId || !listScrollRef.value) return;
    await nextTick();
    const rows = listScrollRef.value.querySelectorAll<HTMLElement>('[data-mail-row-id]');
    for (const row of rows) {
      if (row.dataset.mailRowId === focusId) {
        row.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }
);

const selectedIdSet = computed(() => new Set(store.selectedMessageIds));
const clipIdSet = computed(() => new Set(store.clipboard.messages.map((m) => m.id)));

const allSelected = computed(
  () =>
    store.filteredMessages.length > 0 &&
    store.selectedMessageIds.length >= store.filteredMessages.length
);

function toggleSelectAll() {
  if (allSelected.value) {
    store.selectedMessageIds = [];
    store.selectionAnchorId = null;
    store.selectionFocusId = null;
  } else {
    store.selectAllInCurrentList();
  }
}

function handleRowClick(e: MouseEvent, msg: MailHeader) {
  if (e.shiftKey) {
    store.selectMessageRange(msg);
  } else if (e.ctrlKey || e.metaKey) {
    void store.openMessage(msg, true);
  } else {
    void store.openMessage(msg, false);
    emit('open-message', msg);
  }
}

function handleDragStart(e: DragEvent, msg: MailHeader) {
  if (!selectedIdSet.value.has(msg.id)) {
    store.selectedMessageIds = [msg.id];
  }
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', msg.id);
  }
}

function formatPrimaryParty(msg: MailHeader): string {
  const isSentOrDraft =
    store.activeFolder?.specialUse === 'sent' ||
    store.activeFolder?.specialUse === 'drafts';
  const list = isSentOrDraft ? msg.to : msg.from;
  const first = list[0];
  if (!first) return isSentOrDraft ? '(Ingen modtager)' : 'Ukendt afsender';
  return first.name || first.address;
}

function formatSecondaryAddress(msg: MailHeader): string {
  const isSentOrDraft =
    store.activeFolder?.specialUse === 'sent' ||
    store.activeFolder?.specialUse === 'drafts';
  const list = isSentOrDraft ? msg.to : msg.from;
  const first = list[0];
  if (!first || !first.name) return '';
  return first.address;
}

function formatSmartDate(iso: string): string {
  const dt = new Date(iso);
  const now = new Date();
  const isSameDay =
    dt.getFullYear() === now.getFullYear() &&
    dt.getMonth() === now.getMonth() &&
    dt.getDate() === now.getDate();

  if (isSameDay) {
    return dt.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  }
  const isSameYear = dt.getFullYear() === now.getFullYear();
  if (isSameYear) {
    return dt.toLocaleDateString('da-DK', { day: '2-digit', month: 'short' });
  }
  return dt.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
</script>

<template>
  <section
    class="flex flex-col select-none overflow-hidden transition-all duration-300"
    :class="[
      props.fullWidth ? 'w-full flex-1 h-full' : props.splitMode ? 'w-full shrink-0' : 'h-full shrink-0',
      currentTheme.wallpaper
        ? 'rounded-2xl border backdrop-blur-lg shadow-xl'
        : props.splitMode
          ? 'bg-slate-950 border-b border-slate-800'
          : 'bg-slate-950 border-r border-slate-800'
    ]"
    :style="{
      ...(props.fullWidth
        ? {}
        : props.splitMode
          ? { height: `${props.height || 280}px` }
          : { width: `${props.width || 380}px` }),
      ...(currentTheme.wallpaper
        ? { backgroundColor: currentTheme.gridBg, borderColor: currentTheme.border }
        : {})
    }"
  >
    <!-- Topbjælke over beskedlisten: Mappe-titel & Batch-handlinger -->
    <div
      class="h-11 px-3 border-b flex items-center justify-between gap-2 shrink-0"
      :class="currentTheme.wallpaper ? 'bg-black/25 border-white/10' : 'bg-slate-900/70 border-slate-800'"
    >
      <div class="flex items-center gap-2 min-w-0">
        <button
          type="button"
          class="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
          :title="allSelected ? 'Fravælg alle' : 'Markér alle i listen (Ctrl+A)'"
          @click="toggleSelectAll"
        >
          <CheckSquare v-if="allSelected" class="w-4 h-4 text-blue-400" />
          <Square v-else class="w-4 h-4" />
        </button>
        <h2 class="text-xs font-bold text-slate-100 truncate">
          {{ store.searchQuery.trim() ? 'Søgeresultater (Alle mapper)' : (store.activeFolder?.name || store.activeFolderPath) }}
        </h2>
        <span class="text-[11px] text-slate-400 whitespace-nowrap">
          <template
            v-if="
              !store.searchQuery.trim() &&
              store.filterMode === 'ALL' &&
              store.totalFolderMessages > store.filteredMessages.length
            "
          >
            ({{ store.filteredMessages.length }} af {{ store.totalFolderMessages }})
          </template>
          <template v-else>
            ({{ store.filteredMessages.length }})
          </template>
        </span>
        <span
          v-if="store.selectedMessageIds.length > 1"
          class="px-1.5 py-0.5 rounded-md bg-blue-500/20 border border-blue-400/35 text-blue-200 text-[10px] font-semibold whitespace-nowrap"
        >
          {{ store.selectedMessageIds.length }} valgt
        </span>
      </div>

      <!-- Hurtige batch-knapper når 1+ e-mails er markeret -->
      <div v-if="store.selectedMessageIds.length > 0" class="flex items-center gap-1">
        <button
          type="button"
          class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"
          title="Skift læst/ulæst"
          @click="
            store.toggleSeenForMessages(
              store.filteredMessages.filter((m) => selectedIdSet.has(m.id))
            )
          "
        >
          <MailOpen class="w-3.5 h-3.5 text-blue-400" />
        </button>
        <button
          type="button"
          class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-300 transition"
          title="Skift stjernemarkering"
          @click="
            store.toggleFlaggedForMessages(
              store.filteredMessages.filter((m) => selectedIdSet.has(m.id))
            )
          "
        >
          <Star class="w-3.5 h-3.5 text-amber-400" />
        </button>
        <button
          type="button"
          class="p-1.5 rounded-lg hover:bg-orange-500/20 text-slate-300 hover:text-orange-400 transition"
          :title="store.activeFolder?.specialUse === 'junk'
            ? 'Markér valgte som Ikke-spam (flyt til Indbakke og træn Rspamd)'
            : 'Markér valgte som Spam (flyt til Spam-mappen så Rspamd lærer af det)'"
          @click="
            store.markMessagesAsSpam(
              store.filteredMessages.filter((m) => selectedIdSet.has(m.id))
            )
          "
        >
          <ShieldCheck v-if="store.activeFolder?.specialUse === 'junk'" class="w-3.5 h-3.5 text-emerald-400" />
          <ShieldAlert v-else class="w-3.5 h-3.5 text-orange-400" />
        </button>
        <button
          type="button"
          class="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-300 hover:text-rose-400 transition"
          title="Flyt til papirkurv (Del) • Hold Shift for permanent sletning (Shift+Del)"
          @click="store.deleteSelectedMessages(undefined, $event.shiftKey)"
        >
          <Trash2 class="w-3.5 h-3.5" />
        </button>
      </div>

      <!-- Hurtig Tøm papirkurv / Tøm spam knap -->
      <div
        v-else-if="
          !store.searchQuery.trim() &&
          (store.activeFolder?.specialUse === 'trash' || store.activeFolder?.specialUse === 'junk') &&
          (store.totalFolderMessages > 0 || store.messages.length > 0)
        "
        class="flex items-center shrink-0"
      >
        <button
          type="button"
          :disabled="store.isEmptyingFolder || store.isSyncing"
          class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 border border-rose-400/35 text-rose-200 text-[11px] font-semibold disabled:opacity-50 transition whitespace-nowrap"
          :title="store.activeFolder?.specialUse === 'trash' ? 'Slet alle e-mails i Papirkurv permanent' : 'Slet alle e-mails i Spam permanent'"
          @click="store.emptyFolder(store.activeFolderPath)"
        >
          <Trash2 class="w-3 h-3 text-rose-400" />
          <span>
            {{
              store.isEmptyingFolder
                ? 'Tømmer...'
                : store.activeFolder?.specialUse === 'trash'
                  ? 'Tøm papirkurv'
                  : 'Tøm spam'
            }}
          </span>
        </button>
      </div>
    </div>

    <!-- Beskedliste -->
    <div
      ref="listScrollRef"
      class="flex-1 overflow-y-auto divide-y divide-slate-800/70"
      @scroll.passive="handleListScroll"
    >
      <div
        v-if="store.filteredMessages.length === 0"
        class="p-8 text-center text-xs text-slate-400 space-y-2"
      >
        <Mail class="w-8 h-8 text-slate-600 mx-auto" />
        <div class="font-medium text-slate-300">Ingen e-mails i denne visning</div>
        <p v-if="store.searchQuery" class="text-[11px] text-slate-500">
          Tryk <kbd class="px-1.5 py-0.5 bg-slate-800 rounded text-slate-300">Enter</kbd> i søgefeltet for at søge dybt på IMAP-serveren.
        </p>
      </div>

      <div
        v-for="msg in store.filteredMessages"
        :key="msg.id"
        :data-mail-row-id="msg.id"
        draggable="true"
        class="px-3 py-2.5 cursor-pointer transition relative group flex items-start gap-2.5"
        :class="[
          selectedIdSet.has(msg.id)
            ? store.selectionFocusId === msg.id && store.selectedMessageIds.length > 1
              ? 'bg-blue-600/30 border-l-2 border-l-blue-300 ring-1 ring-inset ring-blue-400/40'
              : 'bg-blue-600/20 border-l-2 border-l-blue-500'
            : store.activeMessageId === msg.id
              ? 'bg-blue-600/20 border-l-2 border-l-blue-500'
              : currentTheme.wallpaper
                ? msg.seen
                  ? 'bg-transparent hover:bg-white/5'
                  : 'bg-white/[0.04] hover:bg-white/[0.08]'
                : msg.seen
                  ? 'bg-slate-950 hover:bg-slate-900/80'
                  : 'bg-slate-900/95 hover:bg-slate-800/70',
          clipIdSet.has(msg.id) && store.clipboard.mode === 'CUT' ? 'opacity-50 outline-dashed outline-1 outline-amber-400' : '',
          clipIdSet.has(msg.id) && store.clipboard.mode === 'COPY' ? 'outline-dashed outline-1 outline-emerald-400' : ''
        ]"
        @click="handleRowClick($event, msg)"
        @dblclick="store.isDraftMessage(msg) ? store.editDraftMessage(msg) : undefined"
        @contextmenu.prevent="store.openMessageContextMenu($event, msg)"
        @dragstart="handleDragStart($event, msg)"
      >
        <!-- Ulæst prik & Stjerne -->
        <div class="flex flex-col items-center gap-1.5 pt-1 shrink-0">
          <span
            class="w-2 h-2 rounded-full transition"
            :class="msg.seen ? 'bg-transparent' : 'bg-blue-500 shadow-sm shadow-blue-500/50'"
            :title="msg.seen ? 'Læst' : 'Ulæst'"
          ></span>
          <button
            type="button"
            class="text-slate-500 hover:text-amber-400 transition"
            title="Stjernemarkér"
            @click.stop="store.toggleFlaggedForMessages([msg])"
          >
            <Star
              class="w-3.5 h-3.5"
              :class="msg.flagged ? 'fill-amber-400 text-amber-400' : ''"
            />
          </button>
        </div>

        <!-- Afsender, Emne & Badges -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 min-w-0">
              <span
                class="text-xs truncate"
                :class="msg.seen ? 'font-medium text-slate-300' : 'font-bold text-white'"
              >
                {{ formatPrimaryParty(msg) }}
              </span>
              <span
                v-if="formatSecondaryAddress(msg)"
                class="text-[10px] text-slate-500 truncate hidden sm:inline"
              >
                &lt;{{ formatSecondaryAddress(msg) }}&gt;
              </span>
            </div>

            <div class="flex items-center gap-1.5 shrink-0">
              <button
                v-if="store.isDraftMessage(msg)"
                type="button"
                class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/35 border border-amber-400/40 text-amber-200 text-[10px] font-semibold transition"
                title="Klik for at redigere kladden videre"
                @click.stop="store.editDraftMessage(msg)"
              >
                <Pencil class="w-2.5 h-2.5" />
                <span>Redigér</span>
              </button>
              <span
                v-if="store.searchQuery.trim() || msg.folder !== store.activeFolderPath"
                class="px-1.5 py-0.2 rounded bg-slate-800 border border-slate-700 text-blue-300 text-[10px] font-semibold"
                :title="`Mappe: ${store.getFolderDisplayName(msg.folder)}`"
              >
                {{ store.getFolderDisplayName(msg.folder) }}
              </span>
              <Reply
                v-if="msg.answered"
                class="w-3 h-3 text-emerald-400"
                title="Besvaret"
              />
              <Paperclip
                v-if="msg.hasAttachments"
                class="w-3 h-3 text-blue-400"
                title="Har vedhæftede filer"
              />
              <span
                class="text-[11px] whitespace-nowrap"
                :class="msg.seen ? 'text-slate-500' : 'text-blue-400 font-semibold'"
              >
                {{ formatSmartDate(msg.date) }}
              </span>
            </div>
          </div>

          <div
            class="text-xs mt-0.5 truncate"
            :class="msg.seen ? 'text-slate-400' : 'font-semibold text-slate-100'"
          >
            {{ msg.subject }}
          </div>
        </div>
      </div>

      <div v-if="store.hasMoreMessages" class="p-3 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          :disabled="store.isLoadingMore || store.isLoadingAll || store.isSyncing"
          class="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-slate-200 disabled:opacity-50 transition"
          @click="store.loadMoreMessages()"
        >
          {{
            store.isLoadingMore
              ? 'Indlæser flere...'
              : `Indlæs flere (${store.messages.length} af ${store.totalFolderMessages})`
          }}
        </button>
        <button
          type="button"
          :disabled="store.isLoadingMore || store.isLoadingAll || store.isSyncing"
          class="px-3 py-1.5 rounded-xl text-xs font-semibold bg-blue-600/20 hover:bg-blue-600/35 border border-blue-400/35 text-blue-200 disabled:opacity-50 transition"
          @click="store.loadAllMessages()"
        >
          {{
            store.isLoadingAll
              ? `Indlæser alle (${store.messages.length} af ${store.totalFolderMessages})...`
              : `Indlæs alle (${store.totalFolderMessages})`
          }}
        </button>
      </div>
    </div>
  </section>
</template>
