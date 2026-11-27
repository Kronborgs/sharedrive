<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import {
  Filter,
  Plus,
  Trash2,
  Check,
  X,
  ArrowUp,
  ArrowDown,
  Code,
  Sliders,
  RefreshCw,
  FolderInput,
  AlertCircle,
  Power
} from 'lucide-vue-next';
import { useMailStore } from '../../stores/mailStore';
import type { SieveRule, SieveCondition, SieveAction } from '../../types/mail';

const store = useMailStore();

const activeTab = ref<'VISUAL' | 'RAW'>('VISUAL');
const selectedScriptName = ref('sogo');
const rules = ref<SieveRule[]>([]);
const rawScriptText = ref('');

// Formular til ny/redigeret regel
const isEditingRule = ref(false);
const editingRuleId = ref<string | null>(null);
const ruleName = ref('');
const ruleEnabled = ref(true);
const ruleMatchType = ref<'anyof' | 'allof'>('anyof');
const ruleConditions = ref<SieveCondition[]>([
  { field: 'from', comparator: 'contains', value: '' }
]);
const ruleActions = ref<SieveAction[]>([
  { type: 'fileinto', target: 'INBOX' }
]);
const ruleStopProcessing = ref(true);

const availableScripts = computed(() => store.sieveOverview?.scripts || []);

watch(
  () => [store.isSieveModalOpen, store.sieveOverview, store.sievePrefillRule] as const,
  ([isOpen, ov, prefill]) => {
    if (!isOpen) return;

    if (ov) {
      selectedScriptName.value = ov.activeScriptName || 'sogo';
      rules.value = JSON.parse(JSON.stringify(ov.rules || []));
      rawScriptText.value = ov.rawScript || '';
      if (ov.hasUnparsedCustomBlocks && ov.rules.length === 0) {
        activeTab.value = 'RAW';
      }
    }

    if (prefill) {
      activeTab.value = 'VISUAL';
      startEditRule(prefill, true);
      store.sievePrefillRule = null;
    }
  },
  { immediate: true }
);

function startNewRule() {
  editingRuleId.value = null;
  ruleName.value = `Filterregel #${rules.value.length + 1}`;
  ruleEnabled.value = true;
  ruleMatchType.value = 'anyof';
  ruleConditions.value = [{ field: 'from', comparator: 'contains', value: '' }];
  ruleActions.value = [
    {
      type: 'fileinto',
      target: store.folders[0]?.path || 'INBOX'
    }
  ];
  ruleStopProcessing.value = true;
  isEditingRule.value = true;
}

function startEditRule(rule: SieveRule, isNewPrefill = false) {
  editingRuleId.value = isNewPrefill ? null : rule.id;
  ruleName.value = rule.name;
  ruleEnabled.value = rule.enabled;
  ruleMatchType.value = rule.matchType;
  ruleConditions.value = JSON.parse(JSON.stringify(rule.conditions));
  ruleActions.value = JSON.parse(JSON.stringify(rule.actions));
  ruleStopProcessing.value = rule.stopProcessing;
  isEditingRule.value = true;
}

function addConditionRow() {
  ruleConditions.value.push({
    field: 'subject',
    comparator: 'contains',
    value: ''
  });
}

function removeConditionRow(idx: number) {
  if (ruleConditions.value.length > 1) {
    ruleConditions.value.splice(idx, 1);
  }
}

function addActionRow() {
  ruleActions.value.push({
    type: 'addflag_seen'
  });
}

function removeActionRow(idx: number) {
  if (ruleActions.value.length > 1) {
    ruleActions.value.splice(idx, 1);
  }
}

