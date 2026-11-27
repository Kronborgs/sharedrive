<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';

import MobileBottomNav from './components/shared/MobileBottomNav.vue';
import MailView from './components/mail/MailView.vue';
import CalendarView from './components/calendar/CalendarView.vue';
import ContactsView from './components/contacts/ContactsView.vue';
import ContactModal from './components/contacts/ContactModal.vue';
import { useSuiteStore } from './stores/suiteStore';
import { useMailStore } from './stores/mailStore';
import { useCalendarStore } from './stores/calendarStore';
import { useContactsStore } from './stores/contactsStore';
import { useTheme } from './composables/useTheme';
import { useViewport } from './composables/useViewport';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  Info,
  XCircle,
  Lock
} from 'lucide-vue-next';

const suiteStore = useSuiteStore();
const mailStore = useMailStore();
const calendarStore = useCalendarStore();
const contactsStore = useContactsStore();
const { currentTheme } = useTheme();
const { isMobile } = useViewport();

const calendarViewRef = ref<InstanceType<typeof CalendarView> | null>(null);

const isAnyModalOpen = computed(
  () =>
    suiteStore.isLoginModalOpen ||
    mailStore.isComposeModalOpen ||
    mailStore.isAliasModalOpen ||
    mailStore.isSieveModalOpen ||
    calendarStore.isEventModalOpen ||
    calendarStore.isTrashModalOpen ||
    calendarStore.isShareModalOpen ||
    calendarStore.isImportExportModalOpen ||
    calendarStore.isBulkDeleteModalOpen ||
    contactsStore.isContactModalOpen
);

// Dynamisk browser-fanebladstitel med ulæste mails + aktivt modul
watch(
  [
    () => mailStore.inboxUnreadCount,
    () => suiteStore.isAuthenticated,
    () => suiteStore.isPublicShareMode,
    () => suiteStore.activeModule,
    () => calendarStore.session?.shareLabel
  ],
  ([unread, authed, isShare, mod, shareLabel]) => {
    if (typeof document === 'undefined') return;
    if (isShare) {
      document.title = shareLabel || 'Delt Kalender — Sharedrive';
      return;
    }
    if (!authed) {
      document.title = 'Sharedrive';
      return;
    }
    const modLabel =
      mod === 'mail' ? 'Mail' : mod === 'calendar' ? 'Kalender' : 'Kontakter';
    const prefix = unread > 0 ? `(${unread}) ` : '';
    document.title = `${prefix}Sharedrive — ${modLabel}`;
  },
  { immediate: true }
);

// Opdatér FullCalendar-layout straks når brugeren skifter til Kalender-fanen
watch(
  () => suiteStore.activeModule,
  (mod) => {
    if (mod === 'calendar') {
      void nextTick(() => {
        window.setTimeout(() => calendarViewRef.value?.updateSize(), 30);
      });
    }
  }
);

function isTypingInInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  );
}

function handleGlobalKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    mailStore.closeContextMenu();
    calendarStore.closeContextMenu();
    if (!isAnyModalOpen.value && suiteStore.activeModule === 'contacts' && contactsStore.selectedContactIds.length > 0) {
      contactsStore.clearSelection();
    }
    if (mailStore.isComposeModalOpen) mailStore.isComposeModalOpen = false;
    if (mailStore.isAliasModalOpen) mailStore.isAliasModalOpen = false;
    if (mailStore.isSieveModalOpen) mailStore.isSieveModalOpen = false;
    if (calendarStore.isEventModalOpen) calendarStore.isEventModalOpen = false;
    if (calendarStore.isTrashModalOpen) calendarStore.isTrashModalOpen = false;
    if (calendarStore.isShareModalOpen) calendarStore.isShareModalOpen = false;
    if (calendarStore.isImportExportModalOpen) calendarStore.isImportExportModalOpen = false;
    if (calendarStore.isBulkDeleteModalOpen) calendarStore.isBulkDeleteModalOpen = false;
    if (contactsStore.isContactModalOpen) contactsStore.isContactModalOpen = false;
    if (suiteStore.isLoginModalOpen && suiteStore.isAuthenticated) {
      suiteStore.isLoginModalOpen = false;
    }
    return;
  }

  if (
    suiteStore.isPublicShareMode ||
    !suiteStore.isAuthenticated ||
    isAnyModalOpen.value
  ) {
    return;
  }

  // Globale Suite-genveje (Alt+1 / Alt+2 / Alt+3)
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === '1' && suiteStore.isAnyModuleEnabled('mail')) {
      e.preventDefault();
      suiteStore.setActiveModule('mail');
      return;
    }
    if (e.key === '2' && suiteStore.isAnyModuleEnabled('calendar')) {
      e.preventDefault();
      suiteStore.setActiveModule('calendar');
      return;
    }
    if (e.key === '3' && suiteStore.isAnyModuleEnabled('contacts')) {
      e.preventDefault();
      suiteStore.setActiveModule('contacts');
      return;
    }
  }

  if (isTypingInInput(e.target)) {
    return;
  }

  const isCtrlOrMeta = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (suiteStore.activeModule === 'mail') {
    if (isCtrlOrMeta && key === 'c') {
      const selText = window.getSelection()?.toString() || '';
      if (!selText) {
        e.preventDefault();
        mailStore.copyOrCutSelection('COPY');
      }
    } else if (isCtrlOrMeta && key === 'x') {
      e.preventDefault();
      mailStore.copyOrCutSelection('CUT');
    } else if (isCtrlOrMeta && key === 'v') {
      e.preventDefault();
      void mailStore.pasteClipboardToFolder();
    } else if (isCtrlOrMeta && key === 'z') {
      e.preventDefault();
      void mailStore.triggerUndo();
    } else if (isCtrlOrMeta && key === 'a') {
      e.preventDefault();
      mailStore.selectAllInCurrentList();
    } else if (isCtrlOrMeta && key === 'n') {
      e.preventDefault();
      mailStore.openComposeModal('NEW');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (mailStore.selectedMessageIds.length > 0 || mailStore.activeMessageId) {
        e.preventDefault();
        void mailStore.deleteSelectedMessages(undefined, e.shiftKey);
      }
    } else if (!isCtrlOrMeta && e.key === 'ArrowDown') {
      e.preventDefault();
      mailStore.navigateSelection(1, e.shiftKey);
    } else if (!isCtrlOrMeta && e.key === 'ArrowUp') {
      e.preventDefault();
      mailStore.navigateSelection(-1, e.shiftKey);
    }
  } else if (suiteStore.activeModule === 'calendar') {
    if (isCtrlOrMeta && key === 'c') {
      e.preventDefault();
      calendarStore.copyOrCutSelection('COPY');
    } else if (isCtrlOrMeta && key === 'x') {
      e.preventDefault();
      calendarStore.copyOrCutSelection('CUT');
    } else if (isCtrlOrMeta && key === 'v') {
      e.preventDefault();
      void calendarStore.pasteToDate();
    } else if (isCtrlOrMeta && key === 'z') {
      e.preventDefault();
      void calendarStore.triggerUndo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (calendarStore.selectedEventIds.length > 0) {
        e.preventDefault();
        void calendarStore.deleteEventsByIds(calendarStore.selectedEventIds);
      }
    }
  } else if (suiteStore.activeModule === 'contacts') {
    if (isCtrlOrMeta && key === 'n') {
      e.preventDefault();
      contactsStore.openCreateContactModal();
    } else if (isCtrlOrMeta && key === 'a') {
      e.preventDefault();
      contactsStore.selectAllInCurrentList();
    } else if (!isCtrlOrMeta && e.key === 'ArrowDown') {
      e.preventDefault();
      contactsStore.navigateSelection(1, e.shiftKey);
    } else if (!isCtrlOrMeta && e.key === 'ArrowUp') {
      e.preventDefault();
      contactsStore.navigateSelection(-1, e.shiftKey);
    }
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeyDown);
  await suiteStore.initSuite();
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeyDown);
});
</script>

