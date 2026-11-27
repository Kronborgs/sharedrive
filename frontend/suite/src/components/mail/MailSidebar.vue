<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  Inbox,
  Send,
  FileEdit,
  Trash2,
  Archive,
  ShieldAlert,
  Folder,
  Plus,
  AtSign,
  Pencil,
  Filter,
  X,
  Smartphone
} from 'lucide-vue-next';
import { useMailStore } from '../../stores/mailStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';
import type { MailFolder, MailHeader } from '../../types/mail';

const props = defineProps<{
  width: number;
  mobileDrawer?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close-drawer'): void;
}>();

const store = useMailStore();
const { currentTheme } = useTheme();
const { isStandalonePwa, displayModeLabel } = useViewport();

const showNewFolderForm = ref(false);
const newFolderName = ref('');
const isCreatingFolder = ref(false);
const dragOverFolderPath = ref<string | null>(null);

const selectedMessagesList = computed<MailHeader[]>(() => {
  if (store.selectedMessageIds.length === 0) return [];
  const idSet = new Set(store.selectedMessageIds);
  return store.messages.filter((m) => idSet.has(m.id));
});

function getFolderIcon(specialUse: MailFolder['specialUse']) {
  switch (specialUse) {
    case 'inbox':
      return Inbox;
    case 'sent':
      return Send;
    case 'drafts':
      return FileEdit;
    case 'trash':
      return Trash2;
    case 'archive':
      return Archive;
    case 'junk':
      return ShieldAlert;
    default:
      return Folder;
  }
}

function getFolderColorClass(specialUse: MailFolder['specialUse']) {
  switch (specialUse) {
    case 'inbox':
      return 'text-blue-400';
    case 'sent':
      return 'text-emerald-400';
    case 'drafts':
      return 'text-amber-400';
    case 'trash':
      return 'text-rose-400';
    case 'archive':
      return 'text-purple-400';
    case 'junk':
      return 'text-orange-400';
    default:
      return 'text-slate-400';
  }
}

async function submitNewFolder() {
  if (!newFolderName.value.trim()) return;
  isCreatingFolder.value = true;
  try {
    const ok = await store.createFolder(newFolderName.value.trim());
    if (ok) {
      newFolderName.value = '';
      showNewFolderForm.value = false;
    }
  } finally {
    isCreatingFolder.value = false;
  }
}

async function promptRenameFolder(folder: MailFolder) {
  const newPath = window.prompt(`Omdøb mappen "${folder.name}" til:`, folder.path);
  if (newPath && newPath.trim() && newPath.trim() !== folder.path) {
    await store.renameFolder(folder.path, newPath.trim());
  }
}

async function confirmDeleteFolder(folder: MailFolder) {
  const ok = window.confirm(
    `Slet mappen "${folder.name}" permanent?\n\nAlle e-mails i mappen slettes også på IMAP-serveren.`
  );
  if (ok) {
    await store.deleteFolder(folder.path);
  }
}

function handleDragOver(e: DragEvent, folderPath: string) {
  e.preventDefault();
  dragOverFolderPath.value = folderPath;
}

function handleDragLeave(folderPath: string) {
  if (dragOverFolderPath.value === folderPath) {
    dragOverFolderPath.value = null;
  }
}

