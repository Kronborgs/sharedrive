import { defineStore } from 'pinia';
import { clearOfflineMail } from '../../../src/lib/offline-mail-storage';
import { ref, computed } from 'vue';
import type { SuiteModule, ToastMessage } from '../types/suite';
import type { MailDetail, MailHeader } from '../types/mail';
import type { Contact } from '../types/contacts';
import {
  apiGetSuiteConfig,
  apiGetSuiteSession,
  apiLoginSuite,
  apiLogoutSuite
} from '../services/authApi';
import { clearAllSuiteCaches } from '../db/database';
import { useMailStore } from './mailStore';
import { useCalendarStore } from './calendarStore';
import { useContactsStore } from './contactsStore';

function generateToastId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function detectInitialModule(enabled: SuiteModule[]): SuiteModule {
  if (typeof window !== 'undefined') {
    const requested = new URLSearchParams(window.location.search).get('view');
    if (requested === 'calendar' && enabled.includes('calendar')) return 'calendar';
    if (requested === 'contacts' && enabled.includes('contacts')) return 'contacts';
    const p = window.location.pathname.toLowerCase();
    if (p.startsWith('/calendar') && enabled.includes('calendar')) return 'calendar';
    if (p.startsWith('/contacts') && enabled.includes('contacts')) return 'contacts';
    if (p.startsWith('/mail') && enabled.includes('mail')) return 'mail';
  }
  return enabled[0] || 'mail';
}

