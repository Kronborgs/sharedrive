<script setup lang="ts">
import { ref } from 'vue';
import { AtSign, Plus, Trash2, Check, X, Star, Pencil, RefreshCw } from 'lucide-vue-next';
import { useMailStore } from '../../stores/mailStore';
import type { SenderAlias } from '../../types/mail';

const store = useMailStore();

const editingId = ref<string | undefined>(undefined);
const email = ref('');
const displayName = ref('');
const signature = ref('');
const isDefault = ref(false);
const isSaving = ref(false);

function resetForm() {
  editingId.value = undefined;
  email.value = '';
  displayName.value = '';
  signature.value = '';
  isDefault.value = false;
}

function startEdit(alias: SenderAlias) {
  editingId.value = alias.id;
  email.value = alias.email;
  displayName.value = alias.displayName;
  signature.value = alias.signature;
  isDefault.value = alias.isDefault;
}

async function handleSave() {
  if (!email.value.trim()) return;
  isSaving.value = true;
  try {
    const ok = await store.saveAlias({
      id: editingId.value,
      email: email.value.trim(),
      displayName: displayName.value.trim(),
      signature: signature.value,
      isDefault: isDefault.value
    });
    if (ok) {
      resetForm();
    }
  } finally {
    isSaving.value = false;
  }
}

async function setAsDefault(alias: SenderAlias) {
  await store.saveAlias({
    id: alias.id,
    email: alias.email,
    displayName: alias.displayName,
    signature: alias.signature,
    isDefault: true
  });
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.isAliasModalOpen"
      class="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4"
      @click.self="store.isAliasModalOpen = false"
    >
      <div class="w-full max-w-xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-[88vh] overflow-hidden">
        <!-- Header -->
        <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400">
              <AtSign class="w-4 h-4" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-slate-100">
                Administrér Afsender-Aliaser
              </h3>
              <p class="text-[11px] text-slate-400">
                Tilføj og gem dine mail-aliaser, visningsnavne og signaturer
              </p>
            </div>
          </div>

          <button
            type="button"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            @click="store.isAliasModalOpen = false"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          <!-- Formular til oprettelse / redigering af alias -->
          <form
            class="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-3"
            @submit.prevent="handleSave"
          >
            <div class="font-bold text-slate-200 flex items-center justify-between">
              <span>{{ editingId ? 'Redigér afsender-alias' : 'Tilføj nyt afsender-alias' }}</span>
              <button
                v-if="editingId"
                type="button"
                class="text-[11px] text-slate-400 hover:text-slate-200"
                @click="resetForm"
              >
                Annullér redigering
              </button>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label class="block text-slate-400 mb-1">Alias e-mailadresse *</label>
                <input
                  v-model="email"
                  type="email"
                  required
                  placeholder="alias@ditdomæne.dk"
                  class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label class="block text-slate-400 mb-1">Visningsnavn (valgfrit)</label>
                <input
                  v-model="displayName"
                  type="text"
                  placeholder="f.eks. Standard identitet - Support"
                  class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label class="block text-slate-400 mb-1">Fast signatur for dette alias (valgfri)</label>
              <textarea
                v-model="signature"
                rows="3"
                placeholder="Med venlig hilsen..."
                class="w-full p-2.5 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              ></textarea>
            </div>

            <div class="flex items-center justify-between pt-1">
              <label class="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  v-model="isDefault"
                  type="checkbox"
                  class="rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-0"
                />
                <span>Brug som standard-afsender ved nye e-mails</span>
              </label>

              <button
                type="submit"
                :disabled="isSaving"
                class="px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold flex items-center gap-1.5 transition"
              >
                <Check v-if="editingId" class="w-3.5 h-3.5" />
                <Plus v-else class="w-3.5 h-3.5" />
                <span>{{ editingId ? 'Gem ændringer' : 'Gem alias' }}</span>
              </button>
            </div>
          </form>

          <!-- Liste over gemte aliaser -->
          <div class="space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h4 class="text-xs font-bold uppercase tracking-wider text-slate-400">
                Gemte Afsender-Aliaser ({{ store.aliases.length }})
              </h4>
              <button
                type="button"
                :disabled="store.isSyncingAliases"
                class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 border border-sky-500/40 text-sky-300 text-[11px] font-semibold transition disabled:opacity-50"
                title="Hent automatisk alle aliaser og afsender-rettigheder fra Mailcow / SOGo"
                @click="store.syncAliasesFromMailcow()"
              >
                <RefreshCw class="w-3 h-3" :class="{ 'animate-spin': store.isSyncingAliases }" />
                <span>{{ store.isSyncingAliases ? 'Synkroniserer...' : 'Synkronisér fra Mailcow' }}</span>
              </button>
            </div>

            <p class="text-[11px] text-slate-400 leading-relaxed">
              Mailcow-aliaser markeret som synlige i SOGo hentes automatisk. Tilføj evt. en Read-Only <code class="text-slate-300">MAILCOW_API_KEY</code> i <code class="text-slate-300">.env</code> for også at medtage skjulte aliaser og domæne-aliaser.
            </p>

            <div
              v-for="alias in store.aliases"
              :key="alias.id"
              class="p-3 rounded-xl bg-slate-800/60 border border-slate-700/80 flex items-center justify-between gap-3"
            >
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-bold text-slate-100 truncate">
                    {{ alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email }}
                  </span>
                  <span
                    v-if="alias.isDefault"
                    class="px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold"
                  >
                    Standard
                  </span>
                  <span
                    v-if="alias.source === 'mailcow'"
                    class="px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30 text-[10px] font-semibold"
                    title="Hentet automatisk fra Mailcow"
                  >
                    Mailcow
                  </span>
                </div>
                <div v-if="alias.signature" class="text-[11px] text-slate-400 truncate mt-0.5">
                  Signatur: {{ alias.signature }}
                </div>
              </div>

              <div class="flex items-center gap-1 shrink-0">
                <button
                  v-if="!alias.isDefault"
                  type="button"
                  class="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-amber-300 transition"
                  title="Sæt som standard-afsender"
                  @click="setAsDefault(alias)"
                >
                  <Star class="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  class="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-slate-100 transition"
                  title="Redigér alias"
                  @click="startEdit(alias)"
                >
                  <Pencil class="w-3.5 h-3.5" />
                </button>
                <button
                  v-if="store.aliases.length > 1"
                  type="button"
                  class="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition"
                  title="Slet alias"
                  @click="store.removeAlias(alias.id)"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
