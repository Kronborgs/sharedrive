<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { createRoomLinkOption, listConversationLinkOptions, listRoomLinkOptions, sharedriveRoomLink } from '../../services/roomLinks';

const link = defineModel<string>({ required: true });
const rooms = ref<Awaited<ReturnType<typeof listRoomLinkOptions>>>([]);
const conversations = ref<Awaited<ReturnType<typeof listConversationLinkOptions>>>([]);
const loading = ref(true);
const failed = ref(false);
const creating = ref(false);
const createOpen = ref(false);
const createFailed = ref(false);
const roomName = ref('');
const controller = new AbortController();
const origin = window.location.origin;
const fieldClass = 'w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500';

function urlFor(roomId: string) {
  return sharedriveRoomLink('/rooms/' + roomId, origin);
}

const selectedRoom = computed(() => {
  const current = sharedriveRoomLink(link.value, origin);
  return rooms.value.find(room => urlFor(room.id) === current)?.id
    || conversations.value.find(chat => sharedriveRoomLink('/rooms/direct/' + chat.id, origin) === current)?.id || '';
});

function selectRoom(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value === '__new__') {
    createOpen.value = true;
    (event.target as HTMLSelectElement).value = selectedRoom.value;
    return;
  }
  createOpen.value = false;
  link.value = conversations.value.some(chat => chat.id === value)
    ? sharedriveRoomLink('/rooms/direct/' + value, origin)
    : value ? urlFor(value) : '';
}

async function createRoom() {
  const name = roomName.value.trim();
  if (!name || creating.value) return;
  creating.value = true;
  createFailed.value = false;
  try {
    const room = await createRoomLinkOption(name);
    rooms.value = [...rooms.value.filter(item => item.id !== room.id), room];
    link.value = urlFor(room.id);
    roomName.value = '';
    createOpen.value = false;
  } catch {
    createFailed.value = true;
  } finally {
    creating.value = false;
  }
}

async function loadRooms() {
  try {
    const [roomResult, chatResult] = await Promise.allSettled([
      listRoomLinkOptions(controller.signal), listConversationLinkOptions(controller.signal),
    ]);
    if (roomResult.status === 'fulfilled') rooms.value = roomResult.value;
    if (chatResult.status === 'fulfilled') conversations.value = chatResult.value;
    failed.value = roomResult.status === 'rejected' || chatResult.status === 'rejected';
  } catch {
    if (!controller.signal.aborted) failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(loadRooms);
onUnmounted(() => controller.abort());
</script>

<template>
  <div class="min-w-0 space-y-2">
    <select
      aria-label="Vælg et Sharedrive-rum"
      :value="selectedRoom"
      :class="fieldClass"
      :disabled="loading || creating"
      @change="selectRoom"
    >
      <option value="">{{ loading ? 'Henter dine rum…' : 'Vælg et rum…' }}</option>
      <optgroup v-if="rooms.length" label="Rum">
        <option v-for="room in rooms" :key="room.id" :value="room.id">{{ room.name }}</option>
      </optgroup>
      <optgroup v-if="conversations.length" label="Samtaler">
        <option v-for="chat in conversations" :key="chat.id" :value="chat.id">{{ chat.name || chat.other_display_name || chat.other_email }}{{ chat.kind === 'group' ? ' (gruppe)' : ' (direkte)' }}</option>
      </optgroup>
      <option value="__new__">+ Opret nyt rum…</option>
    </select>
    <p v-if="failed" role="alert" class="text-slate-400">Nogle rum eller samtaler kunne ikke hentes. Prøv at åbne vælgeren igen.</p>
    <div v-if="createOpen" class="space-y-2">
      <input v-model="roomName" type="text" aria-label="Navn på nyt rum" placeholder="Navn på nyt rum" :class="fieldClass" :disabled="creating" @keydown.enter.prevent="createRoom" />
      <div class="flex gap-2">
        <button type="button" class="rounded-lg bg-blue-600 px-3 py-2 text-white disabled:opacity-50" :disabled="creating || !roomName.trim()" @click="createRoom">{{ creating ? 'Opretter…' : 'Opret rum' }}</button>
        <button type="button" class="rounded-lg px-3 py-2 text-slate-300" :disabled="creating" @click="createOpen = false; createFailed = false">Annuller</button>
      </div>
      <p v-if="createFailed" role="alert" class="text-red-400">Rummet kunne ikke oprettes. Prøv igen.</p>
    </div>
    <details>
      <summary class="cursor-pointer text-slate-400">Indsæt et Rooms-link manuelt</summary>
      <input v-model="link" type="text" inputmode="url" aria-label="Sharedrive Rooms-link" placeholder="Indsæt et Rooms-link" :class="[fieldClass, 'mt-2']" />
    </details>
    <p class="text-[11px] text-slate-400">Et link giver ikke automatisk adgang. Direkte samtaler og gruppechats kan kun åbnes af deres deltagere. Brug et gæstelink til rum for andre modtagere.</p>
  </div>
</template>