export const useSuiteStore = defineStore('suite', () => {
  // Konfiguration & Autentificering
  const hasDefaultServer = ref<boolean>(true);
  const enabledModules = ref<SuiteModule[]>(['mail', 'calendar', 'contacts']);
  const sogoUrl = ref<string | null>(null);

  const isAuthenticated = ref<boolean>(false);
  const isPublicShareMode = ref<boolean>(false);
  const username = ref<string>('');
  const isLoginModalOpen = ref<boolean>(false);
  const isLoggingIn = ref<boolean>(false);
  const isOnline = ref<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

  // Aktivt modul & Lazy-mounting af moduler (holder allerede besøgte moduler i live)
  const activeModule = ref<SuiteModule>('mail');
  const visitedModules = ref<Record<SuiteModule, boolean>>({
    mail: true,
    calendar: false,
    contacts: false
  });

  // Samlede Toast-notifikationer
  const toasts = ref<ToastMessage[]>([]);

  const isAnyModuleEnabled = computed(() => (mod: SuiteModule) =>
    enabledModules.value.includes(mod)
  );

  function notify(
    title: string,
    detail?: string,
    type: ToastMessage['type'] = 'info',
    durationMs = 4500
  ) {
    const id = generateToastId();
    toasts.value.push({ id, title, detail, type });
    window.setTimeout(() => {
      dismissToast(id);
    }, durationMs);
  }

  function dismissToast(id: string) {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function resetUrlToRoot() {
    const defaultMod = enabledModules.value[0] || 'mail';
    activeModule.value = defaultMod;
    visitedModules.value = {
      mail: defaultMod === 'mail',
      calendar: defaultMod === 'calendar',
      contacts: defaultMod === 'contacts'
    };
    if (typeof window !== 'undefined' && !window.location.search.includes('share=')) {
      if (window.location.pathname !== '/' || window.location.search || window.location.hash) {
        window.history.replaceState(null, '', '/mail/suite-ui/index.html');
      }
    }
  }

  function setActiveModule(mod: SuiteModule, notifyParent = true) {
    if (isPublicShareMode.value && mod !== 'calendar') return;
    if (!enabledModules.value.includes(mod)) return;
    activeModule.value = mod;
    visitedModules.value[mod] = true;
    if (typeof window !== 'undefined' && !window.location.search.includes('share=')) {
      if (notifyParent && window.parent !== window) {
        window.parent.postMessage({ type: 'sharedrive-mail-view', view: mod }, window.location.origin);
      } else if (notifyParent) {
        const target = new URL(window.location.href);
        target.searchParams.set('view', mod);
        window.history.replaceState(null, '', target);
      }
    }
  }

  async function initSuite() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        isOnline.value = true;
        if (isAuthenticated.value) {
          notify('Forbindelse genoprettet', 'Synkroniserer Mail, Kalender & Kontakter...', 'success');
          const mailStore = useMailStore();
          const calendarStore = useCalendarStore();
          const contactsStore = useContactsStore();
          void mailStore.syncWithServer(true);
          void calendarStore.flushAndSyncOnReconnect();
          void contactsStore.syncWithServer(true);
        }
      });

      window.addEventListener('offline', () => {
        isOnline.value = false;
        if (isAuthenticated.value) {
          notify(
            'Offline-tilstand aktiv',
            'Cachede data vises fra IndexedDB, og kalenderændringer gemmes i kø.',
            'warning'
          );
        }
      });
    }

    const calendarStore = useCalendarStore();
    const mailStore = useMailStore();
    const contactsStore = useContactsStore();

    // 1. Tjek offentligt delingslink (?share=<token>) først
    const urlParams = new URLSearchParams(window.location.search);
    const shareToken = urlParams.get('share')?.trim();
    if (shareToken) {
      isPublicShareMode.value = true;
      activeModule.value = 'calendar';
      visitedModules.value.calendar = true;
      await calendarStore.loadPublicSharedCalendar(shareToken);
      return;
    }

    // 2. Hent server-konfiguration (uden at afsløre serveradresse fra .env)
    const cfg = await apiGetSuiteConfig();
    hasDefaultServer.value = cfg.hasDefaultServer;
    enabledModules.value = cfg.enabledModules;
    sogoUrl.value = cfg.sogoUrl;

    window.addEventListener('message', (event) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const message = event.data;
      if (message?.type === 'sharedrive-mail-view' && enabledModules.value.includes(message.view)) {
        setActiveModule(message.view, false);
      }
    });

    const initialMod = detectInitialModule(cfg.enabledModules);
    activeModule.value = initialMod;
    visitedModules.value[initialMod] = true;

    // 3. Tjek eksisterende SSO HttpOnly session-cookie
    try {
      const sess = await apiGetSuiteSession();
      if (sess.authenticated && sess.username) {
        isAuthenticated.value = true;
        username.value = sess.username;
        isLoginModalOpen.value = false;

        await Promise.all([
          enabledModules.value.includes('mail')
            ? mailStore.hydrateSession(sess.username, sess.aliases || [])
            : Promise.resolve(),
          enabledModules.value.includes('calendar')
            ? calendarStore.hydrateSession(sess.username)
            : Promise.resolve(),
          enabledModules.value.includes('contacts') || enabledModules.value.includes('mail')
            ? contactsStore.hydrateSession()
            : Promise.resolve()
        ]);
      } else {
        isAuthenticated.value = false;
        resetUrlToRoot();
        await clearAllSuiteCaches().catch(() => {});
        isLoginModalOpen.value = true;
      }
    } catch {
      isAuthenticated.value = false;
      resetUrlToRoot();
      isLoginModalOpen.value = true;
    }
  }

  async function login(params: {
    username: string;
    password: string;
    serverHost?: string;
    imapHost?: string;
    imapPort?: number;
    imapSecure?: boolean;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    caldavUrl?: string;
  }) {
    isLoggingIn.value = true;
    try {
      const res = await apiLoginSuite(params);
      isAuthenticated.value = true;
      isPublicShareMode.value = false;
      username.value = res.username;
      isLoginModalOpen.value = false;
      isOnline.value = true;

      const mailStore = useMailStore();
      const calendarStore = useCalendarStore();
      const contactsStore = useContactsStore();

      await Promise.all([
        mailStore.hydrateAfterLogin(res),
        calendarStore.hydrateAfterLogin(
          res.username,
          res.calendars || [],
          res.nameOverrides,
          res.dismissedSharedCount
        ),
        contactsStore.syncWithServer(true)
      ]);

      setActiveModule(activeModule.value);
      notify('Logget ind i Sharedrive', `Velkommen ${res.username}`, 'success');
    } finally {
      isLoggingIn.value = false;
    }
  }

  async function logout() {
    clearOfflineMail();
    await apiLogoutSuite();
    isAuthenticated.value = false;
    isPublicShareMode.value = false;
    username.value = '';

    const mailStore = useMailStore();
    const calendarStore = useCalendarStore();
    const contactsStore = useContactsStore();

    mailStore.resetState();
    calendarStore.resetState();
    contactsStore.resetState();

    await clearAllSuiteCaches().catch(() => {});
    resetUrlToRoot();
    isLoginModalOpen.value = true;
  }

  // --- Kryds-modulær integration (Mail <-> Kalender <-> Kontakter) ---
  function composeMailTo(email: string, name?: string) {
    if (!enabledModules.value.includes('mail')) return;
    const mailStore = useMailStore();
    setActiveModule('mail');
    const formatted = name?.trim() ? `${name.trim()} <${email.trim()}>` : email.trim();
    mailStore.openComposeModal('NEW', null, { to: [formatted] });
  }

  function composeMailToMany(
    recipients: Array<{ email: string; name?: string }>,
    field: 'to' | 'bcc' = 'bcc'
  ) {
    if (!enabledModules.value.includes('mail')) return;
    const seen = new Set<string>();
    const formatted: string[] = [];
    for (const r of recipients) {
      const cleanEmail = r.email.trim();
      const key = cleanEmail.toLowerCase();
      if (!cleanEmail || seen.has(key)) continue;
      seen.add(key);
      formatted.push(r.name?.trim() ? `${r.name.trim()} <${cleanEmail}>` : cleanEmail);
    }
    if (formatted.length === 0) return;
    const mailStore = useMailStore();
    setActiveModule('mail');
    mailStore.openComposeModal(
      'NEW',
      null,
      field === 'bcc' ? { bcc: formatted } : { to: formatted }
    );
  }

  function createEventFromMail(msg: MailDetail | MailHeader) {
    if (!enabledModules.value.includes('calendar')) return;
    const calendarStore = useCalendarStore();
    setActiveModule('calendar');
    calendarStore.openCreateEventFromMail({
      subject: msg.subject,
      from: msg.from,
      to: msg.to,
      date: msg.date,
      textBody: 'textBody' in msg ? msg.textBody : ''
    });
  }

  function saveSenderAsContact(name: string, email: string, emailImages?: string[]) {
    if (!enabledModules.value.includes('contacts')) return;
    const contactsStore = useContactsStore();
    contactsStore.openCreateContactModal({
      fullName: name,
      email,
      emailImages
    });
  }

  function mergeSenderIntoContact(
    contact: Contact,
    name: string,
    email: string,
    emailImages?: string[]
  ) {
    if (!enabledModules.value.includes('contacts')) return;
    const contactsStore = useContactsStore();
    contactsStore.openMergeSenderIntoContact(contact, {
      fullName: name,
      email,
      emailImages
    });
  }

  return {
    hasDefaultServer,
    enabledModules,
    sogoUrl,
    isAuthenticated,
    isPublicShareMode,
    username,
    isLoginModalOpen,
    isLoggingIn,
    isOnline,
    activeModule,
    visitedModules,
    toasts,
    isAnyModuleEnabled,
    notify,
    dismissToast,
    setActiveModule,
    initSuite,
    login,
    logout,
    composeMailTo,
    composeMailToMany,
    createEventFromMail,
    saveSenderAsContact,
    mergeSenderIntoContact
  };
});
