import { ref, watch } from 'vue';

const roomId = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const roomLinkPath = new RegExp(`^/rooms/(?:${roomId}|direct/${roomId}|invite/[a-z0-9_-]{43})/?$`, 'i');

export function sharedriveRoomLink(value: string, origin: string): string {
  try {
    const url = new URL(value.trim(), origin);
    if (url.origin === origin && !url.username && !url.password && roomLinkPath.test(url.pathname)) {
      return url.origin + url.pathname;
    }
  } catch {
    // The input can be incomplete while the user types.
  }
  return '';
}

interface RoomSettings {
  rooms_enabled: boolean;
  rooms_voice_enabled: boolean;
}

interface RoomLinkOption {
  id: string;
  name: string;
}

async function getSharedriveData<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new Error('Sharedrive kunne ikke hente Rooms.');
  const result = await response.json();
  return result.data;
}

export function useRoomSettings(active: () => boolean) {
  const settings = ref<RoomSettings>();
  const failed = ref(false);
  watch(active, async (open, _previous, onCleanup) => {
    if (!open) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    settings.value = undefined;
    failed.value = false;
    try {
      const current = await getSharedriveData<RoomSettings>('/api/v1/system/settings', controller.signal);
      if (typeof current?.rooms_enabled !== 'boolean') throw new Error('Rooms-indstillingen mangler.');
      if (!controller.signal.aborted) settings.value = current;
    } catch {
      if (!controller.signal.aborted) failed.value = true;
    }
  }, { immediate: true });
  return { settings, failed };
}

export function listRoomLinkOptions(signal: AbortSignal): Promise<RoomLinkOption[]> {
  return getSharedriveData('/api/v1/rooms', signal);
}

export async function createRoomLinkOption(name: string): Promise<RoomLinkOption> {
  const response = await fetch('/api/v1/rooms', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw new Error('Rummet kunne ikke oprettes.');
  const result = await response.json();
  if (!result.data?.id || !result.data?.name) throw new Error('Rummet kunne ikke oprettes.');
  return result.data;
}