<template>
  <div class="suite-app-height w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden relative">
    <!-- Fælles tema-baggrundsbillede & stemningsoverlay -->
    <div
      v-if="currentTheme.wallpaper"
      aria-hidden="true"
      class="absolute inset-0 bg-cover bg-center bg-no-repeat pointer-events-none transition-all duration-500 z-0"
      :style="{ backgroundImage: `url(${currentTheme.wallpaper})` }"
    />
    <div
      v-if="currentTheme.wallpaper"
      aria-hidden="true"
      class="absolute inset-0 pointer-events-none transition-all duration-500 z-0"
      :style="{ background: currentTheme.appOverlay }"
    />

    <!-- Hvis et offentligt kalender-delingslink er ugyldigt eller tilbagekaldt -->
    <div
      v-if="calendarStore.publicShareError"
      class="flex-1 flex items-center justify-center p-6 relative z-10"
    >
      <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center space-y-3 shadow-2xl">
        <div class="w-12 h-12 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-400 mx-auto">
          <Lock class="w-6 h-6" />
        </div>
        <h2 class="text-base font-bold text-slate-100">Delingslink ikke tilgængeligt</h2>
        <p class="text-xs text-slate-400 leading-relaxed">
          {{ calendarStore.publicShareError }}
        </p>
      </div>
    </div>

    <!-- Hovedvisning for Sharedrive (autentificeret eller offentlig kalender-deling) -->
    <div
      v-else-if="suiteStore.isAuthenticated || suiteStore.isPublicShareMode"
      class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden relative z-10"
    >
      <MailView
        v-if="suiteStore.isAnyModuleEnabled('mail') && suiteStore.visitedModules.mail && !suiteStore.isPublicShareMode"
        v-show="suiteStore.activeModule === 'mail'"
      />
      <CalendarView
        ref="calendarViewRef"
        v-if="(suiteStore.isAnyModuleEnabled('calendar') || suiteStore.isPublicShareMode) && suiteStore.visitedModules.calendar"
        v-show="suiteStore.activeModule === 'calendar'"
      />
      <ContactsView
        v-if="suiteStore.isAnyModuleEnabled('contacts') && suiteStore.visitedModules.contacts && !suiteStore.isPublicShareMode"
        v-show="suiteStore.activeModule === 'contacts'"
      />
    </div>

    <MobileBottomNav />

    <!-- Globale Modaler -->
    <p v-if="!suiteStore.isAuthenticated && !suiteStore.isPublicShareMode" class="p-5 text-slate-200">Mail kunne ikke åbnes. Kontrollér din konto i Sharedrive.</p>
    <ContactModal />

    <!-- Samlede Toast Notifikationer -->
    <div
      class="fixed z-50 flex flex-col gap-2 pointer-events-none"
      :class="isMobile ? 'bottom-20 left-3 right-3' : 'bottom-4 right-4 max-w-sm w-full'"
    >
      <div
        v-for="t in suiteStore.toasts"
        :key="t.id"
        class="pointer-events-auto p-3.5 rounded-xl border shadow-2xl backdrop-blur-md flex items-start justify-between gap-3 text-xs transition-all"
        :class="{
          'bg-slate-900/95 border-blue-500/40 text-slate-100': t.type === 'info',
          'bg-slate-900/95 border-emerald-500/40 text-slate-100': t.type === 'success',
          'bg-slate-900/95 border-amber-500/40 text-slate-100': t.type === 'warning',
          'bg-slate-900/95 border-rose-500/40 text-slate-100': t.type === 'error'
        }"
      >
        <div class="flex items-start gap-2.5 min-w-0">
          <CheckCircle2 v-if="t.type === 'success'" class="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <AlertTriangle v-else-if="t.type === 'warning'" class="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <XCircle v-else-if="t.type === 'error'" class="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <Info v-else class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
          <div class="min-w-0">
            <div class="font-semibold">{{ t.title }}</div>
            <div v-if="t.detail" class="text-slate-300 text-[11px] mt-0.5 leading-relaxed">
              {{ t.detail }}
            </div>
          </div>
        </div>
        <button
          type="button"
          class="text-slate-400 hover:text-slate-200 shrink-0"
          @click="suiteStore.dismissToast(t.id)"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  </div>
</template>
