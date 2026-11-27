<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import CalendarTopBar from './CalendarTopBar.vue';
import CalendarSidebar from './CalendarSidebar.vue';
import CalendarGrid from './CalendarGrid.vue';
import CalendarContextMenu from './CalendarContextMenu.vue';
import EventModal from './EventModal.vue';
import TrashModal from './TrashModal.vue';
import ShareModal from './ShareModal.vue';
import ImportExportModal from './ImportExportModal.vue';
import BulkDeleteModal from './BulkDeleteModal.vue';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';

const SIDEBAR_WIDTH_KEY = 'dav_sync_cal_sidebar_width_v1';
const SIDEBAR_COLLAPSED_KEY = 'dav_sync_cal_sidebar_collapsed_v1';

const calendarGridRef = ref<InstanceType<typeof CalendarGrid> | null>(null);
const currentTitle = ref('');

const { currentTheme } = useTheme();
const { isMobile } = useViewport();
const mobileDrawerOpen = ref(false);
const sidebarCollapsed = ref<boolean>(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');
const sidebarWidth = ref<number>(
  Math.min(420, Math.max(180, Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || 260))
);
const isResizingSidebar = ref<boolean>(false);

watch(isMobile, () => {
  void nextTick(() => {
    window.setTimeout(() => calendarGridRef.value?.updateSize(), 60);
  });
});

function toggleSidebar() {
  if (isMobile.value) {
    mobileDrawerOpen.value = !mobileDrawerOpen.value;
    return;
  }
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed.value));
  void nextTick(() => {
    window.setTimeout(() => calendarGridRef.value?.updateSize(), 50);
  });
}

function startResizeSidebar(e: MouseEvent) {
  e.preventDefault();
  isResizingSidebar.value = true;
  const startX = e.clientX;
  const startWidth = sidebarWidth.value;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientX - startX;
    sidebarWidth.value = Math.min(420, Math.max(180, startWidth + delta));
    calendarGridRef.value?.updateSize();
  };

  const onMouseUp = () => {
    isResizingSidebar.value = false;
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value));
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    calendarGridRef.value?.updateSize();
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function resetSidebarWidth() {
  sidebarWidth.value = 260;
  localStorage.setItem(SIDEBAR_WIDTH_KEY, '260');
  void nextTick(() => calendarGridRef.value?.updateSize());
}

function updateSize() {
  calendarGridRef.value?.updateSize();
}

defineExpose({
  updateSize
});
</script>

<template>
  <div
    class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden"
    :class="{ 'cursor-col-resize select-none': isResizingSidebar }"
  >
    <CalendarTopBar
      :title-text="currentTitle"
      :sidebar-collapsed="isMobile ? !mobileDrawerOpen : sidebarCollapsed"
      @prev="calendarGridRef?.goPrev()"
      @next="calendarGridRef?.goNext()"
      @today="calendarGridRef?.goToday()"
      @change-view="(v) => calendarGridRef?.changeView(v)"
      @jump-to-date="(d) => calendarGridRef?.jumpToDate(d)"
      @toggle-sidebar="toggleSidebar"
    />

    <!-- Mobil Slide-Over Skuffe til Kalendere -->
    <div
      v-if="isMobile && mobileDrawerOpen"
      class="fixed inset-0 z-40 flex"
    >
      <div
        class="fixed inset-0 bg-black/65 backdrop-blur-sm"
        @click="mobileDrawerOpen = false"
      ></div>
      <div class="relative z-10 w-[295px] max-w-[85vw] h-full p-2">
        <CalendarSidebar
          :width="280"
          :mobile-drawer="true"
          @close-drawer="mobileDrawerOpen = false"
        />
      </div>
    </div>

    <div
      class="flex-1 flex min-h-0 overflow-hidden relative z-10"
      :class="currentTheme.wallpaper ? 'px-2 sm:px-2.5 pb-2 sm:pb-2.5 pt-2' : ''"
    >
      <template v-if="!isMobile && !sidebarCollapsed">
        <CalendarSidebar :width="sidebarWidth" />
        <div
          class="cursor-col-resize transition-colors shrink-0 relative"
          :class="currentTheme.wallpaper ? 'w-2 bg-transparent hover:bg-white/15 active:bg-white/25 rounded-full my-2' : 'w-1.5 bg-slate-800/80 hover:bg-blue-500 active:bg-blue-400'"
          title="Træk for at tilpasse sidepanelets bredde (dobbeltklik for standardbredde)"
          @mousedown="startResizeSidebar"
          @dblclick="resetSidebarWidth"
        >
          <div class="absolute inset-y-0 -left-1 -right-1"></div>
        </div>
      </template>

      <CalendarGrid
        ref="calendarGridRef"
        @title-change="(t) => (currentTitle = t)"
      />
    </div>

    <CalendarContextMenu />
    <EventModal />
    <TrashModal />
    <ShareModal />
    <ImportExportModal />
    <BulkDeleteModal />
  </div>
</template>
