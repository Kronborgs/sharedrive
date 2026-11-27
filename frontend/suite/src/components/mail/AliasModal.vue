<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import DOMPurify from 'dompurify';
import { AtSign, Plus, Trash2, Check, X, Star, Pencil, RefreshCw, Copy, ExternalLink } from 'lucide-vue-next';
import { useMailStore } from '../../stores/mailStore';
import { useSuiteStore } from '../../stores/suiteStore';
import { fetchSogoSignatureApi } from '../../services/mailApi';
import type { SenderAlias } from '../../types/mail';

const store = useMailStore();
const suite = useSuiteStore();

const editingId = ref<string | undefined>(undefined);
const email = ref('');
const displayName = ref('');
const signature = ref('');
const isDefault = ref(false);
const isSaving = ref(false);
const signatureField = ref<HTMLTextAreaElement | null>(null);
const importingSignature = ref(false);
const canImportSignature = computed(() => store.aliases.some(alias =>
  alias.id === editingId.value && alias.email.toLowerCase() === email.value.trim().toLowerCase()));

watch(() => store.isAliasModalOpen, async (open) => {
  if (!open) return;
  const sender = store.defaultAlias;
  if (sender) startEdit(sender);
  else resetForm();
  await nextTick();
  signatureField.value?.focus();
});

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
      const saved = store.aliases.find((alias) => alias.email.toLowerCase() === email.value.trim().toLowerCase());
      if (saved) startEdit(saved);
    }
  } finally {
    isSaving.value = false;
  }
}

function signatureAsText(markup: string) {
  const fragment = DOMPurify.sanitize(markup, {
    ALLOWED_TAGS: ['br', 'div', 'p', 'li', 'tr'],
    ALLOWED_ATTR: [],
    RETURN_DOM_FRAGMENT: true
  });
  fragment.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  fragment.querySelectorAll('div, p, li, tr').forEach(node => node.after('\n'));
  return (fragment.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

async function handleSogoSignatureImport() {
  if (!canImportSignature.value || importingSignature.value || isSaving.value) return;
  const aliasId = editingId.value;
  const selectedEmail = email.value;
  const original = signature.value;
  importingSignature.value = true;
  try {
    const result = await fetchSogoSignatureApi(selectedEmail.trim());
    if (!store.isAliasModalOpen || editingId.value !== aliasId || email.value !== selectedEmail || signature.value !== original) return;

    const text = result.html ? signatureAsText(result.signature) : result.signature;
    if (!text.trim()) throw new Error('Signaturen i SOGo indeholder ingen tekst.');
    signature.value = text;
    signatureField.value?.focus();
    store.notify('Signatur hentet fra SOGo', 'Gennemse teksten, og gem ændringerne i Sharedrive.', 'success');
  } catch (error) {
    store.notify('Kunne ikke hente SOGo-signaturen', error instanceof Error ? error.message : undefined, 'error');
  } finally {
    importingSignature.value = false;
  }
}

async function copySignatureForSogo() {
  try {
    await navigator.clipboard.writeText(signature.value);
    store.notify('Signatur kopieret', 'Åbn SOGo, og indsæt teksten under Indstillinger → Mail → IMAP-konti → Identiteter.', 'success');
  } catch {
    signatureField.value?.focus();
    signatureField.value?.select();
    store.notify('Kopiér den markerede signatur', 'Brug Ctrl+C eller Cmd+C, og indsæt teksten i SOGo.', 'info');
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
      <div class="w-full max-w-xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-[88vh] overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-signatures-title">
        <!-- Header -->
        <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400">
              <AtSign class="w-4 h-4" />
            </div>
            <div>
              <h3 id="mail-signatures-title" class="text-sm font-bold text-slate-100">
                Signaturer og afsenderadresser
              </h3>
              <p class="text-[11px] text-slate-400">
                Sharedrive indsætter den gemte signatur i nye mails, svar og videresendelser.
              </p>
            </div>
          </div>

          <button
            type="button"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            aria-label="Luk signaturer"
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
              <span>{{ editingId ? 'Redigér signatur og afsender' : 'Tilføj afsender' }}</span>
              <button
                v-if="editingId"
                type="button"
                class="text-[11px] text-slate-400 hover:text-slate-200"
                @click="resetForm"
              >
                Tilføj afsender
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
              <label for="mail-signature-text" class="block text-slate-400 mb-1">Signatur for denne afsender</label>
              <textarea
                id="mail-signature-text"
                ref="signatureField"
                v-model="signature"
                aria-describedby="mail-signature-help"
                rows="4"
                placeholder="Med venlig hilsen..."
                class="w-full p-2.5 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              ></textarea>
              <p id="mail-signature-help" class="mt-1 text-[11px] text-slate-400">
                Gemmes i Sharedrive. Lad feltet være tomt, hvis afsenderen ikke skal have en signatur.
              </p>
              <div v-if="suite.sogoUrl" class="mt-2 flex flex-wrap gap-2">
                <button
                  v-if="canImportSignature"
                  type="button"
                  :disabled="importingSignature || isSaving"
                  class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  @click="handleSogoSignatureImport"
                >
                  <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': importingSignature }" />
                  {{ importingSignature ? 'Henter signatur…' : 'Hent signatur fra SOGo' }}
                </button>
                <button
                  type="button"
                  :disabled="!signature.trim() || importingSignature"
                  class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  @click="copySignatureForSogo"
                >
                  <Copy class="h-3.5 w-3.5" />
                  Kopiér signatur til SOGo
                </button>
                <a
                  :href="suite.sogoUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                >
                  <ExternalLink class="h-3.5 w-3.5" />
                  Åbn SOGo
                </a>
              </div>
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
                :disabled="isSaving || importingSignature"
                class="px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold flex items-center gap-1.5 transition"
              >
                <Check v-if="editingId" class="w-3.5 h-3.5" />
                <Plus v-else class="w-3.5 h-3.5" />
                <span>{{ editingId ? 'Gem ændringer' : 'Gem afsender' }}</span>
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
                  title="Redigér signatur og afsender"
                  :aria-label="`Redigér signaturen for ${alias.email}`"
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
