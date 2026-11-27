<script setup lang="ts">
import { computed } from 'vue';
import {
  Reply,
  ReplyAll,
  Forward,
  Pencil,
  Copy,
  Scissors,
  ClipboardPaste,
  MailOpen,
  Star,
  Trash2,
  FolderInput,
  Undo2,
  Filter,
  ShieldAlert,
  ShieldCheck,
  CalendarPlus,
  UserPlus,
  XCircle
} from 'lucide-vue-next';
import { useMailStore } from '../../stores/mailStore';
import { useSuiteStore } from '../../stores/suiteStore';

const store = useMailStore();
const suiteStore = useSuiteStore();

const selectedMessages = computed(() => {
  const idSet = new Set(store.selectedMessageIds);
  const list = store.messages.filter((m) => idSet.has(m.id));
  if (list.length > 0) return list;
  return store.contextMenu.targetMessage ? [store.contextMenu.targetMessage] : [];
});

const otherFolders = computed(() =>
  store.folders.filter((f) => f.path !== store.activeFolderPath)
);

async function handleEditDraft() {
  const target = store.contextMenu.targetMessage || selectedMessages.value[0];
  store.closeContextMenu();
  if (!target) return;
  await store.editDraftMessage(target);
}

async function handleReply(mode: 'REPLY' | 'REPLY_ALL' | 'FORWARD') {
  const target = store.contextMenu.targetMessage || selectedMessages.value[0];
  store.closeContextMenu();
  if (!target) return;
  await store.openMessage(target, false);
  store.openComposeModal(mode, store.activeMessageDetail);
}

function handleSaveSender() {
  const sender = store.contextMenu.targetMessage?.from?.[0];
  store.closeContextMenu();
  if (!sender?.address) return;
  suiteStore.saveSenderAsContact(sender.name, sender.address);
}

