<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { clearOfflineMail, offlineMailKey, offlineMailResetKey } from '../../../../src/lib/offline-mail-storage'
import { hasOfflineMail, unlockOfflineMail, type OfflineMessage } from '../../services/offlineMail'

const props = defineProps<{ scope?: string }>()
const passphrase = ref('')
const entries = ref<OfflineMessage[] | null>(null)
const selected = ref<OfflineMessage | null>(null)
const available = ref(hasOfflineMail(props.scope))
const savedInBrowser = ref(hasOfflineMail())
const busy = ref(false)
const error = ref('')
const locked = computed(() => entries.value === null)
let lockVersion = 0

function lock() {
  lockVersion++
  passphrase.value = ''
  entries.value = null
  selected.value = null
}

function onStorage(event: StorageEvent) {
  if (event.key === offlineMailKey || event.key === offlineMailResetKey || event.key === null) {
    lock()
    available.value = hasOfflineMail(props.scope)
    savedInBrowser.value = hasOfflineMail()
  }
}

onMounted(() => {
  window.addEventListener('storage', onStorage)
  window.addEventListener('pagehide', lock)
})

onUnmounted(() => {
  window.removeEventListener('storage', onStorage)
  window.removeEventListener('pagehide', lock)
})

async function unlock() {
  if (busy.value) return
  error.value = ''
  busy.value = true
  try {
    const version = lockVersion
    const messages = await unlockOfflineMail(passphrase.value, props.scope)
    if (version === lockVersion) entries.value = messages
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : 'Kunne ikke åbne offlinebeskederne.'
  } finally {
    passphrase.value = ''
    busy.value = false
  }
}

function remove() {
  if (!window.confirm('Vil du fjerne offlinebeskederne fra denne browser?')) return
  clearOfflineMail()
  lock()
  available.value = hasOfflineMail(props.scope)
  savedInBrowser.value = hasOfflineMail()
}
</script>

<template>
  <main class="h-dvh overflow-auto bg-slate-950 px-4 py-6 text-slate-100 sm:px-8">
    <div class="mx-auto max-w-4xl space-y-4">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-xl font-semibold">Offlinebeskeder</h1>
        <a href="/mail/suite-ui/?view=mail" class="text-sm text-blue-300 hover:underline">Tilbage til Mail</a>
      </header>
      <p v-if="!available" class="text-sm text-slate-300">Åbn en mail med internetforbindelse, og vælg Gem til offlinelæsning.</p>
      <form v-else-if="locked" class="max-w-sm space-y-3 rounded-xl border border-slate-700 bg-slate-900 p-4" @submit.prevent="unlock">
        <label class="block text-sm">
          Offline-adgangssætning
          <input v-model="passphrase" class="mt-2 block w-full rounded border border-slate-600 bg-slate-950 px-3 py-2"
            type="password" autocomplete="current-password" maxlength="128" required>
        </label>
        <p v-if="error" role="alert" class="text-sm text-rose-300">{{ error }}</p>
        <button type="submit" :disabled="busy" class="rounded bg-blue-700 px-3 py-2 text-sm disabled:opacity-60">
          {{ busy ? 'Åbner…' : 'Lås op' }}
        </button>
      </form>
      <div v-else class="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
        <ul class="space-y-2" aria-label="Gemte mails">
          <li v-for="entry in entries" :key="entry.id">
            <button type="button" :aria-pressed="selected?.id === entry.id"
              class="w-full rounded-lg border border-slate-700 px-3 py-2 text-left text-sm hover:bg-slate-800"
              @click="selected = entry">
              <span class="block break-words font-medium">{{ entry.subject || '(Uden emne)' }}</span>
              <span class="block break-words text-xs text-slate-400">{{ entry.from }}</span>
            </button>
          </li>
        </ul>
        <article v-if="selected" class="min-w-0 rounded-xl border border-slate-700 bg-slate-900 p-4">
          <h2 class="break-words font-semibold">{{ selected.subject || '(Uden emne)' }}</h2>
          <p class="mt-1 break-words text-xs text-slate-400">{{ selected.from }} · {{ new Date(selected.date).toLocaleString('da-DK') }}</p>
          <p class="mt-4 whitespace-pre-wrap break-words text-sm">{{ selected.body }}</p>
          <p v-if="selected.truncated" class="mt-2 text-xs text-slate-400">Den gemte tekst er afkortet. Åbn Mail online for at læse resten.</p>
        </article>
      </div>
      <div v-if="savedInBrowser" class="flex gap-3 text-sm">
        <button v-if="!locked" type="button" class="text-blue-300 hover:underline" @click="lock">Lås offlinebeskeder</button>
        <button type="button" class="text-rose-300 hover:underline" @click="remove">Fjern offlinebeskeder</button>
      </div>
    </div>
  </main>
</template>
