<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  Inbox,
  ChevronRight,
  Send,
  FileEdit,
  Trash2,
  Archive,
  ShieldAlert,
  Folder,
  Plus,
  Upload,
  Download,
  AtSign,
  Pencil,
  Filter,
  X,
  Smartphone
} from 'lucide-vue-next';
import { useMailStore } from '../../stores/mailStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';
import { downloadMboxFile, importEmlFile, importMboxFile } from '../../services/mailApi';
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
const isImportingMail = ref(false);
const isTransferringMbox = ref(false);
const transferDisabled = computed(() => isImportingMail.value || isTransferringMbox.value || !store.activeFolder);

async function handleEmlImport(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length || isImportingMail.value) return;
  const folder = store.activeFolderPath;
  const folderName = store.activeFolder?.name || folder;
  isImportingMail.value = true;
  let count = 0;
  const errors: string[] = [];
  try {
    for (const file of files) {
      try {
        await importEmlFile(folder, file);
        count++;
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : 'Import fejlede.'}`);
      }
    }
    if (count) await store.syncWithServer(true);
    const summary = `${count} af ${files.length} mail(s) importeret til ${folderName}.`;
    store.notify('Mailimport', errors.length ? `${summary} ${errors.join(' ')}` : summary, errors.length ? 'warning' : 'success');
  } finally {
    isImportingMail.value = false;
  }
}
async function handleMboxImport(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || transferDisabled.value) return;
  const folder = store.activeFolderPath;
  const folderName = store.activeFolder?.name || folder;
  isTransferringMbox.value = true;
  try {
    const { imported, total } = await importMboxFile(folder, file);
    const summary = `${imported} af ${total} mails importeret til ${folderName}.`;
    const partial = imported < total;
    store.notify('MBOX-import', partial ? summary + ' Importen stoppede. En ny import af hele arkivet kan give dubletter.' : summary,
      partial ? 'warning' : 'success');
    await store.syncWithServer(true);
  } catch (error) {
    store.notify('MBOX-import fejlede', error instanceof Error ? error.message : undefined, 'error');
  } finally {
    isTransferringMbox.value = false;
  }
}

async function handleMboxExport() {
  if (transferDisabled.value) return;
  const folder = store.activeFolderPath;
  const name = store.activeFolder?.name || folder;
  isTransferringMbox.value = true;
  try {
    const archive = await downloadMboxFile(folder);
    const url = URL.createObjectURL(archive);
    const link = document.createElement('a');
    link.href = url;
    link.download = name.replace(/[\\/<>:"|?*\u0000-\u001f]/g, '_') + '.mbox';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (error) {
    store.notify('MBOX-eksport fejlede', error instanceof Error ? error.message : undefined, 'error');
  } finally {
    isTransferringMbox.value = false;
  }
}

const collapsedFolders = ref(new Set<string>());

type FolderRow = { folder: MailFolder; depth: number; hasChildren: boolean };

function folderKey(path: string, delimiter: string) {
  const separator = delimiter ? path.indexOf(delimiter) : -1;
  const root = separator < 0 ? path : path.slice(0, separator);
  return root.toUpperCase() === 'INBOX' ? 'INBOX' + path.slice(root.length) : path;
}

const visibleFolders = computed(() => {
  const paths = new Map(store.folders.map((folder) => [folderKey(folder.path, folder.delimiter), folder.path]));
  const children = new Map<string | null, MailFolder[]>();

  for (const folder of store.folders) {
    const delimiter = folder.delimiter;
    let parent: string | undefined;
    let path = folder.path;
    while (delimiter && !parent) {
      const separator = path.lastIndexOf(delimiter);
      if (separator < 1) break;
      path = path.slice(0, separator);
      parent = paths.get(folderKey(path, delimiter));
    }
    const siblings = children.get(parent ?? null) ?? [];
    siblings.push(folder);
    children.set(parent ?? null, siblings);
  }

  const rows: FolderRow[] = [];
  function append(parent: string | null, depth: number) {
    for (const folder of children.get(parent) ?? []) {
      const hasChildren = children.has(folder.path);
      rows.push({ folder, depth, hasChildren });
      if (hasChildren && !collapsedFolders.value.has(folder.path)) append(folder.path, depth + 1);
    }
  }
  append(null, 0);
  return rows;
});

function toggleFolder(path: string) {
  if (!collapsedFolders.value.delete(path)) collapsedFolders.value.add(path);
}

function selectFolder(path: string) {
  void store.selectFolder(path);
  if (props.mobileDrawer) emit('close-drawer');
}

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
            v-for="{ folder, depth, hasChildren } in visibleFolders"
            :key="folder.path"
            class="group flex items-center gap-1 rounded-xl border pr-2 transition"
            :style="{ paddingInlineStart: `${4 + Math.min(depth, 6) * 14}px` }"
            :class="[
              store.activeFolderPath === folder.path
                ? 'bg-blue-600/20 border-blue-500/50 text-white shadow-sm'
                : 'bg-slate-800/50 hover:bg-slate-800 border-slate-800 text-slate-200',
              dragOverFolderPath === folder.path ? 'ring-2 ring-blue-400 bg-blue-600/30' : ''
            ]"
            @contextmenu.prevent="store.openFolderContextMenu($event, folder)"
            @dragover="handleDragOver($event, folder.path)"
            @dragleave="handleDragLeave(folder.path)"
            @drop="handleDropOnFolder($event, folder)"
          >
            <button
              v-if="hasChildren"
              type="button"
              class="grid h-7 w-6 shrink-0 place-items-center rounded hover:bg-slate-700"
              :aria-label="collapsedFolders.has(folder.path) ? `Vis undermapper under ${folder.name}` : `Skjul undermapper under ${folder.name}`"
              :aria-expanded="!collapsedFolders.has(folder.path)"
              @click="toggleFolder(folder.path)"
            >
              <ChevronRight class="h-3.5 w-3.5" :class="{ 'rotate-90': !collapsedFolders.has(folder.path) }" aria-hidden="true" />
            </button>
            <span v-else class="w-6 shrink-0" aria-hidden="true" />

            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded py-2 text-left"
              :aria-current="store.activeFolderPath === folder.path ? 'true' : undefined"
              @click="selectFolder(folder.path)"
            >
              <component
                :is="getFolderIcon(folder.specialUse)"
                class="w-4 h-4 shrink-0"
                :class="getFolderColorClass(folder.specialUse)"
              />
              <span class="text-xs font-medium truncate" :title="folder.path">
                {{ folder.name }}
              </span>
            </button>

            <div class="flex items-center gap-1 shrink-0">
              <!-- Omdøb / Slet på brugerdefinerede mapper ved hover -->
              <template v-if="folder.specialUse === 'custom'">
                <button
                  type="button"
                  class="hidden group-hover:block group-focus-within:block p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200"
                  title="Omdøb mappe"
                  @click.stop="promptRenameFolder(folder)"
                >
                  <Pencil class="w-3 h-3" />
                </button>
                <button
                  type="button"
                  class="hidden group-hover:block group-focus-within:block p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400"
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
          title="Signaturer og afsenderadresser"
          @click="store.isAliasModalOpen = true; if (props.mobileDrawer) emit('close-drawer')"
        >
          <span class="flex items-center gap-1 truncate">
            <AtSign class="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span class="truncate">Signaturer</span>
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

      <label
        class="flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-slate-200 hover:bg-slate-700 focus-within:ring-2 focus-within:ring-blue-400"
        :title="`Importér .eml-filer til ${store.activeFolder?.name || store.activeFolderPath}`"
      >
        <Upload class="h-3.5 w-3.5 text-emerald-400" />
        {{ isImportingMail ? 'Importerer…' : 'Importér mail (.eml)' }}
        <input class="sr-only" type="file" accept=".eml,message/rfc822" multiple
          aria-label="Importér mail (.eml)" :disabled="transferDisabled"
          @change="handleEmlImport" />
      </label>

      <div class="grid grid-cols-2 gap-1.5">
        <label class="flex cursor-pointer items-center justify-center gap-1 rounded-xl border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-slate-200 hover:bg-slate-700 focus-within:ring-2 focus-within:ring-blue-400 has-disabled:cursor-not-allowed has-disabled:opacity-50"
          :title="`Importér MBOX til ${store.activeFolder?.name || store.activeFolderPath} (maks. 20 MiB)`">
          <Upload class="h-3.5 w-3.5 shrink-0" />
          Importér MBOX
          <input class="sr-only" type="file" accept=".mbox,application/mbox"
            aria-label="Importér MBOX" :disabled="transferDisabled" @change="handleMboxImport" />
        </label>
        <button type="button" :disabled="transferDisabled"
          class="flex items-center justify-center gap-1 rounded-xl border border-slate-700 bg-slate-800 px-2 py-2 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
          :title="`Eksportér ${store.activeFolder?.name || store.activeFolderPath} til MBOX (maks. 20 MiB)`"
          @click="handleMboxExport">
          <Download class="h-3.5 w-3.5 shrink-0" />
          Eksportér MBOX
        </button>
      </div>
      <output v-if="isTransferringMbox" class="block text-center text-xs text-slate-300">Overfører MBOX…</output>

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