function applyRuleToLocalList() {
  const validConds = ruleConditions.value.filter((c) => c.value.trim().length > 0);
  if (validConds.length === 0) {
    store.notify('Mangler betingelse', 'Indtast mindst én søgeværdi i betingelserne.', 'warning');
    return;
  }

  const ruleObj: SieveRule = {
    id: editingRuleId.value || `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: ruleName.value.trim() || 'Filterregel',
    enabled: ruleEnabled.value,
    matchType: ruleMatchType.value,
    conditions: validConds,
    actions: ruleActions.value,
    stopProcessing: ruleStopProcessing.value
  };

  if (editingRuleId.value) {
    const idx = rules.value.findIndex((r) => r.id === editingRuleId.value);
    if (idx >= 0) {
      rules.value[idx] = ruleObj;
    } else {
      rules.value.push(ruleObj);
    }
  } else {
    rules.value.push(ruleObj);
  }

  isEditingRule.value = false;
}

function deleteRuleFromList(id: string) {
  rules.value = rules.value.filter((r) => r.id !== id);
}

function moveRule(idx: number, delta: -1 | 1) {
  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= rules.value.length) return;
  const copy = [...rules.value];
  const [item] = copy.splice(idx, 1);
  copy.splice(targetIdx, 0, item);
  rules.value = copy;
}

async function handleScriptSwitch() {
  if (!selectedScriptName.value) return;
  await store.selectSieveScript(selectedScriptName.value);
}

async function handleSaveToServer() {
  if (activeTab.value === 'RAW') {
    await store.saveSieveConfig({
      scriptName: selectedScriptName.value || 'sogo',
      rawScript: rawScriptText.value
    });
  } else {
    if (isEditingRule.value) {
      applyRuleToLocalList();
    }
    await store.saveSieveConfig({
      scriptName: selectedScriptName.value || 'sogo',
      rules: rules.value
    });
  }
}

function describeCondition(c: SieveCondition): string {
  const fieldMap: Record<SieveCondition['field'], string> = {
    from: 'Afsender (From)',
    to: 'Modtager (To/Cc)',
    subject: 'Emne (Subject)',
    header: c.customHeader || 'Header',
    size: 'Størrelse'
  };
  const compMap: Record<SieveCondition['comparator'], string> = {
    contains: 'indeholder',
    is: 'er præcis',
    matches: 'matcher mønster',
    over: 'er over',
    under: 'er under'
  };
  return `${fieldMap[c.field]} ${compMap[c.comparator]} "${c.value}"`;
}

function describeAction(a: SieveAction): string {
  switch (a.type) {
    case 'fileinto': {
      const folderName = store.folders.find((f) => f.path === a.target)?.name || a.target;
      return `Flyt til mappen "${folderName}"`;
    }
    case 'redirect':
      return `Videresend til ${a.target}`;
    case 'addflag_seen':
      return 'Markér som læst';
    case 'addflag_flagged':
      return 'Tilføj stjernemarkering';
    case 'discard':
      return 'Slet besked stille (Discard)';
    case 'reject':
      return `Afvis med besked: "${a.target}"`;
    default:
      return 'Behold i Indbakke';
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.isSieveModalOpen"
      class="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5"
      @click.self="store.isSieveModalOpen = false"
    >
      <div class="w-full max-w-4xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">
        <!-- Header -->
        <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5">
            <div class="w-9 h-9 rounded-xl bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400">
              <Filter class="w-5 h-5" />
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h3 class="text-sm sm:text-base font-bold text-slate-100">
                  Sieve Mail-Filtre &amp; Regler (Mailcow / SOGo / Roundcube)
                </h3>
                <span class="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold">
                  ManageSieve :4190
                </span>
              </div>
              <p class="text-[11px] text-slate-400">
                Reglerne afvikles direkte på mailserveren 24/7 (synkroniseret med dit eksisterende SOGo/Mailcow script)
              </p>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
              title="Genindlæs regler fra Mailcow/SOGo"
              @click="store.loadSieveOverview()"
            >
              <RefreshCw class="w-4 h-4" :class="{ 'animate-spin text-blue-400': store.isLoadingSieve }" />
            </button>
            <button
              type="button"
              class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
              @click="store.isSieveModalOpen = false"
            >
              <X class="w-4 h-4" />
            </button>
          </div>
        </div>

        <!-- Top-bjælke: Vælg aktivt script på serveren (f.eks. "sogo") + Skift mellem Visuel Regelsbygger og Rå Sieve-kode -->
        <div class="px-5 py-2.5 bg-slate-950/80 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div class="flex items-center gap-2">
            <span class="text-slate-400 font-medium">Aktivt script på serveren:</span>
            <select
              v-model="selectedScriptName"
              class="px-2.5 py-1 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 font-semibold focus:outline-none focus:border-blue-500"
              @change="handleScriptSwitch"
            >
              <option
                v-for="s in availableScripts"
                :key="s.name"
                :value="s.name"
              >
                {{ s.name }} {{ s.active ? '(Aktiv i Mailcow/SOGo)' : '' }}
              </option>
              <option v-if="availableScripts.length === 0" value="sogo">
                sogo (Standard)
              </option>
            </select>
          </div>

          <!-- Fane-skifter -->
          <div class="flex items-center bg-slate-900 p-0.5 rounded-lg border border-slate-800">
            <button
              type="button"
              class="flex items-center gap-1.5 px-3 py-1 rounded-md font-semibold transition"
              :class="activeTab === 'VISUAL' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'"
              @click="activeTab = 'VISUAL'"
            >
              <Sliders class="w-3.5 h-3.5" />
              <span>Visuelle Regler ({{ rules.length }})</span>
            </button>
            <button
              type="button"
              class="flex items-center gap-1.5 px-3 py-1 rounded-md font-semibold transition"
              :class="activeTab === 'RAW' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'"
              @click="activeTab = 'RAW'"
            >
              <Code class="w-3.5 h-3.5" />
              <span>Rå Sieve-Script (.sieve)</span>
            </button>
          </div>
        </div>

        <!-- Indhold -->
        <div class="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          <!-- VISUEL REGELSBYGGER -->
          <template v-if="activeTab === 'VISUAL'">
            <div class="flex items-center justify-between">
              <div class="text-slate-300 font-medium">
                Reglerne evalueres oppefra og ned, når en ny e-mail lander på serveren.
              </div>
              <button
                v-if="!isEditingRule"
                type="button"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold shadow transition"
                @click="startNewRule"
              >
                <Plus class="w-3.5 h-3.5" />
                <span>Tilføj ny filterregel</span>
              </button>
            </div>

            <!-- Formular til oprettelse / redigering af en filterregel -->
            <div
              v-if="isEditingRule"
              class="p-4 rounded-2xl bg-slate-950 border border-blue-500/50 shadow-xl space-y-4"
            >
              <div class="flex items-center justify-between border-b border-slate-800 pb-2.5">
                <h4 class="text-sm font-bold text-slate-100">
                  {{ editingRuleId ? 'Redigér filterregel' : 'Opret ny filterregel' }}
                </h4>
                <button
                  type="button"
                  class="text-slate-400 hover:text-slate-200"
                  @click="isEditingRule = false"
                >
                  Annullér
                </button>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div class="sm:col-span-7">
                  <label class="block text-slate-400 mb-1">Regelnavn</label>
                  <input
                    v-model="ruleName"
                    type="text"
                    placeholder="f.eks. Fakturaer til Økonomi-mappe"
                    class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div class="sm:col-span-5">
                  <label class="block text-slate-400 mb-1">Når følgende betingelser er opfyldt:</label>
                  <select
                    v-model="ruleMatchType"
                    class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                  >
                    <option value="anyof">Mindst én betingelse matcher (ELLER / anyof)</option>
                    <option value="allof">Alle betingelser skal matche (OG / allof)</option>
                  </select>
                </div>
              </div>

              <!-- Betingelser (HVIS...) -->
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <label class="font-semibold text-blue-300">1. Betingelser (HVIS):</label>
                  <button
                    type="button"
                    class="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                    @click="addConditionRow"
                  >
                    <Plus class="w-3 h-3" /> Tilføj betingelse
                  </button>
                </div>

                <div
                  v-for="(cond, idx) in ruleConditions"
                  :key="idx"
                  class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center bg-slate-900/90 p-2 rounded-xl border border-slate-800"
                >
                  <div class="sm:col-span-3">
                    <select
                      v-model="cond.field"
                      class="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-100"
                    >
                      <option value="from">Afsender (From)</option>
                      <option value="to">Modtager / Alias (To)</option>
                      <option value="subject">Emne (Subject)</option>
                      <option value="header">Brugerdefineret Header</option>
                      <option value="size">Beskedstørrelse</option>
                    </select>
                  </div>

                  <div class="sm:col-span-3">
                    <select
                      v-model="cond.comparator"
                      class="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-100"
                    >
                      <template v-if="cond.field === 'size'">
                        <option value="over">er over (f.eks. 5M)</option>
                        <option value="under">er under (f.eks. 100K)</option>
                      </template>
                      <template v-else>
                        <option value="contains">indeholder</option>
                        <option value="is">er præcis</option>
                        <option value="matches">matcher wildcard (*)</option>
                      </template>
                    </select>
                  </div>

                  <div class="sm:col-span-5">
                    <input
                      v-model="cond.value"
                      type="text"
                      :placeholder="cond.field === 'size' ? '100K eller 5M' : 'Søgetekst eller e-mail...'"
                      class="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-100"
                    />
                  </div>

                  <div class="sm:col-span-1 flex justify-end">
                    <button
                      type="button"
                      :disabled="ruleConditions.length <= 1"
                      class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 disabled:opacity-30"
                      @click="removeConditionRow(idx)"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <!-- Handlinger (SÅ UDFØR...) -->
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <label class="font-semibold text-emerald-300">2. Handlinger (SÅ UDFØR):</label>
                  <button
                    type="button"
                    class="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                    @click="addActionRow"
                  >
                    <Plus class="w-3 h-3" /> Tilføj handling
                  </button>
                </div>

                <div
                  v-for="(act, idx) in ruleActions"
                  :key="idx"
                  class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center bg-slate-900/90 p-2 rounded-xl border border-slate-800"
                >
                  <div class="sm:col-span-5">
                    <select
                      v-model="act.type"
                      class="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-100"
                    >
                      <option value="fileinto">Flyt besked til mappe</option>
                      <option value="addflag_seen">Markér som læst (\Seen)</option>
                      <option value="addflag_flagged">Sæt stjernemarkering (\Flagged)</option>
                      <option value="redirect">Videresend til e-mailadresse</option>
                      <option value="discard">Slet besked stille (Discard)</option>
                      <option value="keep">Behold i Indbakke</option>
                    </select>
                  </div>

                  <div class="sm:col-span-6">
                    <select
                      v-if="act.type === 'fileinto'"
                      v-model="act.target"
                      class="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-100"
                    >
                      <option
                        v-for="f in store.folders"
                        :key="f.path"
                        :value="f.path"
                      >
                        {{ f.name }} ({{ f.path }})
                      </option>
                    </select>

                    <input
                      v-else-if="act.type === 'redirect' || act.type === 'reject'"
                      v-model="act.target"
                      type="text"
                      placeholder="modtager@eksempel.dk"
                      class="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-slate-100"
                    />
                    <span v-else class="text-slate-500 text-[11px] px-2">
                      Ingen ekstra værdi nødvendig
                    </span>
                  </div>

                  <div class="sm:col-span-1 flex justify-end">
                    <button
                      type="button"
                      :disabled="ruleActions.length <= 1"
                      class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 disabled:opacity-30"
                      @click="removeActionRow(idx)"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800">
                <label class="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    v-model="ruleStopProcessing"
                    type="checkbox"
                    class="rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-0"
                  />
                  <span>Stop behandling af flere regler når denne regel matcher (`stop;`)</span>
                </label>

                <button
                  type="button"
                  class="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1.5 transition"
                  @click="applyRuleToLocalList"
                >
                  <Check class="w-3.5 h-3.5" />
                  <span>Føj regel til listen</span>
                </button>
              </div>
            </div>

            <!-- Liste over eksisterende regler -->
            <div v-if="rules.length === 0 && !isEditingRule" class="p-8 rounded-2xl bg-slate-950/60 border border-slate-800 text-center space-y-2">
              <Filter class="w-8 h-8 text-slate-600 mx-auto" />
              <div class="font-semibold text-slate-300">Ingen visuelle filterregler fundet endnu</div>
              <p class="text-[11px] text-slate-500 max-w-md mx-auto">
                Klik på "Tilføj ny filterregel" ovenfor for at sortere indkommende e-mails automatisk i mapper på Mailcow/SOGo.
              </p>
            </div>

            <div class="space-y-2.5">
              <div
                v-for="(rule, idx) in rules"
                :key="rule.id"
                class="p-3.5 rounded-xl border transition flex items-start justify-between gap-3"
                :class="rule.enabled ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-900/40 border-slate-800 opacity-60'"
              >
                <div class="space-y-1.5 min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      class="p-1 rounded-md border transition"
                      :class="rule.enabled ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' : 'bg-slate-800 border-slate-700 text-slate-500'"
                      :title="rule.enabled ? 'Regel er aktiv (klik for at slå fra)' : 'Regel er slået fra (klik for at aktivere)'"
                      @click="rule.enabled = !rule.enabled"
                    >
                      <Power class="w-3 h-3" />
                    </button>
                    <span class="font-bold text-slate-100 text-xs">{{ rule.name }}</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-800">
                      {{ rule.matchType === 'allof' ? 'Match ALLE' : 'Match MINDST ÉN' }}
                    </span>
                  </div>

                  <div class="text-[11px] text-slate-300 space-y-0.5 pl-7">
                    <div
                      v-for="(c, cIdx) in rule.conditions"
                      :key="cIdx"
                      class="flex items-center gap-1.5"
                    >
                      <span class="text-blue-400 font-semibold">HVIS:</span>
                      <span>{{ describeCondition(c) }}</span>
                    </div>
                    <div
                      v-for="(a, aIdx) in rule.actions"
                      :key="aIdx"
                      class="flex items-center gap-1.5 text-emerald-300"
                    >
                      <FolderInput class="w-3 h-3 shrink-0" />
                      <span class="font-semibold">SÅ:</span>
                      <span>{{ describeAction(a) }}</span>
                    </div>
                  </div>
                </div>

                <div class="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    :disabled="idx === 0"
                    class="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 disabled:opacity-30"
                    title="Flyt regel op"
                    @click="moveRule(idx, -1)"
                  >
                    <ArrowUp class="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    :disabled="idx === rules.length - 1"
                    class="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 disabled:opacity-30"
                    title="Flyt regel ned"
                    @click="moveRule(idx, 1)"
                  >
                    <ArrowDown class="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-700 border border-slate-700 text-slate-200"
                    @click="startEditRule(rule)"
                  >
                    Redigér
                  </button>
                  <button
                    type="button"
                    class="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400"
                    title="Slet regel"
                    @click="deleteRuleFromList(rule.id)"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </template>

          <!-- RÅ SIEVE-SCRIPT EDITOR -->
          <template v-else>
            <div class="p-3 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-start gap-2.5 text-blue-200">
              <AlertCircle class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <div class="text-[11px] leading-relaxed">
                Her ser du det rå <strong>Sieve-script</strong> direkte fra din Mailcow / SOGo server (<code class="text-white">{{ selectedScriptName }}</code>). Du kan redigere koden direkte og klikke <strong>Gem &amp; Aktivér på Serveren</strong>. Serveren validerer syntaksen automatisk før aktivering.
              </div>
            </div>

            <textarea
              v-model="rawScriptText"
              rows="16"
              spellcheck="false"
              placeholder="require [&quot;fileinto&quot;];&#10;&#10;if header :contains &quot;Subject&quot; &quot;Faktura&quot; {&#10;  fileinto &quot;INBOX/Fakturaer&quot;;&#10;  stop;&#10;}"
              class="w-full p-3.5 bg-slate-950 border border-slate-700 rounded-xl font-mono text-xs text-emerald-300 leading-relaxed focus:outline-none focus:border-blue-500"
            ></textarea>
          </template>
        </div>

        <!-- Footer -->
        <div class="px-5 py-3.5 border-t border-slate-800 flex items-center justify-between gap-3 bg-slate-900/90">
          <span class="text-[11px] text-slate-400">
            Ændringer træder i kraft øjeblikkeligt på mailserveren ved gem.
          </span>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="px-3.5 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800 text-xs transition"
              @click="store.isSieveModalOpen = false"
            >
              Luk
            </button>
            <button
              type="button"
              :disabled="store.isLoadingSieve"
              class="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5 shadow transition"
              @click="handleSaveToServer"
            >
              <Check class="w-4 h-4" />
              <span>{{ store.isLoadingSieve ? 'Gemmer på server...' : 'Gem & Aktivér på Serveren' }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
