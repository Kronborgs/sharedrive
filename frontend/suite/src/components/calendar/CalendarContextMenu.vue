<script setup lang="ts">
import { computed } from 'vue';
import {
  Copy,
  Scissors,
  ClipboardPaste,
  Edit3,
  Trash2,
  Plus,
  Lock,
  ShieldAlert,
  Undo2
} from 'lucide-vue-next';
import { useCalendarStore } from '../../stores/calendarStore';

const store = useCalendarStore();

const targetEvent = computed(() => store.contextMenu.event || null);

const isReadOnlyEvent = computed(() => {
  if (!targetEvent.value) return false;
  return store.isCalendarReadOnly(targetEvent.value.calendarId);
});

const hasMeetingGuests = computed(() => {
  if (!targetEvent.value) return false;
  return store.hasInvitedAttendees(targetEvent.value);
});

function handleCopy() {
  if (targetEvent.value) {
    store.copyOrCutSelection('COPY', [targetEvent.value]);
  } else {
    store.copyOrCutSelection('COPY');
  }
  store.closeContextMenu();
}

function handleCut() {
  if (targetEvent.value) {
    store.copyOrCutSelection('CUT', [targetEvent.value]);
  } else {
    store.copyOrCutSelection('CUT');
  }
  store.closeContextMenu();
}

async function handlePaste() {
  const dateTarget = store.contextMenu.dateStr || store.selectedDateStr;
  await store.pasteToDate(dateTarget || undefined);
  store.closeContextMenu();
}

function handleEdit() {
  if (targetEvent.value) {
    store.openEditEventModal(targetEvent.value);
  }
  store.closeContextMenu();
}

function handleCreateNew() {
  store.openCreateEventModal(
    store.contextMenu.dateStr || store.selectedDateStr,
    Boolean(store.contextMenu.allDay)
  );
  store.closeContextMenu();
}

async function handleDelete() {
  if (targetEvent.value) {
    await store.deleteEventsByIds([targetEvent.value.id]);
  } else if (store.selectedEventIds.length > 0) {
    await store.deleteEventsByIds(store.selectedEventIds);
  }
  store.closeContextMenu();
}

