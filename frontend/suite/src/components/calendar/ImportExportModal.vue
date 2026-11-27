<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  Upload,
  Download,
  FileSpreadsheet,
  X,
  CheckCircle2,
  AlertCircle
} from 'lucide-vue-next';
import { useCalendarStore } from '../../stores/calendarStore';

const store = useCalendarStore();

const importTargetCalendarId = ref('');
const exportTargetCalendarId = ref('ALL');
const selectedFileName = ref('');
const rawIcsContent = ref('');
const detectedEventCount = ref(0);
const isImporting = ref(false);
const isExporting = ref(false);
const errorMsg = ref('');

watch(
  () => store.isImportExportModalOpen,
  (isOpen) => {
    if (!isOpen) return;
    errorMsg.value = '';
    selectedFileName.value = '';
    rawIcsContent.value = '';
    detectedEventCount.value = 0;

    const pre = store.preselectedImportExportCalendarId;
    if (pre && store.writableCalendars.some((c) => c.id === pre)) {
      importTargetCalendarId.value = pre;
    } else {
      importTargetCalendarId.value = store.writableCalendars[0]?.id || '';
    }

    exportTargetCalendarId.value = pre || (store.calendars[0]?.id || 'ALL');
  }
);

const exportEventCount = computed(() => {
  if (exportTargetCalendarId.value === 'ALL') {
    return store.visibleEvents.length;
  }
  return store.events.filter((e) => e.calendarId === exportTargetCalendarId.value).length;
});

async function handleFileSelect(e: Event) {
  errorMsg.value = '';
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  selectedFileName.value = file.name;

  try {
    const buffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(buffer);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(uint8);
    } catch {
      text = new TextDecoder('windows-1252').decode(uint8);
    }

    rawIcsContent.value = text;
    const matches = text.match(/BEGIN:VEVENT/gi);
    detectedEventCount.value = matches ? matches.length : 0;

    if (detectedEventCount.value === 0) {
      errorMsg.value = 'Filen indeholder ingen gyldige VEVENT-begivenheder.';
    }
  } catch {
    errorMsg.value = 'Kunne ikke læse den valgte .ics-fil.';
  }
}

async function handleImport() {
  if (!importTargetCalendarId.value || !rawIcsContent.value || detectedEventCount.value === 0) {
    return;
  }
  errorMsg.value = '';
  isImporting.value = true;
  try {
    const count = await store.importIcsFile(importTargetCalendarId.value, rawIcsContent.value);
    if (count > 0) {
      store.isImportExportModalOpen = false;
    }
  } catch (err: any) {
    errorMsg.value = err?.message || 'Import af .ics-fil mislykkedes.';
  } finally {
    isImporting.value = false;
  }
}

async function handleExport() {
  errorMsg.value = '';
  isExporting.value = true;
  try {
    await store.exportCalendarIcs(exportTargetCalendarId.value);
  } catch (err: any) {
    errorMsg.value = err?.message || 'Eksport af kalender mislykkedes.';
  } finally {
    isExporting.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.isImportExportModalOpen"
      class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      @click.self="store.isImportExportModalOpen = false"
    >
      <div class="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        <!-- Header -->
        <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <FileSpreadsheet class="w-4 h-4 text-blue-400" />
            <h3 class="text-base font-bold text-slate-100">
              Importér &amp; Eksportér Kalender (.ics)
            </h3>
          </div>
          <button
            type="button"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            @click="store.isImportExportModalOpen = false"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <div class="p-5 overflow-y-auto space-y-5 text-xs">
          <div
            v-if="errorMsg"
            class="p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 flex items-start gap-2"
          >
            <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
            <span>{{ errorMsg }}</span>
          </div>

          <!-- Sektion 1: Importér .ics fil -->
          <form class="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3.5" @submit.prevent="handleImport">
            <div class="flex items-center gap-2 font-bold text-slate-100 text-sm">
              <Upload class="w-4 h-4 text-emerald-400" />
              <span>Importér .ics-fil til kalender</span>
            </div>

            <div>
              <label class="block text-slate-400 font-medium mb-1">Vælg mål-kalender</label>
              <select
                v-model="importTargetCalendarId"
                required
                class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option
                  v-for="cal in store.writableCalendars"
                  :key="cal.id"
                  :value="cal.id"
                >
                  {{ cal.name }}
                </option>
              </select>
            </div>

            <div>
              <label class="block text-slate-400 font-medium mb-1">Vælg .ics-fil fra din computer</label>
              <label class="w-full flex flex-col items-center justify-center px-4 py-4 rounded-xl border-2 border-dashed border-slate-700 hover:border-blue-500 bg-slate-900/60 cursor-pointer transition text-center">
                <Upload class="w-5 h-5 text-slate-400 mb-1" />
                <span v-if="!selectedFileName" class="text-slate-300 font-medium">
                  Klik for at vælge en <code>.ics</code>-fil
                </span>
                <span v-else class="text-emerald-300 font-semibold">
                  {{ selectedFileName }}
                </span>
                <span v-if="detectedEventCount > 0" class="inline-flex items-center gap-1 text-[11px] text-emerald-400 mt-1">
                  <CheckCircle2 class="w-3.5 h-3.5" />
                  Fandt {{ detectedEventCount }} begivenhed(er) klar til import
                </span>
                <input
                  type="file"
                  accept=".ics,text/calendar"
                  class="hidden"
                  @change="handleFileSelect"
                />
              </label>
            </div>

            <button
              type="submit"
              :disabled="isImporting || detectedEventCount === 0 || !importTargetCalendarId"
              class="w-full py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold flex items-center justify-center gap-1.5 shadow transition"
            >
              <Upload class="w-4 h-4" />
              {{
                isImporting
                  ? 'Importerer begivenheder...'
                  : `Importér ${detectedEventCount > 0 ? detectedEventCount : ''} begivenhed(er)`
              }}
            </button>
          </form>

          <!-- Sektion 2: Eksportér kalender til .ics -->
          <div class="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3.5">
            <div class="flex items-center gap-2 font-bold text-slate-100 text-sm">
              <Download class="w-4 h-4 text-blue-400" />
              <span>Eksportér kalender til .ics-fil</span>
            </div>

            <div>
              <label class="block text-slate-400 font-medium mb-1">Vælg kalender der skal eksporteres</label>
              <select
                v-model="exportTargetCalendarId"
                class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option
                  v-for="cal in store.calendars"
                  :key="cal.id"
                  :value="cal.id"
                >
                  {{ cal.name }}
                </option>
                <option value="ALL">Alle synlige kalendere samlet</option>
              </select>
              <p class="text-[11px] text-slate-400 mt-1.5">
                Indeholder <strong>{{ exportEventCount }}</strong> begivenhed(er).
              </p>
            </div>

            <button
              type="button"
              :disabled="isExporting || exportEventCount === 0"
              class="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold flex items-center justify-center gap-1.5 shadow transition"
              @click="handleExport"
            >
              <Download class="w-4 h-4" />
              {{ isExporting ? 'Genererer .ics-fil...' : 'Download .ics-fil' }}
            </button>
          </div>
        </div>

        <div class="px-5 py-3 border-t border-slate-800 flex justify-end">
          <button
            type="button"
            class="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
            @click="store.isImportExportModalOpen = false"
          >
            Luk
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
