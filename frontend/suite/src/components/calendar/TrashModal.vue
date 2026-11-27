<script setup lang="ts">
import { Trash2, RotateCcw, X, Clock } from 'lucide-vue-next';
import { useCalendarStore } from '../../stores/calendarStore';

const store = useCalendarStore();

function daysRemaining(expiresAtIso: string): number {
  const diff = new Date(expiresAtIso).getTime() - Date.now();
  return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('da-DK', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.isTrashModalOpen"
      class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      @click.self="store.isTrashModalOpen = false"
    >
      <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Trash2 class="w-4 h-4 text-rose-400" />
            <h3 class="text-base font-bold text-slate-100">
              Lokal Papirkurv (Opbevares i 30 dage)
            </h3>
          </div>
          <button
            type="button"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            @click="store.isTrashModalOpen = false"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <div class="p-5 overflow-y-auto flex-1 space-y-2.5 text-xs">
          <div
            v-if="store.trashItems.length === 0"
            class="py-12 text-center text-slate-400"
          >
            Papirkurven er tom. Slettede begivenheder gemmes her i 30 dage.
          </div>

          <div
            v-for="item in store.trashItems"
            :key="item.id"
            class="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between gap-3"
          >
            <div class="min-w-0 flex-1">
              <div class="font-semibold text-slate-100 truncate">
                {{ item.event.title }}
              </div>
              <div class="text-[11px] text-slate-400 mt-0.5">
                Start: {{ formatDate(item.event.start) }}
              </div>
              <div class="flex items-center gap-1 text-[10px] text-amber-400/90 mt-1">
                <Clock class="w-3 h-3" />
                Udløber automatisk om {{ daysRemaining(item.expiresAt) }} dage
              </div>
            </div>

            <div class="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                class="px-2.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 flex items-center gap-1 font-medium transition"
                @click="store.restoreFromTrash(item.id)"
              >
                <RotateCcw class="w-3.5 h-3.5" /> Gendan
              </button>
              <button
                type="button"
                class="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition"
                title="Slet permanent nu"
                @click="store.permanentlyDeleteFromTrash(item.id)"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div class="px-5 py-3.5 border-t border-slate-800 flex items-center justify-between text-xs">
          <button
            v-if="store.trashItems.length > 0"
            type="button"
            class="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 font-medium transition"
            @click="store.emptyTrash()"
          >
            Tøm papirkurv permanent
          </button>
          <div v-else></div>
          <button
            type="button"
            class="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition"
            @click="store.isTrashModalOpen = false"
          >
            Luk
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