async function handleDropOnFolder(e: DragEvent, targetFolder: MailFolder) {
  e.preventDefault();
  dragOverFolderPath.value = null;
  const sel = selectedMessagesList.value;
  if (sel.length > 0) {
    await store.moveMessagesToFolder(sel, targetFolder.path);
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
    <!-- Top: IMAP Mapper -->
    <div class="space-y-4">
      <div>
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-xs font-bold uppercase tracking-wider text-slate-400 truncate">
            IMAP Mapper
          </h2>
          <div class="flex items-center gap-1.5 shrink-0">
            <span class="text-[11px] text-slate-500">
              {{ store.folders.length }}
            </span>
            <button
              type="button"
              class="p-1 rounded-md bg-slate-800 hover:bg-blue-600 text-slate-300 hover:text-white border border-slate-700 transition"
              title="Opret ny IMAP-mappe"
              @click="showNewFolderForm = !showNewFolderForm"
            >
              <Plus class="w-3.5 h-3.5" />
            </button>
            <button
              v-if="props.mobileDrawer"
              type="button"
              class="p-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition"
              title="Luk sidepanel"
              @click="emit('close-drawer')"
            >
              <X class="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <!-- Formular til ny IMAP-mappe -->
        <form
          v-if="showNewFolderForm"
          class="mb-2.5 p-2.5 rounded-xl bg-slate-950 border border-blue-500/40 space-y-2"
          @submit.prevent="submitNewFolder"
        >
          <input
            v-model="newFolderName"
            type="text"
            required
            placeholder="Mappenavn (f.eks. Fakturaer)..."
            class="w-full px-2.5 py-1.5 text-xs bg-slate-900 border border-slate-700 rounded-lg text-slate-100 focus:outline-none focus:border-blue-500"
          />
          <div class="flex items-center justify-end gap-1.5">
            <button
              type="button"
              class="px-2 py-1 rounded-lg text-[11px] text-slate-300 hover:bg-slate-800"
              @click="showNewFolderForm = false"
            >
              Annullér
            </button>
            <button
              type="submit"
              :disabled="isCreatingFolder"
              class="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              {{ isCreatingFolder ? 'Opretter...' : 'Opret mappe' }}
            </button>
          </div>
        </form>

        <!-- Liste af mapper (understøtter også træk-og-slip samt skjult Ctrl+C / Ctrl+X / Ctrl+V af e-mails) -->
        <div class="space-y-1">
          <div
            v-for="folder in store.folders"
            :key="folder.path"
            class="group px-2.5 py-2 rounded-xl border transition flex items-center justify-between gap-2 cursor-pointer"
            :class="[
              store.activeFolderPath === folder.path
                ? 'bg-blue-600/20 border-blue-500/50 text-white shadow-sm'
                : 'bg-slate-800/50 hover:bg-slate-800 border-slate-800 text-slate-200',
              dragOverFolderPath === folder.path ? 'ring-2 ring-blue-400 bg-blue-600/30' : ''
            ]"
            @click="store.selectFolder(folder.path); if (props.mobileDrawer) emit('close-drawer')"
            @contextmenu.prevent="store.openFolderContextMenu($event, folder)"
            @dragover="handleDragOver($event, folder.path)"
            @dragleave="handleDragLeave(folder.path)"
            @drop="handleDropOnFolder($event, folder)"
          >
            <div class="flex items-center gap-2.5 min-w-0 flex-1">
              <component
                :is="getFolderIcon(folder.specialUse)"
                class="w-4 h-4 shrink-0"
                :class="getFolderColorClass(folder.specialUse)"
              />
              <span class="text-xs font-medium truncate" :title="folder.path">
                {{ folder.name }}
              </span>
            </div>

            <div class="flex items-center gap-1 shrink-0">
              <!-- Omdøb / Slet på brugerdefinerede mapper ved hover -->
              <template v-if="folder.specialUse === 'custom'">
                <button
                  type="button"
                  class="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition"
                  title="Omdøb mappe"
                  @click.stop="promptRenameFolder(folder)"
                >
                  <Pencil class="w-3 h-3" />
                </button>
                <button
                  type="button"
                  class="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition"
                  title="Slet mappe"
                  @click.stop="confirmDeleteFolder(folder)"
                >
                  <Trash2 class="w-3 h-3" />
                </button>
              </template>

              <span
                v-if="folder.unreadMessages > 0"
                class="px-1.5 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-bold"
                title="Ulæste beskeder"
              >
                {{ folder.unreadMessages }}
              </span>
              <span
                v-else-if="folder.totalMessages > 0"
                class="text-[10px] text-slate-500 font-medium"
              >
                {{ folder.totalMessages }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bund: Hurtig adgang til Afsender-Aliaser & Sieve Mail-Filtre (Udklipsholder kører usynligt i baggrunden med Ctrl+C / Ctrl+X / Ctrl+V) -->
    <div class="pt-3 border-t border-slate-800 space-y-2">
      <div class="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          class="flex items-center justify-between px-2 py-2 rounded-xl bg-blue-600/15 hover:bg-blue-600/25 border border-blue-500/30 text-xs text-blue-300 font-semibold transition"
          title="Administrér dine afsender-aliaser"
          @click="store.isAliasModalOpen = true; if (props.mobileDrawer) emit('close-drawer')"
        >
          <span class="flex items-center gap-1 truncate">
            <AtSign class="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span class="truncate">Aliaser</span>
          </span>
          <span class="px-1.5 py-0.5 rounded-full bg-slate-900 text-blue-300 text-[10px] font-bold shrink-0">
            {{ store.aliases.length }}
          </span>
        </button>

        <button
          type="button"
          class="flex items-center justify-center gap-1.5 px-2 py-2 rounded-xl bg-purple-600/15 hover:bg-purple-600/25 border border-purple-500/30 text-xs text-purple-300 font-semibold transition"
          title="Sieve Mail-Filtre & Regler på Mailcow/SOGo (Port 4190)"
          @click="store.openSieveModal(); if (props.mobileDrawer) emit('close-drawer')"
        >
          <Filter class="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span class="truncate">Sieve Filtre</span>
        </button>
      </div>

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
