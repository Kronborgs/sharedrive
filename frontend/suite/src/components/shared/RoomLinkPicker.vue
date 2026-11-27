<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { listRoomLinkOptions, sharedriveRoomLink } from '../../services/roomLinks';

const link = defineModel<string>({ required: true });
const rooms = ref<Awaited<ReturnType<typeof listRoomLinkOptions>>>([]);
const loading = ref(true);
const failed = ref(false);
const controller = new AbortController();
const origin = window.location.origin;
const fieldClass = 'w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500';

function urlFor(roomId: string) {
  return sharedriveRoomLink('/rooms/' + roomId, origin);
}

const selectedRoom = computed(() => {
  const current = sharedriveRoomLink(link.value, origin);
  return rooms.value.find(room => urlFor(room.id) === current)?.id || '';
});

async function loadRooms() {
  try {
    rooms.value = await listRoomLinkOptions(controller.signal);
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
      v-if="rooms.length"
      aria-label="Vælg et Sharedrive-rum"
      :value="selectedRoom"
      :class="fieldClass"
      @change="link = urlFor(($event.target as HTMLSelectElement).value)"
    >
      <option value="">Vælg et rum…</option>
      <option v-for="room in rooms" :key="room.id" :value="room.id">{{ room.name }}</option>
    </select>
    <p v-else-if="loading" class="text-slate-400">Henter dine rum…</p>
    <p v-else-if="failed" class="text-slate-400">Dine rum kunne ikke hentes.</p>
    <input
      v-model="link"
      type="text"
      inputmode="url"
      aria-label="Sharedrive Rooms-link"
      placeholder="Indsæt et Rooms-link"
      :class="fieldClass"
    />
    <p class="text-[11px] text-slate-400">Brug et gæstelink til modtagere, der ikke har adgang til rummet.</p>
  </div>
</template>