async function handleUndo() {
  await store.triggerUndo();
  store.closeContextMenu();
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.contextMenu.visible"
      class="fixed inset-0 z-50"
      @click="store.closeContextMenu()"
      @contextmenu.prevent="store.closeContextMenu()"
    >
      <div
        class="fixed w-64 rounded-xl bg-slate-900/95 backdrop-blur-md border border-slate-700 shadow-2xl py-1.5 text-xs text-slate-200 select-none"
        :style="{ left: `${store.contextMenu.x}px`, top: `${store.contextMenu.y}px` }"
        @click.stop
      >
        <!-- Header info -->
        <div class="px-3 py-1.5 border-b border-slate-800 mb-1">
          <div v-if="targetEvent" class="font-semibold text-slate-100 truncate">
            {{ targetEvent.title }}
          </div>
          <div v-else class="font-semibold text-slate-100">
            Dato: {{ store.contextMenu.dateStr?.slice(0, 10) || store.selectedDateStr }}
          </div>
          <div v-if="isReadOnlyEvent" class="flex items-center gap-1 text-[10px] text-amber-400 mt-0.5">
            <Lock class="w-3 h-3" /> Delt Read-Only kalender
          </div>
          <div v-if="hasMeetingGuests" class="flex items-center gap-1 text-[10px] text-purple-300 mt-0.5">
            <ShieldAlert class="w-3 h-3" /> Mødesikkerhed: Har deltagere (Ctrl+C låst)
          </div>
        </div>

        <!-- Hvis der højreklikkes på en begivenhed -->
        <template v-if="targetEvent">
          <button
            type="button"
            class="w-full px-3 py-2 hover:bg-slate-800 flex items-center justify-between transition"
            @click="handleEdit"
          >
            <span class="flex items-center gap-2">
              <Edit3 class="w-3.5 h-3.5 text-blue-400" />
              {{ isReadOnlyEvent ? 'Se detaljer / RSVP' : 'Redigér begivenhed' }}
            </span>
            <span class="text-[10px] text-slate-400">Dobbeltklik</span>
          </button>

          <button
            type="button"
            :disabled="hasMeetingGuests"
            class="w-full px-3 py-2 hover:bg-slate-800 flex items-center justify-between transition disabled:opacity-40 disabled:cursor-not-allowed"
            @click="handleCopy"
          >
            <span class="flex items-center gap-2">
              <Copy class="w-3.5 h-3.5 text-emerald-400" />
              Kopiér begivenhed
            </span>
            <kbd class="text-[10px] text-slate-400">Ctrl+C</kbd>
          </button>

          <button
            type="button"
            :disabled="isReadOnlyEvent || hasMeetingGuests"
            class="w-full px-3 py-2 hover:bg-slate-800 flex items-center justify-between transition disabled:opacity-40 disabled:cursor-not-allowed"
            @click="handleCut"
          >
            <span class="flex items-center gap-2">
              <Scissors class="w-3.5 h-3.5 text-amber-400" />
              Klip begivenhed
            </span>
            <kbd class="text-[10px] text-slate-400">Ctrl+X</kbd>
          </button>
        </template>

        <!-- Hvis der højreklikkes på en dato -->
        <template v-else>
          <button
            type="button"
            class="w-full px-3 py-2 hover:bg-slate-800 flex items-center justify-between transition"
            @click="handleCreateNew"
          >
            <span class="flex items-center gap-2">
              <Plus class="w-3.5 h-3.5 text-blue-400" />
              Ny begivenhed her
            </span>
            <span class="text-[10px] text-slate-400">Dobbeltklik</span>
          </button>

          <button
            type="button"
            class="w-full px-3 py-2 hover:bg-slate-800 flex items-center justify-between transition"
            @click="handleCopy"
          >
            <span class="flex items-center gap-2">
              <Copy class="w-3.5 h-3.5 text-emerald-400" />
              Kopiér begivenhed
            </span>
            <kbd class="text-[10px] text-slate-400">Ctrl+C</kbd>
          </button>
        </template>

        <!-- Indsæt (Ctrl+V) -->
        <button
          type="button"
          :disabled="store.clipboard.events.length === 0"
          class="w-full px-3 py-2 hover:bg-slate-800 flex items-center justify-between transition disabled:opacity-40 disabled:cursor-not-allowed"
          @click="handlePaste"
        >
          <span class="flex items-center gap-2">
            <ClipboardPaste class="w-3.5 h-3.5 text-sky-400" />
            Indsæt på {{ store.contextMenu.dateStr?.slice(0, 10) || store.selectedDateStr }}
          </span>
          <kbd class="text-[10px] text-slate-400">Ctrl+V</kbd>
        </button>

        <div class="my-1 border-t border-slate-800"></div>

        <!-- Fortryd (Ctrl+Z) -->
        <button
          type="button"
          :disabled="store.undoStack.length === 0"
          class="w-full px-3 py-2 hover:bg-slate-800 flex items-center justify-between transition disabled:opacity-40 disabled:cursor-not-allowed"
          @click="handleUndo"
        >
          <span class="flex items-center gap-2">
            <Undo2 class="w-3.5 h-3.5 text-slate-300" />
            Fortryd seneste
          </span>
          <kbd class="text-[10px] text-slate-400">Ctrl+Z</kbd>
        </button>

        <!-- Slet -->
        <button
          v-if="targetEvent"
          type="button"
          :disabled="isReadOnlyEvent"
          class="w-full px-3 py-2 hover:bg-rose-500/15 text-rose-400 flex items-center justify-between transition disabled:opacity-40 disabled:cursor-not-allowed"
          @click="handleDelete"
        >
          <span class="flex items-center gap-2">
            <Trash2 class="w-3.5 h-3.5" />
            Flyt til papirkurv
          </span>
          <kbd class="text-[10px] text-rose-300/80">Del</kbd>
        </button>
      </div>
    </div>
  </Teleport>
</template>