function handleCreateCalendarEvent() {
  const target = store.contextMenu.targetMessage;
  store.closeContextMenu();
  if (!target) return;
  suiteStore.createEventFromMail(target);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.contextMenu.visible"
      class="fixed inset-0 z-40"
      @click="store.closeContextMenu()"
      @contextmenu.prevent="store.closeContextMenu()"
    ></div>

    <div
      v-if="store.contextMenu.visible"
      class="fixed z-50 w-64 rounded-xl bg-slate-900/95 border border-slate-700 shadow-2xl backdrop-blur-md py-1.5 text-xs text-slate-200 select-none"
      :style="{ left: `${store.contextMenu.x}px`, top: `${store.contextMenu.y}px` }"
    >
      <!-- Hvis højreklikket på en besked -->
      <template v-if="store.contextMenu.targetMessage">
        <div class="px-3 py-1.5 border-b border-slate-800 text-[11px] font-semibold text-slate-400 truncate">
          {{ selectedMessages.length > 1 ? `${selectedMessages.length} e-mails valgt` : store.contextMenu.targetMessage.subject }}
        </div>

        <button
          v-if="store.isDraftMessage(store.contextMenu.targetMessage)"
          type="button"
          class="w-full px-3 py-1.5 hover:bg-amber-500/20 text-amber-200 font-semibold flex items-center justify-between border-b border-slate-800"
          @click="handleEditDraft"
        >
          <span class="flex items-center gap-2">
            <Pencil class="w-3.5 h-3.5 text-amber-400" /> Redigér kladde...
          </span>
        </button>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between"
          @click="handleReply('REPLY')"
        >
          <span class="flex items-center gap-2">
            <Reply class="w-3.5 h-3.5 text-blue-400" /> Besvar
          </span>
        </button>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between"
          @click="handleReply('REPLY_ALL')"
        >
          <span class="flex items-center gap-2">
            <ReplyAll class="w-3.5 h-3.5 text-blue-400" /> Besvar alle
          </span>
        </button>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between border-b border-slate-800 pb-2 mb-1"
          @click="handleReply('FORWARD')"
        >
          <span class="flex items-center gap-2">
            <Forward class="w-3.5 h-3.5 text-emerald-400" /> Videresend
          </span>
        </button>

        <!-- Suite kryds-handlinger -->
        <button
          v-if="suiteStore.isAnyModuleEnabled('calendar')"
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between"
          @click="handleCreateCalendarEvent"
        >
          <span class="flex items-center gap-2">
            <CalendarPlus class="w-3.5 h-3.5 text-sky-400" /> Opret kalenderaftale...
          </span>
        </button>

        <button
          v-if="suiteStore.isAnyModuleEnabled('contacts') && store.contextMenu.targetMessage.from[0]?.address"
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between border-b border-slate-800 pb-2 mb-1"
          @click="handleSaveSender"
        >
          <span class="flex items-center gap-2">
            <UserPlus class="w-3.5 h-3.5 text-emerald-400" /> Gem afsender i kontakter
          </span>
        </button>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between"
          @click="store.copyOrCutSelection('COPY', selectedMessages); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <Copy class="w-3.5 h-3.5 text-emerald-400" /> Kopiér til mappe
          </span>
          <kbd class="text-[10px] text-slate-400">Ctrl+C</kbd>
        </button>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between"
          @click="store.copyOrCutSelection('CUT', selectedMessages); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <Scissors class="w-3.5 h-3.5 text-amber-400" /> Klip (flyt til mappe)
          </span>
          <kbd class="text-[10px] text-slate-400">Ctrl+X</kbd>
        </button>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between"
          @click="store.toggleSeenForMessages(selectedMessages); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <MailOpen class="w-3.5 h-3.5 text-blue-400" /> Skift læst / ulæst
          </span>
        </button>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between"
          @click="store.toggleFlaggedForMessages(selectedMessages); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <Star class="w-3.5 h-3.5 text-amber-400" /> Skift stjernemarkering
          </span>
        </button>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between border-b border-slate-800 pb-2 mb-1"
          @click="store.openSieveModal(store.contextMenu.targetMessage); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <Filter class="w-3.5 h-3.5 text-purple-400" /> Opret Sieve-filter fra mail...
          </span>
        </button>

        <div v-if="otherFolders.length > 0" class="px-3 py-1 text-[10px] font-semibold uppercase text-slate-500">
          Flyt direkte til:
        </div>
        <div class="max-h-24 overflow-y-auto border-b border-slate-800 mb-1">
          <button
            v-for="f in otherFolders"
            :key="f.path"
            type="button"
            class="w-full px-3 py-1 hover:bg-slate-800 flex items-center gap-2 text-left truncate"
            @click="store.moveMessagesToFolder(selectedMessages, f.path); store.closeContextMenu()"
          >
            <FolderInput class="w-3 h-3 text-slate-400 shrink-0" />
            <span class="truncate">{{ f.name }}</span>
          </button>
        </div>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-orange-500/20 text-orange-300 flex items-center justify-between"
          @click="store.markMessagesAsSpam(selectedMessages); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <ShieldCheck v-if="store.activeFolder?.specialUse === 'junk'" class="w-3.5 h-3.5 text-emerald-400" />
            <ShieldAlert v-else class="w-3.5 h-3.5 text-orange-400" />
            {{ store.activeFolder?.specialUse === 'junk' ? 'Ikke spam (Flyt til Indbakke)' : 'Markér som Spam (Rspamd)' }}
          </span>
        </button>

        <button
          v-if="store.activeFolder?.specialUse !== 'trash'"
          type="button"
          class="w-full px-3 py-1.5 hover:bg-rose-500/20 text-rose-300 flex items-center justify-between"
          @click="store.deleteSelectedMessages(selectedMessages); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <Trash2 class="w-3.5 h-3.5" /> Flyt til papirkurv
          </span>
          <kbd class="text-[10px] text-rose-400">Del</kbd>
        </button>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-rose-600/25 text-rose-300 flex items-center justify-between"
          @click="store.deleteSelectedMessages(selectedMessages, true); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <XCircle class="w-3.5 h-3.5 text-rose-400" /> Slet permanent
          </span>
          <kbd class="text-[10px] text-rose-400">Shift+Del</kbd>
        </button>
      </template>

      <!-- Hvis højreklikket på en mappe i sidepanelet -->
      <template v-else-if="store.contextMenu.targetFolder">
        <div class="px-3 py-1.5 border-b border-slate-800 text-[11px] font-semibold text-slate-400 truncate">
          Mappe: {{ store.contextMenu.targetFolder.name }}
        </div>

        <button
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between"
          @click="store.markFolderAllAsRead(store.contextMenu.targetFolder.path); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <MailOpen class="w-3.5 h-3.5 text-blue-400" /> Markér alle som læst
          </span>
          <span
            v-if="store.contextMenu.targetFolder.unreadMessages > 0"
            class="px-1.5 py-0.2 rounded-full bg-blue-600/30 text-blue-300 text-[10px] font-bold"
          >
            {{ store.contextMenu.targetFolder.unreadMessages }}
          </span>
        </button>

        <button
          v-if="
            (store.contextMenu.targetFolder.specialUse === 'trash' ||
              store.contextMenu.targetFolder.specialUse === 'junk') &&
            store.contextMenu.targetFolder.totalMessages > 0
          "
          type="button"
          class="w-full px-3 py-1.5 hover:bg-rose-500/20 text-rose-300 flex items-center justify-between"
          @click="store.emptyFolder(store.contextMenu.targetFolder.path); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <Trash2 class="w-3.5 h-3.5 text-rose-400" />
            {{ store.contextMenu.targetFolder.specialUse === 'trash' ? 'Tøm papirkurv' : 'Tøm spam' }}
          </span>
        </button>

        <button
          type="button"
          :disabled="store.clipboard.messages.length === 0"
          class="w-full px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40 flex items-center justify-between"
          @click="store.pasteClipboardToFolder(store.contextMenu.targetFolder.path); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <ClipboardPaste class="w-3.5 h-3.5 text-emerald-400" /> Indsæt her ({{ store.clipboard.messages.length }})
          </span>
          <kbd class="text-[10px] text-slate-400">Ctrl+V</kbd>
        </button>

        <button
          v-if="store.undoStack.length > 0"
          type="button"
          class="w-full px-3 py-1.5 hover:bg-slate-800 flex items-center justify-between"
          @click="store.triggerUndo(); store.closeContextMenu()"
        >
          <span class="flex items-center gap-2">
            <Undo2 class="w-3.5 h-3.5 text-blue-400" /> Fortryd seneste
          </span>
          <kbd class="text-[10px] text-slate-400">Ctrl+Z</kbd>
        </button>
      </template>
    </div>
  </Teleport>
</template>
