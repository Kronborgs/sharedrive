<script setup lang="ts">
import { ref } from 'vue';
import { Palette, Check } from 'lucide-vue-next';
import { useTheme, type ThemeId } from '../../composables/useTheme';

const props = withDefaults(
  defineProps<{
    variant?: 'topbar' | 'floating';
  }>(),
  {
    variant: 'topbar'
  }
);

const { themes, activeThemeId, setTheme } = useTheme();
const isOpen = ref(false);

function chooseTheme(id: ThemeId) {
  setTheme(id);
  isOpen.value = false;
}
</script>

<template>
  <div class="relative">
    <button
      type="button"
      class="transition flex items-center gap-1.5"
      :class="
        props.variant === 'floating'
          ? 'px-2.5 py-1.5 rounded-xl bg-black/35 hover:bg-black/55 border border-white/15 text-white/85 hover:text-white backdrop-blur-md text-xs font-medium'
          : 'p-2 rounded-lg border border-white/10 bg-slate-800/70 hover:bg-slate-700/80 text-slate-300'
      "
      title="Vælg suite-tema"
      @click="isOpen = !isOpen"
    >
      <Palette class="w-4 h-4" />
      <span v-if="props.variant === 'floating'" class="hidden sm:inline">Tema</span>
    </button>

    <div
      v-if="isOpen"
      class="fixed inset-0 z-40"
      @click="isOpen = false"
    ></div>

    <div
      v-if="isOpen"
      class="absolute right-0 mt-2 w-[310px] sm:w-[490px] max-w-[calc(100vw-24px)] max-h-[75vh] overflow-y-auto rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-white/15 shadow-2xl p-2.5 z-50"
    >
      <div class="px-2 pb-2 border-b border-white/10 flex items-center justify-between">
        <span class="text-[11px] font-bold uppercase tracking-wider text-slate-300">
          Vælg tema
        </span>
        <span class="text-[10px] text-slate-400">{{ themes.length }} temaer · Hele Sharedrive</span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-2">
        <button
          v-for="t in themes"
          :key="t.id"
          type="button"
          class="w-full px-2 py-2 rounded-xl flex items-center justify-between gap-2 text-left transition"
          :class="
            t.id === activeThemeId
              ? 'bg-white/10 border border-white/15 text-white'
              : 'hover:bg-white/5 border border-transparent text-slate-300'
          "
          @click="chooseTheme(t.id)"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <div
              class="w-10 h-7 rounded-md shrink-0 border border-white/15 bg-cover bg-center relative overflow-hidden flex items-center justify-center"
              :style="
                t.wallpaper
                  ? { backgroundImage: `url(${t.wallpaper})` }
                  : { backgroundColor: '#0f172a' }
              "
            >
              <span
                class="w-2.5 h-2.5 rounded-full border border-white/40 shadow"
                :style="{ backgroundColor: t.swatch }"
              ></span>
            </div>
            <div class="min-w-0">
              <div class="text-xs font-semibold truncate">{{ t.name }}</div>
              <div class="text-[10px] text-slate-400 truncate">{{ t.subtitle }}</div>
            </div>
          </div>

          <Check
            v-if="t.id === activeThemeId"
            class="w-4 h-4 shrink-0 text-white"
          />
        </button>
      </div>
    </div>
  </div>
</template>
