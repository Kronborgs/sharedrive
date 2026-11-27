<script setup lang="ts">
import { ref } from 'vue'
import { getStorageScope } from '../../sharedrive-storage'
import { hasOfflineMail, saveOfflineMail } from '../../services/offlineMail'
import { useSuiteStore } from '../../stores/suiteStore'
import type { MailDetail } from '../../types/mail'

const props = defineProps<{ message: MailDetail; plainBody: string }>()
const suite = useSuiteStore()
const passphrase = ref('')
const confirmation = ref('')
const open = ref(false)
const busy = ref(false)
const error = ref('')
const creating = ref(false)

function openEditor() {
  creating.value = !hasOfflineMail(getStorageScope())
  open.value = true
}

async function save() {
  if (busy.value) return
  if (creating.value && passphrase.value !== confirmation.value) {
    error.value = 'Adgangssætningerne er forskellige.'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await saveOfflineMail(getStorageScope(), passphrase.value, props.message, props.plainBody)
    suite.notify('Mail gemt til offlinelæsning', undefined, 'success')
    close()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Kunne ikke gemme mailen.'
  } finally {
    busy.value = false
  }
}

function close() {
  passphrase.value = ''
  confirmation.value = ''
  error.value = ''
  open.value = false
}
</script>

<template>
  <div>
    <button v-if="!open" type="button" class="text-xs text-slate-300 hover:text-blue-300"
      @click="openEditor">Gem til offlinelæsning</button>
    <form v-else class="space-y-2 rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs" @submit.prevent="save">
      <p>Gemmer en krypteret tekstkopi i denne browser. Brug din egen adgangssætning til offlinebeskederne.</p>
      <label class="block">
        Offline-adgangssætning
        <input v-model="passphrase" class="mt-1 block w-full rounded border border-slate-600 bg-slate-950 px-2 py-1"
          type="password" :autocomplete="creating ? 'new-password' : 'current-password'" required maxlength="128">
      </label>
      <label v-if="creating" class="block">
        Gentag adgangssætning
        <input v-model="confirmation" class="mt-1 block w-full rounded border border-slate-600 bg-slate-950 px-2 py-1"
          type="password" autocomplete="new-password" minlength="12" maxlength="128" required>
      </label>
      <p v-if="error" role="alert" class="text-rose-300">{{ error }}</p>
      <div class="flex gap-2">
        <button type="submit" :disabled="busy" class="rounded bg-blue-700 px-2 py-1 disabled:opacity-60">
          {{ busy ? 'Gemmer…' : 'Gem offlinekopi' }}
        </button>
        <button type="button" :disabled="busy" class="rounded border border-slate-600 px-2 py-1" @click="close">Annuller</button>
      </div>
    </form>
  </div>
</template>
