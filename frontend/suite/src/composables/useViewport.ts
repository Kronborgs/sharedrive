import { ref, computed } from 'vue';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const PWA_BANNER_DISMISSED_KEY = 'brogaard_pwa_hint_dismissed_v1';

const isMobile = ref(false);
const isTablet = ref(false);
const isMobileBrowser = ref(false);
const isTouchDevice = ref(false);
const isStandalonePwa = ref(false);
const deferredInstallPrompt = ref<BeforeInstallPromptEvent | null>(null);
const pwaBannerDismissed = ref(
  typeof localStorage !== 'undefined' &&
    localStorage.getItem(PWA_BANNER_DISMISSED_KEY) === 'true'
);

let initialized = false;

function readStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    Boolean(nav.standalone)
  );
}

function detectMobileOrTabletBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & {
    userAgentData?: { mobile?: boolean };
  };
  if (nav.userAgentData?.mobile === true) return true;

  const ua = nav.userAgent || '';
  if (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|Silk|Kindle|PlayBook/i.test(
      ua
    )
  ) {
    return true;
  }

  // iPadOS Safari i desktop-visning rapporterer "MacIntel" med touch-punkter
  if ((nav.platform || '') === 'MacIntel' && (nav.maxTouchPoints || 0) > 1) {
    return true;
  }

  // Enheder uden mus/hover-peger (ren touch-telefon eller tablet)
  if (window.matchMedia('(pointer: coarse) and (hover: none)').matches) {
    return true;
  }

  return false;
}

function initViewportListeners() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  const narrowMq = window.matchMedia('(max-width: 1023px)');
  const tabletWidthMq = window.matchMedia('(min-width: 768px)');
  const touchMq = window.matchMedia('(pointer: coarse)');
  const coarseNoHoverMq = window.matchMedia('(pointer: coarse) and (hover: none)');
  const standaloneMq = window.matchMedia('(display-mode: standalone)');
  const fullscreenMq = window.matchMedia('(display-mode: fullscreen)');

  const update = () => {
    const browserIsMobileOrTablet = detectMobileOrTabletBrowser();
    isMobileBrowser.value = browserIsMobileOrTablet;
    isMobile.value = narrowMq.matches || browserIsMobileOrTablet;
    isTablet.value = isMobile.value && tabletWidthMq.matches;
    isTouchDevice.value = touchMq.matches || (window.navigator?.maxTouchPoints || 0) > 0;
    isStandalonePwa.value = readStandalonePwa();
  };

  update();

  narrowMq.addEventListener('change', update);
  tabletWidthMq.addEventListener('change', update);
  touchMq.addEventListener('change', update);
  coarseNoHoverMq.addEventListener('change', update);
  standaloneMq.addEventListener('change', update);
  fullscreenMq.addEventListener('change', update);

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredInstallPrompt.value = e as BeforeInstallPromptEvent;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt.value = null;
    isStandalonePwa.value = true;
  });
}

initViewportListeners();

const isIos = computed<boolean>(() => {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent || '';
  const platform = window.navigator.platform || '';
  return (
    /iPad|iPhone|iPod/i.test(ua) ||
    (platform === 'MacIntel' && (window.navigator.maxTouchPoints || 0) > 1)
  );
});

const canPromptPwaInstall = computed<boolean>(
  () => Boolean(deferredInstallPrompt.value) && !isStandalonePwa.value
);

const showMobilePwaInstallBanner = computed<boolean>(
  () =>
    isMobile.value &&
    !isStandalonePwa.value &&
    !pwaBannerDismissed.value &&
    (canPromptPwaInstall.value || isIos.value)
);

const displayModeLabel = computed<string>(() => {
  if (isStandalonePwa.value) return 'PWA App';
  if (isTablet.value) return 'Tablet';
  if (isMobile.value) return 'Mobilbrowser';
  return 'Desktop';
});

async function triggerPwaInstall(): Promise<boolean> {
  const promptEvent = deferredInstallPrompt.value;
  if (!promptEvent) return false;
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    deferredInstallPrompt.value = null;
    if (choice.outcome === 'accepted') {
      isStandalonePwa.value = true;
      return true;
    }
    return false;
  } catch {
    deferredInstallPrompt.value = null;
    return false;
  }
}

function dismissPwaInstallBanner(): void {
  pwaBannerDismissed.value = true;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(PWA_BANNER_DISMISSED_KEY, 'true');
  }
}

export function useViewport() {
  initViewportListeners();
  return {
    isMobile,
    isTablet,
    isMobileBrowser,
    isTouchDevice,
    isStandalonePwa,
    isIos,
    canPromptPwaInstall,
    pwaBannerDismissed,
    showMobilePwaInstallBanner,
    displayModeLabel,
    triggerPwaInstall,
    dismissPwaInstallBanner
  };
}
