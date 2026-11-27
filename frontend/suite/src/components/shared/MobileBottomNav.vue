<script setup lang="ts">
import { Mail, Calendar, Users, Smartphone, Download, X } from 'lucide-vue-next';
import { useSuiteStore } from '../../stores/suiteStore';
import { useMailStore } from '../../stores/mailStore';
import { useTheme } from '../../composables/useTheme';
import { useViewport } from '../../composables/useViewport';

const suiteStore = useSuiteStore();
const mailStore = useMailStore();
const { currentTheme } = useTheme();
const {
  isMobile,
  isTablet,
  isStandalonePwa,
  isIos,
  canPromptPwaInstall,
  showMobilePwaInstallBanner,
  displayModeLabel,
  triggerPwaInstall,
  dismissPwaInstallBanner
} = useViewport();
</script>

<template>
  <div
    v-if="isMobile && suiteStore.isAuthenticated && !suiteStore.isPublicShareMode"
    class="shrink-0 relative z-30"
  >
    <!-- Valgfrit PWA-installationsbanner i mobilbrowser -->
    <div
      v-if="showMobilePwaInstallBanner"
      class="px-3 py-2 border-t flex items-center justify-between gap-2 text-xs backdrop-blur-xl"
      :class="
        currentTheme.wallpaper
          ? 'bg-black/45 border-white/15 text-slate-100'
          : 'bg-slate-900 border-slate-800 text-slate-100'
      "
    >
      <div class="flex items-center gap-2 min-w-0">
        <Smartphone class="w-4 h-4 text-blue-400 shrink-0" />
        <span v-if="canPromptPwaInstall" class="truncate text-[11.5px]">
          <strong class="text-slate-100">{{ displayModeLabel }}:</strong> Installér som app på hjemskærmen
        </span>
        <span v-else-if="isIos" class="text-[11px] leading-snug text-slate-200">
          <strong>{{ displayModeLabel }}:</strong> Tryk på <strong>Del</strong> → <em>Føj til hjemmeskærm</em> for PWA-app
        </span>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <button
          v-if="canPromptPwaInstall"
          type="button"
          class="px-2.5 py-1 rounded-lg dav-theme-btn text-[11px] font-semibold flex items-center gap-1 shadow-sm"
          @click="triggerPwaInstall()"
        >
          <Download class="w-3 h-3" />
          <span>Installér</span>
        </button>
        <button
          type="button"
          class="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition"
          title="Skjul besked"
          @click="dismissPwaInstallBanner()"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>

    <!-- Fast Mobil Bundnavigation -->
    <nav
      aria-label="Mobil modulnavigation"
      class="border-t pb-safe backdrop-blur-xl transition-colors"
      :class="
        currentTheme.wallpaper
          ? 'border-white/15'
          : 'bg-slate-900/95 border-slate-800'
      "
      :style="
        currentTheme.wallpaper
          ? { backgroundColor: currentTheme.surface, borderColor: currentTheme.border }
          : undefined
      "
    >
      <div class="h-14 px-2 flex items-center justify-around gap-1">
        <button
          v-if="suiteStore.isAnyModuleEnabled('mail')"
          type="button"
          class="relative flex-1 h-11 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition"
          :class="
            suiteStore.activeModule === 'mail'
              ? 'dav-theme-btn font-semibold shadow-sm'
              : 'text-slate-300 hover:bg-white/10'
          "
          :aria-current="suiteStore.activeModule === 'mail' ? 'page' : undefined"
          @click="suiteStore.setActiveModule('mail')"
        >
          <div class="relative">
            <Mail class="w-4 h-4" />
            <span
              v-if="mailStore.inboxUnreadCount > 0"
              class="absolute -top-1.5 -right-2.5 px-1 min-w-[16px] h-4 rounded-full bg-rose-500 text-white text-[9.5px] font-bold flex items-center justify-center shadow"
            >
              {{ mailStore.inboxUnreadCount > 99 ? '99+' : mailStore.inboxUnreadCount }}
            </span>
          </div>
          <span>Mail</span>
        </button>

        <button
          v-if="suiteStore.isAnyModuleEnabled('calendar')"
          type="button"
          class="flex-1 h-11 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition"
          :class="
            suiteStore.activeModule === 'calendar'
              ? 'dav-theme-btn font-semibold shadow-sm'
              : 'text-slate-300 hover:bg-white/10'
          "
          :aria-current="suiteStore.activeModule === 'calendar' ? 'page' : undefined"
          @click="suiteStore.setActiveModule('calendar')"
        >
          <Calendar class="w-4 h-4" />
          <span>Kalender</span>
        </button>

        <button
          v-if="suiteStore.isAnyModuleEnabled('contacts')"
          type="button"
          class="flex-1 h-11 rounded-xl flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition"
          :class="
            suiteStore.activeModule === 'contacts'
              ? 'dav-theme-btn font-semibold shadow-sm'
              : 'text-slate-300 hover:bg-white/10'
          "
          :aria-current="suiteStore.activeModule === 'contacts' ? 'page' : undefined"
          @click="suiteStore.setActiveModule('contacts')"
        >
          <Users class="w-4 h-4" />
          <span>Kontakter</span>
        </button>

        <div
          class="px-2 py-1 rounded-lg border text-[10px] font-semibold flex items-center gap-1 shrink-0"
          :class="
            isStandalonePwa
              ? 'bg-emerald-500/15 border-emerald-400/35 text-emerald-300'
              : 'bg-white/5 border-white/10 text-slate-400'
          "
          :title="`Kører i: ${displayModeLabel}`"
        >
          <Smartphone class="w-3 h-3 shrink-0" />
          <span>{{ isStandalonePwa ? 'PWA' : isTablet ? 'Tablet' : 'Mobil' }}</span>
        </div>
      </div>
    </nav>
  </div>
</template>
