<script setup lang="ts">
const logoUrl = import.meta.env.BASE_URL + 'suite-icon.svg';
import { Mail, Calendar, Users } from 'lucide-vue-next';
import { useSuiteStore } from '../../stores/suiteStore';
import { useMailStore } from '../../stores/mailStore';
import { useContactsStore } from '../../stores/contactsStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';

const suiteStore = useSuiteStore();
const mailStore = useMailStore();
const contactsStore = useContactsStore();
const { currentTheme } = useTheme();
const { isMobile } = useViewport();
</script>

<template>
  <div class="flex items-center gap-2 shrink-0">
    <!-- Kompakt Sharedrive-ikon med online/offline prik -->
    <div
      class="relative w-8 h-8 rounded-xl border border-white/15 bg-black/25 flex items-center justify-center shadow-sm shrink-0"
      :title="`Sharedrive — ${suiteStore.username} (${suiteStore.isOnline ? 'Online' : 'Offline'})`"
    >
      <img :src="logoUrl" alt="Sharedrive" class="w-5 h-5" />
      <span
        class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-slate-900"
        :class="suiteStore.isOnline ? 'bg-emerald-400' : 'bg-amber-400'"
      ></span>
    </div>

    <!-- Segmenteret Modulskifter: Mail / Kalender / Kontakter (skjules på mobil/tablet hvor bundmenuen bruges) -->
    <nav
      v-if="!isMobile"
      aria-label="Sharedrive Moduler"
      class="flex items-center p-0.5 rounded-xl border text-xs transition shrink-0"
      :class="currentTheme.wallpaper ? 'bg-black/30 border-white/15' : 'bg-slate-950 border-slate-800'"
    >
      <button
        v-if="suiteStore.isAnyModuleEnabled('mail')"
        type="button"
        class="relative px-2.5 py-1 rounded-lg flex items-center gap-1.5 font-medium transition"
        :class="
          suiteStore.activeModule === 'mail'
            ? 'dav-theme-btn font-semibold shadow-sm'
            : 'text-slate-300/85 hover:text-white hover:bg-white/10'
        "
        :aria-current="suiteStore.activeModule === 'mail' ? 'page' : undefined"
        title="Mail (Alt+1)"
        @click="suiteStore.setActiveModule('mail')"
      >
        <Mail class="w-3.5 h-3.5 shrink-0" />
        <span class="hidden sm:inline">Mail</span>
        <span
          v-if="mailStore.inboxUnreadCount > 0"
          class="px-1.5 py-0.2 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-tight shadow-sm"
        >
          {{ mailStore.inboxUnreadCount > 99 ? '99+' : mailStore.inboxUnreadCount }}
        </span>
      </button>

      <button
        v-if="suiteStore.isAnyModuleEnabled('calendar')"
        type="button"
        class="px-2.5 py-1 rounded-lg flex items-center gap-1.5 font-medium transition"
        :class="
          suiteStore.activeModule === 'calendar'
            ? 'dav-theme-btn font-semibold shadow-sm'
            : 'text-slate-300/85 hover:text-white hover:bg-white/10'
        "
        :aria-current="suiteStore.activeModule === 'calendar' ? 'page' : undefined"
        title="Kalender (Alt+2)"
        @click="suiteStore.setActiveModule('calendar')"
      >
        <Calendar class="w-3.5 h-3.5 shrink-0" />
        <span class="hidden sm:inline">Kalender</span>
      </button>

      <button
        v-if="suiteStore.isAnyModuleEnabled('contacts')"
        type="button"
        class="px-2.5 py-1 rounded-lg flex items-center gap-1.5 font-medium transition"
        :class="
          suiteStore.activeModule === 'contacts'
            ? 'dav-theme-btn font-semibold shadow-sm'
            : 'text-slate-300/85 hover:text-white hover:bg-white/10'
        "
        :aria-current="suiteStore.activeModule === 'contacts' ? 'page' : undefined"
        :title="`Kontakter (Alt+3) — ${contactsStore.contacts.length} kontakter`"
        @click="suiteStore.setActiveModule('contacts')"
      >
        <Users class="w-3.5 h-3.5 shrink-0" />
        <span class="hidden sm:inline">Kontakter</span>
      </button>
    </nav>
  </div>
</template>
