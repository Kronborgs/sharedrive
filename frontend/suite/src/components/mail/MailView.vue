<script setup lang="ts">
import { ref, watch } from 'vue';
import MailTopBar from './MailTopBar.vue';
import MailSidebar from './MailSidebar.vue';
import MessageList from './MessageList.vue';
import MessageReader from './MessageReader.vue';
import MailContextMenu from './MailContextMenu.vue';
import ComposeModal from './ComposeModal.vue';
import AliasModal from './AliasModal.vue';
import SieveModal from './SieveModal.vue';
import { useMailStore } from '../../stores/mailStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';

const SIDEBAR_WIDTH_KEY = 'imap_sync_mail_sidebar_width_v1';
const SIDEBAR_COLLAPSED_KEY = 'imap_sync_mail_sidebar_collapsed_v1';
const MSGLIST_WIDTH_KEY = 'imap_sync_mail_msglist_width_v1';
const MSGLIST_HEIGHT_KEY = 'imap_sync_mail_msglist_height_v1';

const store = useMailStore();
const { currentTheme } = useTheme();
const { isMobile } = useViewport();

const mobileDrawerOpen = ref(false);
const mobileShowReader = ref(false);

const sidebarCollapsed = ref<boolean>(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');
const sidebarWidth = ref<number>(
  Math.min(380, Math.max(180, Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || 250))
);
const msgListWidth = ref<number>(
  Math.min(620, Math.max(260, Number(localStorage.getItem(MSGLIST_WIDTH_KEY)) || 380))
);
const msgListHeight = ref<number>(
  Math.min(540, Math.max(160, Number(localStorage.getItem(MSGLIST_HEIGHT_KEY)) || 280))
);
const isResizing = ref<boolean>(false);

watch(
  () => store.activeFolderPath,
  () => {
    mobileShowReader.value = false;
  }
);

watch(
  () => store.activeMessageId,
  (id) => {
    if (!id) {
      mobileShowReader.value = false;
    }
  }
);

function toggleSidebar() {
  if (isMobile.value) {
    mobileDrawerOpen.value = !mobileDrawerOpen.value;
    return;
  }
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed.value));
}

function startResizeSidebar(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startX = e.clientX;
  const startWidth = sidebarWidth.value;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientX - startX;
    sidebarWidth.value = Math.min(380, Math.max(180, startWidth + delta));
  };

  const onMouseUp = () => {
    isResizing.value = false;
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value));
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function resetSidebarWidth() {
  sidebarWidth.value = 250;
  localStorage.setItem(SIDEBAR_WIDTH_KEY, '250');
}

function startResizeMsgList(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startX = e.clientX;
  const startWidth = msgListWidth.value;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientX - startX;
    msgListWidth.value = Math.min(620, Math.max(260, startWidth + delta));
  };

  const onMouseUp = () => {
    isResizing.value = false;
    localStorage.setItem(MSGLIST_WIDTH_KEY, String(msgListWidth.value));
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function resetMsgListWidth() {
  msgListWidth.value = 380;
  localStorage.setItem(MSGLIST_WIDTH_KEY, '380');
}

function startResizeMsgListHeight(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startY = e.clientY;
  const startHeight = msgListHeight.value;

  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientY - startY;
    msgListHeight.value = Math.min(540, Math.max(160, startHeight + delta));
  };

  const onMouseUp = () => {
    isResizing.value = false;
    localStorage.setItem(MSGLIST_HEIGHT_KEY, String(msgListHeight.value));
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function resetMsgListHeight() {
  msgListHeight.value = 280;
  localStorage.setItem(MSGLIST_HEIGHT_KEY, '280');
}
</script>

<template>
  <div
    class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden"
    :class="{ 'select-none': isResizing }"
  >
    <MailTopBar
      :sidebar-collapsed="isMobile ? !mobileDrawerOpen : sidebarCollapsed"
      @toggle-sidebar="toggleSidebar"
    />

    <!-- Mobil Slide-Over Skuffe til IMAP Mapper -->
    <div
      v-if="isMobile && mobileDrawerOpen"
      class="fixed inset-0 z-40 flex"
    >
      <div
        class="fixed inset-0 bg-black/65 backdrop-blur-sm"
        @click="mobileDrawerOpen = false"
      ></div>
      <div class="relative z-10 w-[285px] max-w-[85vw] h-full p-2">
        <MailSidebar
          :width="270"
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
        <MailSidebar :width="sidebarWidth" />
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

      <!-- Mobil: 1-rude Liste -> Detalje -->
      <template v-if="isMobile">
        <MessageReader
          v-if="mobileShowReader && store.activeMessageId"
          :show-mobile-back="true"
          @mobile-back="mobileShowReader = false"
        />
        <MessageList
          v-else
          :full-width="true"
          :split-mode="false"
          @open-message="mobileShowReader = true"
        />
      </template>

      <!-- Desktop Layout A: 3-Kolonne Widescreen -->
      <template v-else-if="store.layoutMode === 'THREE_COL'">
        <MessageList :width="msgListWidth" :split-mode="false" />
        <div
          class="cursor-col-resize transition-colors shrink-0 relative"
          :class="currentTheme.wallpaper ? 'w-2 bg-transparent hover:bg-white/15 active:bg-white/25 rounded-full my-2' : 'w-1.5 bg-slate-800/80 hover:bg-blue-500 active:bg-blue-400'"
          title="Træk for at tilpasse beskedlistens bredde (dobbeltklik for standardbredde)"
          @mousedown="startResizeMsgList"
          @dblclick="resetMsgListWidth"
        >
          <div class="absolute inset-y-0 -left-1 -right-1"></div>
        </div>
        <MessageReader />
      </template>

      <!-- Desktop Layout B: Klassisk Split-View -->
      <div v-else class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        <MessageList :height="msgListHeight" :split-mode="true" />
        <div
          class="cursor-row-resize transition-colors shrink-0 relative"
          :class="currentTheme.wallpaper ? 'h-2 bg-transparent hover:bg-white/15 active:bg-white/25 rounded-full mx-2' : 'h-1.5 bg-slate-800/80 hover:bg-blue-500 active:bg-blue-400'"
          title="Træk for at tilpasse beskedlistens højde (dobbeltklik for standardhøjde)"
          @mousedown="startResizeMsgListHeight"
          @dblclick="resetMsgListHeight"
        >
          <div class="absolute inset-x-0 -top-1 -bottom-1"></div>
        </div>
        <MessageReader />
      </div>
    </div>

    <MailContextMenu />
    <ComposeModal />
    <AliasModal />
    <SieveModal />
  </div>
</template>
