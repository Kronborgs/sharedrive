import { suiteStorage } from '../sharedrive-storage';
import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { db, purgeExpiredTrash } from '../db/database';
import { useSuiteStore } from './suiteStore';
import { useContactsStore } from './contactsStore';
import {
  apiSyncCalDav,
  apiSaveEvent,
  apiDeleteEvent,
  apiBulkDeleteEvents,
  apiUpdateRsvp,
  apiCreateCalendar,
  apiDeleteCalendar,
  apiListShares,
  apiCreateShare,
  apiDeleteShare,
  apiListUserShares,
  apiUpsertUserShare,
  apiUpdateUserSharePermission,
  apiDeleteUserShare,
  apiLeaveSharedCalendar,
  apiRestoreDismissedSharedCalendars,
  apiSearchSharedCalendars,
  apiSubscribeSharedCalendar,
  apiSetCalendarName,
  apiSetCalendarColor,
  apiFetchPublicShare,
  apiImportIcs,
  apiExportIcs,
  apiSubscribeCalendar,
  apiUnsubscribeCalendar,
  apiSyncBirthdaysToMailcow,
  apiDisableBirthdaysSync,
  type LocalSubscriptionHint
} from '../services/caldavApi';
import { startReminderWatcher } from '../services/notifications';
import type {
  AuthSession,
  CalendarSource,
  CalendarEvent,
  TrashItem,
  SyncQueueItem,
  UndoAction,
  ClipboardState,
  ContextMenuState,
  RsvpStatus,
  PublicShareLink,
  UserCalendarShare,
  CalendarSharePermission,
  CalendarViewType,
  SharedCalendarSearchResult
} from '../types/calendar';

const COLOR_OVERRIDE_KEY = 'dav_sync_cal_color_overrides_v1';
const NAME_OVERRIDE_KEY = 'dav_sync_cal_name_overrides_v1';
const HIDDEN_CAL_KEY = 'dav_sync_cal_hidden_calendars_v1';
const SUBSCRIPTIONS_STORAGE_KEY = 'dav_sync_cal_subscriptions_v1';
const SHOW_BIRTHDAYS_KEY = 'brogaard_suite_show_birthdays_v1';
const AUTO_REFRESH_KEY = 'dav_sync_cal_auto_refresh_min_v1';
export const BIRTHDAY_CALENDAR_ID = 'builtin::contact-birthdays';
export type CalendarAutoRefreshMinutes = 0 | 1 | 2 | 5 | 10;

function loadHiddenCalendarIds(): string[] {
  try {
    const raw = suiteStorage.getItem(HIDDEN_CAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function clonePlain<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  return JSON.parse(JSON.stringify(obj));
}

export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export const useCalendarStore = defineStore('calendar', () => {
  const suiteStore = useSuiteStore();
  const contactsStore = useContactsStore();

  const isOnline = computed(() => suiteStore.isOnline);
  const session = ref<AuthSession | null>(null);
  const calendars = ref<CalendarSource[]>([]);
  const events = ref<CalendarEvent[]>([]);
  const trashItems = ref<TrashItem[]>([]);
  const syncQueue = ref<SyncQueueItem[]>([]);
  const shares = ref<PublicShareLink[]>([]);
  const userShares = ref<UserCalendarShare[]>([]);
  const isLoadingUserShares = ref<boolean>(false);
  const publicShareError = ref<string>('');

  const isSyncing = ref<boolean>(false);
  const lastSyncedAt = ref<string | null>(null);

  const savedRefresh = Number(suiteStorage.getItem(AUTO_REFRESH_KEY));
  const autoRefreshMinutes = ref<CalendarAutoRefreshMinutes>(
    savedRefresh === 0 ||
      savedRefresh === 1 ||
      savedRefresh === 2 ||
      savedRefresh === 5 ||
      savedRefresh === 10
      ? (savedRefresh as CalendarAutoRefreshMinutes)
      : 2
  );
  let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let visibilityListenerBound = false;

  const currentView = ref<CalendarViewType>('dayGridMonth');
  const selectedEventIds = ref<string[]>([]);
  const selectedDateStr = ref<string>(toDateOnlyString(new Date()));
  const activeTargetCalendarId = ref<string>('');
  const searchQuery = ref<string>('');

  const showContactBirthdays = ref<boolean>(
    suiteStorage.getItem(SHOW_BIRTHDAYS_KEY) !== 'false'
  );
  const isSyncingBirthdaysToMailcow = ref<boolean>(false);
  const birthdayCalendarSyncEnabled = ref<boolean>(false);
  const birthdayCalendarUrl = ref<string | null>(null);

  const clipboard = ref<ClipboardState>({
    mode: null,
    events: [],
    sourceAnchorDate: null,
    copiedAt: null
  });
  const undoStack = ref<UndoAction[]>([]);

  const contextMenu = ref<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetType: 'DATE',
    event: null,
    dateStr: null,
    allDay: true
  });
  const isTrashModalOpen = ref<boolean>(false);
  const isShareModalOpen = ref<boolean>(false);
  const preselectedShareCalendarId = ref<string>('');
  const isImportExportModalOpen = ref<boolean>(false);
  const preselectedImportExportCalendarId = ref<string>('');
  const isBulkDeleteModalOpen = ref<boolean>(false);
  const editingEvent = ref<CalendarEvent | null>(null);
  const isEventModalOpen = ref<boolean>(false);

  let isFlushing = false;
  let flushRequested = false;
  let userSharesRequestSeq = 0;
  const colorSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const hiddenCalendarIds = ref<string[]>(loadHiddenCalendarIds());
  const dismissedSharedCount = ref<number>(0);

  const isPublicShareMode = computed(() => session.value?.mode === 'PUBLIC_SHARE');
  const isAuthenticated = computed(
    () =>
      Boolean(
        session.value && (session.value.mode === 'CALDAV' || session.value.mode === 'PUBLIC_SHARE')
      )
  );

  function notify(
    title: string,
    detail?: string,
    type: 'info' | 'success' | 'warning' | 'error' = 'info',
    durationMs = 4500
  ) {
    suiteStore.notify(title, detail, type, durationMs);
  }

  function logout() {
    void suiteStore.logout();
  }

  function getColorOverrides(): Record<string, string> {
    try {
      const raw = suiteStorage.getItem(COLOR_OVERRIDE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveColorOverrides(overrides: Record<string, string>) {
    suiteStorage.setItem(COLOR_OVERRIDE_KEY, JSON.stringify(overrides));
  }

  function getNameOverrides(): Record<string, string> {
    try {
      const raw = suiteStorage.getItem(NAME_OVERRIDE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveNameOverrides(overrides: Record<string, string>) {
    suiteStorage.setItem(NAME_OVERRIDE_KEY, JSON.stringify(overrides));
  }

  function getCalendarById(calId: string): CalendarSource | undefined {
    if (calId === BIRTHDAY_CALENDAR_ID) {
      const defaultColor = '#ec4899';
      const customColor = contactsStore.contactCalendarColor || defaultColor;
      return {
        id: BIRTHDAY_CALENDAR_ID,
        url: 'builtin://contact-birthdays',
        name:
          contactsStore.contactsWithAnniversariesCount > 0
            ? 'Fødselsdage & Mærkedage (Kontakter)'
            : 'Fødselsdage (Kontakter)',
        color: customColor,
        serverColor: defaultColor,
        localColorOverride: customColor !== defaultColor ? customColor : null,
        readOnly: true,
        isShared: false,
        isSubscribed: true,
        visible: showContactBirthdays.value,
        owner: 'Sharedrive Kontakter'
      };
    }
    return calendars.value.find((c) => c.id === calId);
  }

  function isCalendarReadOnly(calId: string): boolean {
    if (isPublicShareMode.value || calId === BIRTHDAY_CALENDAR_ID) return true;
    const cal = getCalendarById(calId);
    return Boolean(cal?.readOnly);
  }

  function hasInvitedAttendees(ev: CalendarEvent): boolean {
    if (!ev.attendees || ev.attendees.length === 0) return false;
    const currentUser = (session.value?.username || '').toLowerCase().trim();
    const currentLocalPart = currentUser.split('@')[0];

    const externalGuests = ev.attendees.filter((a) => {
      const email = (a.email || '').toLowerCase().trim();
      if (!email) return false;
      if (currentUser && (email === currentUser || email.split('@')[0] === currentLocalPart)) {
        return false;
      }
      return true;
    });

    return externalGuests.length > 0;
  }

  const visibleCalendarIds = computed(() =>
    new Set(calendars.value.filter((c) => c.visible).map((c) => c.id))
  );

  const writableCalendars = computed(() =>
    isPublicShareMode.value ? [] : calendars.value.filter((c) => !c.readOnly)
  );

  function pickDefaultTargetCalendar(): CalendarSource | undefined {
    return writableCalendars.value.find((c) => !c.isShared) || writableCalendars.value[0];
  }

  const defaultWritableCalendar = computed<CalendarSource | undefined>(() => {
    if (activeTargetCalendarId.value) {
      const found = writableCalendars.value.find((c) => c.id === activeTargetCalendarId.value);
      if (found) return found;
    }
    return pickDefaultTargetCalendar();
  });

  const syncedBirthdayCalendar = computed<CalendarSource | undefined>(() =>
    calendars.value.find((c) => c.isContactBirthdays)
  );

  // Virtuelle fødselsdage og mærkedage (bruges kun når kalenderen ikke allerede synkroniseres direkte fra Mailcow)
  const birthdayEvents = computed<CalendarEvent[]>(() => {
    if (isPublicShareMode.value || !showContactBirthdays.value || syncedBirthdayCalendar.value) return [];
    const currentYear = new Date().getFullYear();
    const selectedYear = Number(selectedDateStr.value?.slice(0, 4)) || currentYear;
    const yearsSet = new Set<number>();
    for (let y = currentYear - 1; y <= currentYear + 1; y++) yearsSet.add(y);
    for (let y = selectedYear - 1; y <= selectedYear + 1; y++) yearsSet.add(y);
    const years = Array.from(yearsSet).sort((a, b) => a - b);

    const result: CalendarEvent[] = [];

    const appendRecurringSpecialDate = (
      contactUid: string,
      displayFirstName: string,
      fullName: string,
      rawDate: string | undefined,
      kindKey: 'birthday' | 'anniversary',
      icon: string,
      customLabel?: string
    ) => {
      if (!rawDate) return;
      const match = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!match) return;
      const originYear = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return;

      for (const y of years) {
        const effDay = month === 2 && day === 29 && !isLeapYear(y) ? 28 : day;
        const startYmd = `${y}-${String(month).padStart(2, '0')}-${String(effDay).padStart(2, '0')}`;
        const endYmd = addDaysToDateOnly(startYmd, 1);
        const diffYears = y - originYear;
        const yearsSuffix =
          originYear >= 1900 && diffYears > 0 && diffYears <= 130 ? ` (${diffYears} år)` : '';

        const title =
          kindKey === 'birthday'
            ? `${icon} ${displayFirstName}${yearsSuffix}`
            : `${icon} ${displayFirstName} – ${customLabel || 'Bryllupsdag'}${yearsSuffix}`;

        const description =
          kindKey === 'birthday'
            ? `Fødselsdag for ${fullName} (fra Sharedrive Kontakter)`
            : `${customLabel || 'Bryllupsdag'} for ${fullName} (fra Sharedrive Kontakter)`;

        result.push({
          id: `${BIRTHDAY_CALENDAR_ID}::${kindKey}::${contactUid}::${y}`,
          uid: `${kindKey}-${contactUid}-${y}`,
          calendarId: BIRTHDAY_CALENDAR_ID,
          title,
          start: startYmd,
          end: endYmd,
          allDay: true,
          description,
          location: '',
          timezone: 'Europe/Copenhagen',
          attendees: [],
          reminderMinutes: null
        });
      }
    };

    for (const contact of contactsStore.contacts) {
      const firstName =
        contact.firstName?.trim().split(/\s+/).filter(Boolean)[0] ||
        contact.fullName?.trim().split(/\s+/).filter(Boolean)[0] ||
        'Kontakt';
      appendRecurringSpecialDate(
        contact.uid,
        firstName,
        contact.fullName,
        contact.birthday,
        'birthday',
        '🎂'
      );
      appendRecurringSpecialDate(
        contact.uid,
        firstName,
        contact.fullName,
        contact.anniversary,
        'anniversary',
        '💍',
        contact.anniversaryLabel || 'Bryllupsdag'
      );
    }

    return result;
  });

  const visibleEvents = computed(() => [
    ...events.value.filter((ev) => visibleCalendarIds.value.has(ev.calendarId)),
    ...birthdayEvents.value
  ]);

  const clipboardEventIds = computed(() => new Set(clipboard.value.events.map((e) => e.id)));

  const searchResults = computed(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return [];
    return [...events.value, ...birthdayEvents.value]
      .filter((ev) => {
        const cal = getCalendarById(ev.calendarId);
        const calName = cal?.name || '';
        const serverCalName = cal?.serverName || '';
        const attendeeStr = (ev.attendees || [])
          .map((a) => `${a.name || ''} ${a.email}`)
          .join(' ');
        const haystack =
          `${ev.title} ${ev.location || ''} ${ev.description || ''} ${calName} ${serverCalName} ${attendeeStr}`.toLowerCase();
        return haystack.includes(q);
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      .slice(0, 25);
  });

  function toggleContactBirthdays() {
    showContactBirthdays.value = !showContactBirthdays.value;
    suiteStorage.setItem(SHOW_BIRTHDAYS_KEY, String(showContactBirthdays.value));
  }

  /**
   * Finder kalenderbegivenheder, der overlapper med et givent tidsrum (bruges til .ics invitations-konflikttjek i Mail).
   */
  function findConflictingEvents(startRaw: string, endRaw?: string): CalendarEvent[] {
    const parseBoundary = (raw: string): number => {
      const compact = raw
        .trim()
        .match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
      if (compact) {
        const [, y, m, d, hh, mm, ss, z] = compact;
        if (hh) {
          return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}${z || ''}`).getTime();
        }
        return new Date(`${y}-${m}-${d}T00:00:00`).getTime();
      }
      return new Date(raw).getTime();
    };

    const startMs = parseBoundary(startRaw);
    if (Number.isNaN(startMs)) return [];
    let endMs = endRaw ? parseBoundary(endRaw) : startMs + 60 * 60 * 1000;
    if (Number.isNaN(endMs) || endMs <= startMs) {
      endMs = startMs + 60 * 60 * 1000;
    }

    return events.value.filter((ev) => {
      if (ev.allDay) return false;
      const evStart = new Date(ev.start).getTime();
      const evEnd = new Date(ev.end || ev.start).getTime();
      if (Number.isNaN(evStart) || Number.isNaN(evEnd)) return false;
      return evStart < endMs && evEnd > startMs;
    });
  }

  async function flushAndSyncOnReconnect() {
    if (session.value?.mode === 'CALDAV') {
      await flushSyncQueue();
      await syncWithServer(true);
    }
  }

  function setupAutoRefreshTimer() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    if (typeof window === 'undefined') return;

    if (!visibilityListenerBound && typeof document !== 'undefined') {
      visibilityListenerBound = true;
      document.addEventListener('visibilitychange', () => {
        if (
          document.visibilityState === 'visible' &&
          autoRefreshMinutes.value > 0 &&
          isAuthenticated.value &&
          !isPublicShareMode.value &&
          isOnline.value &&
          !isSyncing.value &&
          !isEventModalOpen.value
        ) {
          const lastMs = lastSyncedAt.value ? new Date(lastSyncedAt.value).getTime() : 0;
          if (!lastMs || Date.now() - lastMs >= 60_000) {
            void syncWithServer(true);
          }
        }
      });
    }

    if (autoRefreshMinutes.value > 0) {
      const intervalMs = autoRefreshMinutes.value * 60 * 1000;
      autoRefreshTimer = setInterval(() => {
        if (
          isAuthenticated.value &&
          !isPublicShareMode.value &&
          isOnline.value &&
          !isSyncing.value &&
          !isEventModalOpen.value
        ) {
          void syncWithServer(true);
        }
      }, intervalMs);
    }
  }

  function setAutoRefreshMinutes(minutes: CalendarAutoRefreshMinutes) {
    autoRefreshMinutes.value = minutes;
    suiteStorage.setItem(AUTO_REFRESH_KEY, String(minutes));
    setupAutoRefreshTimer();
    if (minutes === 0) {
      notify('Auto-opdatering slået fra', 'Kalendere opdateres nu kun ved manuelt klik.', 'info');
    } else {
      notify(
        'Auto-opdatering aktiv',
        `Synkroniserer automatisk kalendere hvert ${minutes}. minut.`,
        'success'
      );
    }
  }

  async function hydrateSession(user: string) {
    session.value = {
      mode: 'CALDAV',
      serverUrl: '',
      username: user,
      connectedAt: new Date().toISOString()
    };

    await purgeExpiredTrash();
    trashItems.value = await db.trash.orderBy('deletedAt').reverse().toArray();
    syncQueue.value = await db.syncQueue.toArray();

    const storedCalendars = await db.calendars.toArray();
    const storedEvents = await db.events.toArray();

    if (storedCalendars.length > 0) {
      applyColorOverridesToCalendars(storedCalendars);
      applyNameOverridesToCalendars(storedCalendars);
      calendars.value = storedCalendars;
      events.value = storedEvents;
      if (!writableCalendars.value.some((c) => c.id === activeTargetCalendarId.value)) {
        const preferred = pickDefaultTargetCalendar();
        if (preferred) {
          activeTargetCalendarId.value = preferred.id;
        }
      }
    }

    startReminderWatcher(() => visibleEvents.value);
    setupAutoRefreshTimer();

    if (isOnline.value) {
      void flushSyncQueue().then(() => syncWithServer(true));
    }
  }

  async function hydrateAfterLogin(
    user: string,
    initialServerCalendars: Omit<CalendarSource, 'visible'>[],
    initialNameOverrides?: Record<string, string>,
    initialDismissedSharedCount?: number
  ) {
    session.value = {
      mode: 'CALDAV',
      serverUrl: '',
      username: user,
      connectedAt: new Date().toISOString()
    };
    dismissedSharedCount.value = Number(initialDismissedSharedCount || 0);

    await purgeExpiredTrash();
    trashItems.value = await db.trash.orderBy('deletedAt').reverse().toArray();
    syncQueue.value = await db.syncQueue.toArray();

    if (Array.isArray(initialServerCalendars) && initialServerCalendars.length > 0) {
      const hiddenSet = new Set(hiddenCalendarIds.value);
      const initialCals: CalendarSource[] = initialServerCalendars
        .filter((c) => !hiddenSet.has(c.id))
        .map((c) => ({ ...c, visible: true }));
      applyColorOverridesToCalendars(initialCals);
      applyNameOverridesToCalendars(initialCals, initialNameOverrides);
      calendars.value = initialCals;
      if (!activeTargetCalendarId.value) {
        const preferred = pickDefaultTargetCalendar();
        if (preferred) {
          activeTargetCalendarId.value = preferred.id;
        }
      }
    }

    startReminderWatcher(() => visibleEvents.value);
    setupAutoRefreshTimer();
    void syncWithServer(true);
  }

  function resetState() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
    for (const timer of colorSyncTimers.values()) {
      clearTimeout(timer);
    }
    colorSyncTimers.clear();
    session.value = null;
    suiteStorage.removeItem(NAME_OVERRIDE_KEY);
    suiteStorage.removeItem(COLOR_OVERRIDE_KEY);
    clearClipboard();
    selectedEventIds.value = [];
    clearUndoStack();
    calendars.value = [];
    events.value = [];
    shares.value = [];
    userSharesRequestSeq += 1;
    userShares.value = [];
    syncQueue.value = [];
    dismissedSharedCount.value = 0;
    birthdayCalendarSyncEnabled.value = false;
    birthdayCalendarUrl.value = null;
    isSyncingBirthdaysToMailcow.value = false;
    publicShareError.value = '';
    closeContextMenu();
  }

  async function loadPublicSharedCalendar(token: string) {
    isSyncing.value = true;
    publicShareError.value = '';
    try {
      const res = await apiFetchPublicShare(token);
      session.value = {
        mode: 'PUBLIC_SHARE',
        serverUrl: '',
        username: res.owner,
        shareToken: token,
        shareLabel: res.label,
        connectedAt: new Date().toISOString()
      };
      calendars.value = res.calendars.map((c) => ({
        ...c,
        readOnly: true,
        isShared: true,
        visible: true
      }));
      events.value = res.events;
      lastSyncedAt.value = res.syncedAt;
    } catch (err: any) {
      publicShareError.value = err?.message || 'Kunne ikke indlæse den delte kalender.';
    } finally {
      isSyncing.value = false;
    }
  }

  function applyColorOverridesToCalendars(
    cals: CalendarSource[],
    authoritativeOverrides?: Record<string, string>
  ) {
    const overrides =
      authoritativeOverrides !== undefined ? { ...authoritativeOverrides } : getColorOverrides();
    if (authoritativeOverrides !== undefined) {
      saveColorOverrides(overrides);
    }
    for (const cal of cals) {
      const baseColor = cal.serverColor || cal.color;
      cal.serverColor = baseColor;
      const override =
        (authoritativeOverrides !== undefined && cal.localColorOverride
          ? cal.localColorOverride
          : null) ||
        overrides[cal.id] ||
        overrides[cal.url] ||
        overrides[cal.id.toLowerCase()] ||
        overrides[cal.url.toLowerCase()] ||
        null;
      if (override && /^#[0-9a-f]{6}$/i.test(override.trim())) {
        cal.localColorOverride = override.trim().toLowerCase();
        cal.color = cal.localColorOverride;
      } else {
        cal.localColorOverride = null;
        cal.color = baseColor;
      }
    }
  }

  function applyNameOverridesToCalendars(
    cals: CalendarSource[],
    authoritativeOverrides?: Record<string, string>
  ) {
    const overrides =
      authoritativeOverrides !== undefined ? { ...authoritativeOverrides } : getNameOverrides();
    if (authoritativeOverrides !== undefined) {
      saveNameOverrides(overrides);
    }
    for (const cal of cals) {
      const baseName = cal.serverName || cal.name;
      cal.serverName = baseName;
      const alias =
        (authoritativeOverrides !== undefined && cal.localNameOverride
          ? cal.localNameOverride
          : null) ||
        overrides[cal.id] ||
        overrides[cal.url] ||
        overrides[cal.id.toLowerCase()] ||
        overrides[cal.url.toLowerCase()] ||
        null;
      if (alias && alias.trim()) {
        cal.localNameOverride = alias.trim();
        cal.name = alias.trim();
      } else {
        cal.localNameOverride = null;
        cal.name = baseName;
      }
    }
  }

  async function syncWithServer(silent = false) {
    if (!session.value) return;

    if (session.value.mode === 'PUBLIC_SHARE' && session.value.shareToken) {
      await loadPublicSharedCalendar(session.value.shareToken);
      if (!silent && !publicShareError.value) {
        notify('Delt kalender opdateret', 'Hentede nyeste begivenheder.', 'success');
      }
      return;
    }

    if (!isOnline.value) {
      if (!silent) {
        notify('Ingen internetforbindelse', 'Synkronisering venter til du er online igen.', 'warning');
      }
      return;
    }

    isSyncing.value = true;
    try {
      await flushSyncQueue();
      const res = await apiSyncCalDav(undefined, loadLocalSubscriptions(), !silent);

      const visibilityMap = new Map(calendars.value.map((c) => [c.id, c.visible]));
      const hiddenSet = new Set(hiddenCalendarIds.value);
      const serverCalIds = new Set(res.calendars.map((c) => c.id));
      const localSubCalendars = calendars.value
        .filter(
          (c) =>
            (c.isSubscribed || c.id.startsWith('sub::')) &&
            !serverCalIds.has(c.id) &&
            !hiddenSet.has(c.id)
        )
        .map((c) => clonePlain(c));

      const mergedCalendars: CalendarSource[] = clonePlain([
        ...res.calendars
          .filter((c) => !hiddenSet.has(c.id))
          .map((c) => ({
            ...c,
            visible: visibilityMap.has(c.id) ? Boolean(visibilityMap.get(c.id)) : true
          })),
        ...localSubCalendars
      ]);
      applyColorOverridesToCalendars(mergedCalendars, res.colorOverrides || {});
      applyNameOverridesToCalendars(mergedCalendars, res.nameOverrides || {});
      dismissedSharedCount.value = Number(res.dismissedSharedCount || 0);
      const localSubCalIds = new Set(localSubCalendars.map((c) => c.id));
      const preservedSubEvents = events.value
        .filter((e) => localSubCalIds.has(e.calendarId))
        .map((e) => clonePlain(e));
      const serverEvents = [
        ...res.events.filter((e) => !hiddenSet.has(e.calendarId)),
        ...preservedSubEvents
      ];

      const pendingQueue = await db.syncQueue.toArray();
      const pendingIds = new Set(
        pendingQueue.filter((q) => q.action !== 'DELETE').map((q) => q.eventId)
      );
      const deletedIds = new Set(
        pendingQueue.filter((q) => q.action === 'DELETE').map((q) => q.eventId)
      );
      const serverIds = new Set(serverEvents.map((e) => e.id));
      const localPending = events.value
        .filter((e) => pendingIds.has(e.id) && !serverIds.has(e.id))
        .map((e) => clonePlain(e));
      const plainEvents = [
        ...serverEvents
          .filter((e) => !deletedIds.has(e.id))
          .map((e) =>
            pendingIds.has(e.id) ? clonePlain(events.value.find((l) => l.id === e.id) || e) : e
          ),
        ...localPending
      ];

      await db.transaction('rw', db.calendars, db.events, async () => {
        await db.calendars.clear();
        await db.events.clear();
        await db.calendars.bulkPut(mergedCalendars);
        await db.events.bulkPut(plainEvents);
      });

      calendars.value = mergedCalendars;
      events.value = plainEvents;
      lastSyncedAt.value = res.syncedAt;
      if (res.birthdayCalendarSync) {
        birthdayCalendarSyncEnabled.value = Boolean(res.birthdayCalendarSync.enabled);
        birthdayCalendarUrl.value = res.birthdayCalendarSync.calendarUrl || null;
      } else {
        const foundSyncedCal = mergedCalendars.find((c) => c.isContactBirthdays);
        birthdayCalendarSyncEnabled.value = Boolean(foundSyncedCal);
        birthdayCalendarUrl.value = foundSyncedCal?.url || null;
      }

      if (!writableCalendars.value.some((c) => c.id === activeTargetCalendarId.value)) {
        const preferred = pickDefaultTargetCalendar();
        if (preferred) {
          activeTargetCalendarId.value = preferred.id;
        }
      }

      void loadUserShares();

      if (!silent) {
        notify('Kalendere synkroniseret', `Hentede ${plainEvents.length} begivenheder fra serveren.`, 'success');
      }
    } catch (err: any) {
      if (!silent) {
        notify('Synkroniseringsfejl', err?.message || 'Kunne ikke kontakte CalDAV-serveren.', 'error');
      }
    } finally {
      isSyncing.value = false;
    }
  }

  function openImportExportModal(calendarId?: string) {
    if (isPublicShareMode.value) return;
    preselectedImportExportCalendarId.value =
      calendarId || activeTargetCalendarId.value || writableCalendars.value[0]?.id || '';
    isImportExportModalOpen.value = true;
  }

  async function importIcsFile(calendarId: string, icsContent: string): Promise<number> {
    if (!session.value || session.value.mode !== 'CALDAV') return 0;
    if (isCalendarReadOnly(calendarId)) {
      notify('Skrivebeskyttet kalender', 'Vælg en skrivbar kalender til import.', 'error');
      return 0;
    }

    const res = await apiImportIcs(calendarId, icsContent);
    const plainImported = clonePlain(res.events);
    for (const ev of plainImported) {
      const idx = events.value.findIndex((e) => e.id === ev.id);
      if (idx !== -1) {
        events.value[idx] = ev;
      } else {
        events.value.push(ev);
      }
    }
    await db.events.bulkPut(plainImported);
    notify(
      'Import gennemført!',
      `Importerede ${res.importedCount} begivenhed(er) til kalenderen.`,
      'success'
    );
    return res.importedCount;
  }

  async function exportCalendarIcs(calendarIdOrAll: string): Promise<void> {
    const isAll = calendarIdOrAll === 'ALL';
    const targetEvents = isAll
      ? clonePlain(visibleEvents.value)
      : clonePlain(events.value.filter((e) => e.calendarId === calendarIdOrAll));
    const calName = isAll
      ? 'Alle-Kalendere'
      : getCalendarById(calendarIdOrAll)?.name || 'Kalender';

    if (targetEvents.length === 0) {
      notify(
        'Ingen begivenheder',
        'Den valgte kalender indeholder ingen begivenheder at eksportere.',
        'warning'
      );
      return;
    }

    const icsContent = await apiExportIcs(targetEvents, calName);
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeFile = calName.replace(/[^a-zA-Z0-9æøåÆØÅ_-]+/g, '_');
    const datePart = toDateOnlyString(new Date());
    a.href = url;
    a.download = `${safeFile}-${datePart}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    notify(
      'Kalender eksporteret (.ics)',
      `Downloadede ${targetEvents.length} begivenhed(er) fra "${calName}".`,
      'success'
    );
  }

  function openShareModal(calendarId?: string) {
    if (isPublicShareMode.value) return;
    preselectedShareCalendarId.value = calendarId || '';
    isShareModalOpen.value = true;
    void loadShares();
    void loadUserShares();
  }

  async function loadShares() {
    if (session.value?.mode !== 'CALDAV') return;
    try {
      shares.value = await apiListShares();
    } catch (err) {
      console.warn('Kunne ikke hente delingslinks:', err);
    }
  }

  async function loadUserShares() {
    if (session.value?.mode !== 'CALDAV') return;
    const seq = ++userSharesRequestSeq;
    isLoadingUserShares.value = true;
    try {
      const fetched = await apiListUserShares();
      if (seq !== userSharesRequestSeq) return;
      userShares.value = fetched;
    } catch (err) {
      console.warn('Kunne ikke hente bruger-delinger:', err);
    } finally {
      if (seq === userSharesRequestSeq) {
        isLoadingUserShares.value = false;
      }
    }
  }

  function canonicalCalendarUrlKey(rawUrl: string): string {
    const trimmed = (rawUrl || '').trim();
    if (!trimmed) return '';
    const withSlash = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
    try {
      const u = new URL(withSlash);
      const decodedPath = u.pathname
        .split('/')
        .map((seg) => {
          try {
            return decodeURIComponent(seg);
          } catch {
            return seg;
          }
        })
        .join('/');
      return `${u.origin.toLowerCase()}${decodedPath.toLowerCase()}`;
    } catch {
      return withSlash.toLowerCase();
    }
  }

  function sogoCalendarSignature(rawUrl: string, ownerHint?: string): string | null {
    let decoded = '';
    try {
      decoded = decodeURIComponent(rawUrl || '');
    } catch {
      decoded = rawUrl || '';
    }
    const calMatch = decoded.match(/\/SOGo\/dav\/([^/]+)\/Calendar\/([^/]+)\/?$/i);
    if (!calMatch || !calMatch[1] || !calMatch[2]) return null;

    const folderSlug = calMatch[2].trim();
    const unescapeSogoCss = (part: string): string =>
      part
        .replace(/^_(\d)/, '$1')
        .replace(/_D_/gi, '.')
        .replace(/_U_/gi, '_')
        .replace(/_P_/gi, '+');

    const sogoEncodedMatch = folderSlug.match(
      /^([a-z0-9._+-]+)_A_([a-z0-9-]+(?:_D_[a-z0-9-]+)+)_(.+)$/i
    );
    if (sogoEncodedMatch) {
      const slugOwner = `${unescapeSogoCss(sogoEncodedMatch[1])}@${unescapeSogoCss(sogoEncodedMatch[2])}`
        .toLowerCase()
        .trim();
      const slug = sogoEncodedMatch[3].toLowerCase().trim();
      return `sogo-cal::${slugOwner}::${slug}`;
    }

    const directAtMatch = folderSlug.match(/^([^\s/@]+@[^\s/@]+)_(.+)$/i);
    if (directAtMatch) {
      return `sogo-cal::${directAtMatch[1].toLowerCase().trim()}::${directAtMatch[2].toLowerCase().trim()}`;
    }

    const effOwner = (ownerHint || calMatch[1]).toLowerCase().trim();
    return `sogo-cal::${effOwner}::${folderSlug.toLowerCase()}`;
  }

  function getOutgoingSharesForCalendar(cal: CalendarSource): UserCalendarShare[] {
    const key = canonicalCalendarUrlKey(cal.url);
    if (!key) return [];
    return userShares.value.filter((s) => canonicalCalendarUrlKey(s.calendarUrl) === key);
  }

  function isSharedCalendarAlreadyAdded(candidate: { url: string; owner?: string }): boolean {
    const targetKey = canonicalCalendarUrlKey(candidate.url);
    const targetSig = sogoCalendarSignature(candidate.url, candidate.owner);
    return calendars.value.some((c) => {
      if (targetKey && canonicalCalendarUrlKey(c.url) === targetKey) return true;
      if (targetSig) {
        const cSig = sogoCalendarSignature(c.url, c.owner);
        if (cSig && cSig === targetSig) return true;
      }
      return false;
    });
  }

  async function searchSharedCalendars(
    query: string,
    candidateEmails?: string[]
  ): Promise<SharedCalendarSearchResult[]> {
    if (session.value?.mode !== 'CALDAV') return [];
    return apiSearchSharedCalendars(query, candidateEmails);
  }

  async function subscribeSharedCalendar(
    item: SharedCalendarSearchResult
  ): Promise<CalendarSource | null> {
    if (isPublicShareMode.value || session.value?.mode !== 'CALDAV') return null;
    if (!isOnline.value) {
      notify('Offline', 'Du skal være online for at tilføje en delt kalender.', 'warning');
      return null;
    }

    try {
      const res = await apiSubscribeSharedCalendar({
        calendarUrl: item.url,
        owner: item.owner,
        name: item.name,
        color: item.color
      });

      if (hiddenCalendarIds.value.includes(res.calendar.id)) {
        hiddenCalendarIds.value = hiddenCalendarIds.value.filter((id) => id !== res.calendar.id);
        persistHiddenCalendars();
      }

      const newCal: CalendarSource = clonePlain({ ...res.calendar, visible: true });
      applyColorOverridesToCalendars([newCal]);
      applyNameOverridesToCalendars([newCal]);

      const newCalKey = canonicalCalendarUrlKey(newCal.url);
      const existingIdx = calendars.value.findIndex(
        (c) => c.id === newCal.id || (newCalKey && canonicalCalendarUrlKey(c.url) === newCalKey)
      );
      if (existingIdx !== -1) {
        calendars.value[existingIdx] = newCal;
      } else {
        calendars.value.push(newCal);
      }

      const importedEvents = clonePlain(res.events || []);
      const otherEvents = events.value.filter((e) => e.calendarId !== newCal.id);
      events.value = [...otherEvents, ...importedEvents];

      await db.transaction('rw', db.calendars, db.events, async () => {
        await db.calendars.put(clonePlain(newCal));
        const oldIds = await db.events.where('calendarId').equals(newCal.id).primaryKeys();
        if (oldIds.length > 0) {
          await db.events.bulkDelete(oldIds);
        }
        if (importedEvents.length > 0) {
          await db.events.bulkPut(importedEvents);
        }
      });

      if (dismissedSharedCount.value > 0) {
        dismissedSharedCount.value = Math.max(0, dismissedSharedCount.value - 1);
      }

      notify(
        'Delt kalender tilføjet!',
        `"${newCal.name}" er nu tilføjet (${newCal.readOnly ? 'Kun læsning' : 'Læs & Skriv'}).`,
        'success'
      );
      return newCal;
    } catch (err: any) {
      notify('Kunne ikke tilføje delt kalender', err?.message || String(err), 'error', 7000);
      return null;
    }
  }

  async function shareCalendarWithUser(params: {
    calendarId: string;
    recipientEmail: string;
    permission: CalendarSharePermission;
  }): Promise<UserCalendarShare | null> {
    if (session.value?.mode !== 'CALDAV') return null;
    const cal = getCalendarById(params.calendarId);
    if (!cal || cal.isShared || cal.isSubscribed || cal.id.startsWith('sub::')) {
      notify('Ugyldig kalender', 'Vælg en af dine egne kalendere for at dele med en bruger.', 'warning');
      return null;
    }

    try {
      const saved = await apiUpsertUserShare({
        calendarUrl: cal.url,
        calendarName: cal.name,
        calendarColor: cal.color,
        recipientEmail: params.recipientEmail.trim(),
        permission: params.permission
      });
      userSharesRequestSeq += 1;
      isLoadingUserShares.value = false;
      const savedKey = canonicalCalendarUrlKey(saved.calendarUrl);
      const savedRecipLower = saved.recipientEmail.toLowerCase().trim();
      const idx = userShares.value.findIndex(
        (s) =>
          s.id === saved.id ||
          (canonicalCalendarUrlKey(s.calendarUrl) === savedKey &&
            s.recipientEmail.toLowerCase().trim() === savedRecipLower)
      );
      if (idx >= 0) {
        userShares.value[idx] = saved;
      } else {
        userShares.value.unshift(saved);
      }
      notify(
        saved.source === 'sogo' ? 'Kalender delt direkte i SOGo!' : 'Kalender delt!',
        saved.source === 'sogo'
          ? `"${cal.name}" er nu delt i Mailcow/SOGo med ${saved.recipientEmail} (${saved.permission === 'write' ? 'Læs & Skriv' : 'Kun læsning'}).`
          : `"${cal.name}" er nu delt med ${saved.recipientEmail} (${saved.permission === 'write' ? 'Læs & Skriv' : 'Kun læsning'}).`,
        'success'
      );
      return saved;
    } catch (err: any) {
      notify('Kunne ikke dele kalenderen', err?.message || String(err), 'error');
      return null;
    }
  }

  async function updateUserSharePermission(
    shareId: string,
    permission: CalendarSharePermission
  ): Promise<boolean> {
    if (session.value?.mode !== 'CALDAV') return false;
    try {
      const existing = userShares.value.find((s) => s.id === shareId);
      const updated = await apiUpdateUserSharePermission(
        shareId,
        permission,
        existing
          ? { calendarName: existing.calendarName, calendarColor: existing.calendarColor }
          : undefined
      );
      userSharesRequestSeq += 1;
      isLoadingUserShares.value = false;
      const idx = userShares.value.findIndex((s) => s.id === shareId);
      if (idx >= 0) {
        userShares.value[idx] = { ...userShares.value[idx], ...updated };
      }
      notify(
        updated.source === 'sogo' ? 'Rettighed opdateret i SOGo' : 'Rettighed opdateret',
        `${updated.recipientEmail} har nu adgang: ${updated.permission === 'write' ? 'Læs & Skriv' : 'Kun læsning'}.`,
        'success'
      );
      return true;
    } catch (err: any) {
      notify('Kunne ikke ændre rettighed', err?.message || String(err), 'error');
      return false;
    }
  }

  async function revokeUserShare(shareId: string) {
    if (session.value?.mode !== 'CALDAV') return;
    try {
      await apiDeleteUserShare(shareId);
      userSharesRequestSeq += 1;
      isLoadingUserShares.value = false;
      userShares.value = userShares.value.filter((s) => s.id !== shareId);
      notify(
        shareId.startsWith('sogo::') ? 'Adgang tilbagekaldt i SOGo' : 'Adgang tilbagekaldt',
        'Brugeren har ikke længere adgang til denne delte kalender.',
        'info'
      );
    } catch (err: any) {
      notify('Fejl ved tilbagekaldelse', err?.message || String(err), 'error');
    }
  }

  async function createShare(params: {
    label: string;
    calendarIds: string[];
    hideDetails: boolean;
  }): Promise<PublicShareLink | null> {
    if (session.value?.mode !== 'CALDAV') return null;
    const selectedCals = calendars.value.filter((c) => params.calendarIds.includes(c.id));
    if (selectedCals.length === 0) {
      notify('Vælg kalender', 'Vælg mindst én kalender, som skal deles.', 'warning');
      return null;
    }

    try {
      const created = await apiCreateShare({
        label: params.label,
        calendarUrls: selectedCals.map((c) => c.url),
        calendarNames: selectedCals.map((c) => c.name),
        hideDetails: params.hideDetails
      });
      shares.value.unshift(created);
      notify(
        'Delingslink oprettet',
        'Du kan nu kopiere linket og sende det til 3. part.',
        'success'
      );
      return created;
    } catch (err: any) {
      notify('Kunne ikke oprette delingslink', err?.message || String(err), 'error');
      return null;
    }
  }

  async function revokeShare(token: string) {
    if (session.value?.mode !== 'CALDAV') return;
    try {
      await apiDeleteShare(token);
      shares.value = shares.value.filter((s) => s.token !== token);
      notify(
        'Delingslink slettet',
        'Linket er nu deaktiveret og kan ikke længere tilgås.',
        'info'
      );
    } catch (err: any) {
      notify('Fejl ved sletning af link', err?.message || String(err), 'error');
    }
  }

  async function enqueueSync(item: Omit<SyncQueueItem, 'id' | 'createdAt'>) {
    if (session.value?.mode !== 'CALDAV') return;

    const entry: SyncQueueItem = clonePlain({
      ...item,
      createdAt: new Date().toISOString()
    });
    const id = await db.syncQueue.add(entry);
    syncQueue.value.push({ ...entry, id });

    if (isOnline.value) {
      void flushSyncQueue();
    }
  }

  async function flushSyncQueue() {
    if (!isOnline.value || session.value?.mode !== 'CALDAV') return;
    if (isFlushing) {
      flushRequested = true;
      return;
    }
    isFlushing = true;

    try {
      const queue = await db.syncQueue.orderBy('id').toArray();

      for (const item of queue) {
        try {
          if (item.action === 'UPSERT' && item.payload.event) {
            const latestLocal = events.value.find((e) => e.id === item.eventId);
            const payloadEvent = clonePlain({
              ...item.payload.event,
              caldavUrl: latestLocal?.caldavUrl || item.payload.event.caldavUrl,
              etag: latestLocal?.etag || item.payload.event.etag
            });
            const saved = clonePlain(await apiSaveEvent(payloadEvent));
            const savedPlain = { ...saved, pendingSync: false };
            await db.events.put(savedPlain);
            const idx = events.value.findIndex((e) => e.id === item.eventId || e.id === saved.id);
            if (idx !== -1) {
              events.value[idx] = savedPlain;
            }
          } else if (item.action === 'DELETE' && item.payload.caldavUrl) {
            await apiDeleteEvent(item.payload.caldavUrl, item.payload.etag);
          } else if (item.action === 'RSVP' && item.payload.event && item.payload.partstat) {
            const updated = clonePlain(
              await apiUpdateRsvp(item.payload.event, item.payload.partstat)
            );
            await db.events.put({ ...updated, pendingSync: false });
            const idx = events.value.findIndex((e) => e.id === updated.id);
            if (idx !== -1) {
              events.value[idx] = { ...updated, pendingSync: false };
            }
          }

          if (item.id !== undefined) {
            await db.syncQueue.delete(item.id);
          }
        } catch (err: any) {
          console.warn('Synkronisering af ændring fejlede:', err);
          const msg = String(err?.message || err);
          const isNetworkError =
            err instanceof TypeError || /Failed to fetch|NetworkError/i.test(msg);
          if (isNetworkError) {
            notify(
              'Ændring venter på forbindelse',
              'Gemmes lokalt og sendes til Mailcow, når serveren kan nås.',
              'warning'
            );
            break;
          }
          notify('Mailcow afviste ændringen', msg, 'error', 9000);
          if (item.id !== undefined) {
            await db.syncQueue.delete(item.id);
          }
        }
      }

      syncQueue.value = await db.syncQueue.toArray();
    } finally {
      isFlushing = false;
      if (flushRequested) {
        flushRequested = false;
        void flushSyncQueue();
      }
    }
  }

  async function toggleCalendarVisibility(calId: string) {
    if (calId === BIRTHDAY_CALENDAR_ID) {
      toggleContactBirthdays();
      return;
    }
    const cal = getCalendarById(calId);
    if (!cal) return;
    cal.visible = !cal.visible;
    if (!isPublicShareMode.value) {
      await db.calendars.put(clonePlain(cal));
    }
  }

  async function setCalendarColorOverride(calId: string, newColor: string | null) {
    if (calId === BIRTHDAY_CALENDAR_ID) {
      await contactsStore.setContactCalendarColor(newColor);
      return;
    }
    const cal = getCalendarById(calId);
    if (!cal) return;

    const clean =
      typeof newColor === 'string' && /^#[0-9a-f]{6}$/i.test(newColor.trim())
        ? newColor.trim().toLowerCase()
        : null;

    const overrides = getColorOverrides();
    if (clean) {
      overrides[calId] = clean;
      cal.localColorOverride = clean;
      cal.color = clean;
    } else {
      delete overrides[calId];
      cal.localColorOverride = null;
      cal.color = cal.serverColor;
    }
    saveColorOverrides(overrides);

    if (!isPublicShareMode.value) {
      await db.calendars.put(clonePlain(cal)).catch(() => {});
    }

    const existingTimer = colorSyncTimers.get(calId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      colorSyncTimers.delete(calId);
    }

    if (isPublicShareMode.value || !isOnline.value || session.value?.mode !== 'CALDAV') {
      return;
    }

    const pushColorToServer = async () => {
      try {
        const res = await apiSetCalendarColor({
          calendarId: cal.id,
          calendarUrl: cal.url,
          color: clean
        });
        const target = getCalendarById(calId);
        if (!target) return;

        const nextOverrides = getColorOverrides();
        if (clean && res.syncedToServer) {
          target.serverColor = clean;
          target.color = clean;
          target.localColorOverride = null;
          delete nextOverrides[calId];
          delete nextOverrides[target.url];
          if (target.isContactBirthdays) {
            await contactsStore.setContactCalendarColor(clean);
          }
        } else if (clean) {
          const eff = res.localColorOverride || clean;
          target.localColorOverride = eff;
          target.color = eff;
          nextOverrides[calId] = eff;
        } else {
          target.localColorOverride = null;
          target.color = target.serverColor;
          delete nextOverrides[calId];
          delete nextOverrides[target.url];
        }
        saveColorOverrides(nextOverrides);
        await db.calendars.put(clonePlain(target)).catch(() => {});
      } catch (err: any) {
        notify(
          'Kunne ikke synke farve til server',
          err?.message || 'Farven blev gemt lokalt.',
          'warning'
        );
      }
    };

    if (clean === null) {
      await pushColorToServer();
    } else {
      const timer = setTimeout(() => {
        colorSyncTimers.delete(calId);
        void pushColorToServer();
      }, 350);
      colorSyncTimers.set(calId, timer);
    }
  }

  async function setCalendarNameOverride(
    calId: string,
    newName: string | null,
    renameOnServer = false
  ): Promise<boolean> {
    if (isPublicShareMode.value || calId === BIRTHDAY_CALENDAR_ID) return false;
    const cal = getCalendarById(calId);
    if (!cal) return false;

    cal.serverName = cal.serverName || cal.name;
    const trimmed = typeof newName === 'string' ? newName.trim().slice(0, 80) : '';
    const isOwnCalDav = !cal.isShared && !cal.isSubscribed && !cal.id.startsWith('sub::');
    const wantServerRename = Boolean(renameOnServer && trimmed && isOwnCalDav);
    const overrides = getNameOverrides();

    if (isOnline.value && session.value?.mode === 'CALDAV') {
      let res: {
        renamedOnServer: boolean;
        effectiveName: string | null;
        localNameOverride: string | null;
        fallbackReason?: string;
      };
      try {
        res = await apiSetCalendarName({
          calendarId: cal.id,
          calendarUrl: cal.url,
          name: trimmed || null,
          renameOnServer: wantServerRename
        });
      } catch (err: any) {
        notify('Kunne ikke omdøbe kalender', err?.message || String(err), 'error');
        return false;
      }

      if (res.renamedOnServer && trimmed) {
        delete overrides[cal.id];
        delete overrides[cal.url];
        delete overrides[cal.id.toLowerCase()];
        delete overrides[cal.url.toLowerCase()];
        cal.serverName = trimmed;
        cal.name = trimmed;
        cal.localNameOverride = null;
        notify(
          'Kalender omdøbt',
          `"${trimmed}" er nu gemt både i Sharedrive og på Mailcow/SOGo.`,
          'success'
        );
      } else if (trimmed) {
        overrides[cal.id] = trimmed;
        cal.localNameOverride = trimmed;
        cal.name = trimmed;
        if (wantServerRename && res.fallbackReason) {
          notify(
            'Alias-navn gemt',
            `Serveren tillod ikke direkte omdøbning, så "${trimmed}" er gemt som dit alias-navn på alle enheder.`,
            'info'
          );
        } else {
          notify(
            'Alias-navn gemt',
            `Kalenderen vises nu som "${trimmed}" på alle dine enheder.`,
            'success'
          );
        }
      } else {
        delete overrides[cal.id];
        delete overrides[cal.url];
        delete overrides[cal.id.toLowerCase()];
        delete overrides[cal.url.toLowerCase()];
        cal.localNameOverride = null;
        cal.name = cal.serverName;
        notify('Originalt navn gendannet', `Kalenderen vises nu igen som "${cal.name}".`, 'info');
      }
    } else {
      if (trimmed) {
        overrides[cal.id] = trimmed;
        cal.localNameOverride = trimmed;
        cal.name = trimmed;
      } else {
        delete overrides[cal.id];
        delete overrides[cal.url];
        delete overrides[cal.id.toLowerCase()];
        delete overrides[cal.url.toLowerCase()];
        cal.localNameOverride = null;
        cal.name = cal.serverName;
      }
      notify('Navn gemt lokalt', 'Ændringen gemmes lokalt, da du er offline.', 'warning');
    }

    saveNameOverrides(overrides);
    await db.calendars.put(clonePlain(cal));
    return true;
  }

  const UNDO_TTL_MS = 30_000;
  const undoTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearUndoTimer(id: string) {
    const timer = undoTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      undoTimers.delete(id);
    }
  }

  function clearUndoStack() {
    undoTimers.forEach((timer) => clearTimeout(timer));
    undoTimers.clear();
    undoStack.value = [];
  }

  function pushUndo(label: string, undoFn: () => Promise<void>) {
    const id = generateId();
    undoStack.value.push({
      id,
      label,
      timestamp: new Date().toISOString(),
      undo: undoFn
    });

    const timer = setTimeout(() => {
      undoTimers.delete(id);
      undoStack.value = undoStack.value.filter((item) => item.id !== id);
    }, UNDO_TTL_MS);
    undoTimers.set(id, timer);

    if (undoStack.value.length > 50) {
      const removed = undoStack.value.shift();
      if (removed) {
        clearUndoTimer(removed.id);
      }
    }
  }

  async function triggerUndo() {
    if (isPublicShareMode.value) return;
    const last = undoStack.value.pop();
    if (!last) {
      notify('Intet at fortryde', 'Fortryd-historikken er tom.', 'info');
      return;
    }
    clearUndoTimer(last.id);
    await last.undo();
    notify('Handling fortrudt (Ctrl+Z)', last.label, 'success');
  }

  async function saveEvent(
    eventInput: Partial<CalendarEvent> & {
      title: string;
      start: string;
      end: string;
      calendarId: string;
    },
    recordUndo = true
  ): Promise<CalendarEvent | null> {
    if (isPublicShareMode.value || isCalendarReadOnly(eventInput.calendarId)) {
      notify(
        'Skrivebeskyttet kalender (Read-Only)',
        'Du kan ikke oprette eller redigere begivenheder i en skrivebeskyttet kalender.',
        'error'
      );
      return null;
    }

    const existing = eventInput.id ? events.value.find((e) => e.id === eventInput.id) : undefined;
    const previousSnapshot = existing ? clonePlain(existing) : null;

    const uid = eventInput.uid || existing?.uid || generateId();
    const id = `${eventInput.calendarId}::${uid}`;

    const fullEvent: CalendarEvent = clonePlain({
      id,
      uid,
      calendarId: eventInput.calendarId,
      title: eventInput.title.trim() || '(Ingen titel)',
      start: eventInput.start,
      end: eventInput.end,
      allDay: Boolean(eventInput.allDay),
      description: eventInput.description ?? existing?.description ?? '',
      location: eventInput.location ?? existing?.location ?? '',
      videoUrl: eventInput.videoUrl ?? existing?.videoUrl ?? '',
      timezone: eventInput.timezone || existing?.timezone || 'Europe/Copenhagen',
      attendees: eventInput.attendees ?? existing?.attendees ?? [],
      organizer: eventInput.organizer ?? existing?.organizer,
      reminderMinutes:
        eventInput.reminderMinutes !== undefined
          ? eventInput.reminderMinutes
          : (existing?.reminderMinutes ?? null),
      etag: eventInput.etag !== undefined ? eventInput.etag : existing?.etag,
      caldavUrl: eventInput.caldavUrl !== undefined ? eventInput.caldavUrl : existing?.caldavUrl,
      rawIcs: eventInput.rawIcs !== undefined ? eventInput.rawIcs : existing?.rawIcs,
      updatedAt: new Date().toISOString(),
      pendingSync: session.value?.mode === 'CALDAV'
    });

    if (existing && existing.id !== fullEvent.id) {
      events.value = events.value.filter((e) => e.id !== existing.id);
      await db.events.delete(existing.id);
    }

    const idx = events.value.findIndex((e) => e.id === fullEvent.id);
    if (idx !== -1) {
      events.value[idx] = fullEvent;
    } else {
      events.value.push(fullEvent);
    }
    await db.events.put(clonePlain(fullEvent));

    await enqueueSync({
      action: 'UPSERT',
      eventId: fullEvent.id,
      payload: { event: clonePlain(fullEvent) }
    });

    if (recordUndo) {
      if (previousSnapshot) {
        pushUndo(`Redigerede "${fullEvent.title}"`, async () => {
          await saveEvent(previousSnapshot, false);
        });
      } else {
        pushUndo(`Oprettede "${fullEvent.title}"`, async () => {
          await deleteEventsByIds([fullEvent.id], false);
        });
      }
    }

    return fullEvent;
  }

  async function deleteEventsByIds(ids: string[], recordUndo = true) {
    if (isPublicShareMode.value) return;
    const toDelete = events.value.filter((e) => ids.includes(e.id));
    if (toDelete.length === 0) return;

    const blockedReadOnly = toDelete.filter((e) => isCalendarReadOnly(e.calendarId));
    if (blockedReadOnly.length > 0) {
      notify(
        'Skrivebeskyttet kalender (Read-Only)',
        `Kan ikke slette "${blockedReadOnly[0].title}", da kalenderen er skrivebeskyttet.`,
        'error'
      );
      return;
    }

    const snapshots = toDelete.map((e) => clonePlain(e));
    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const newTrashEntries: TrashItem[] = snapshots.map((ev) => ({
      id: ev.id,
      event: clonePlain(ev),
      deletedAt: now.toISOString(),
      expiresAt: expires.toISOString()
    }));

    const idSet = new Set(snapshots.map((e) => e.id));
    events.value = events.value.filter((e) => !idSet.has(e.id));
    selectedEventIds.value = selectedEventIds.value.filter((id) => !idSet.has(id));

    await db.transaction('rw', db.events, db.trash, async () => {
      await db.events.bulkDelete([...idSet]);
      await db.trash.bulkPut(newTrashEntries);
    });

    trashItems.value = await db.trash.orderBy('deletedAt').reverse().toArray();

    for (const ev of snapshots) {
      if (ev.caldavUrl) {
        await enqueueSync({
          action: 'DELETE',
          eventId: ev.id,
          payload: { caldavUrl: ev.caldavUrl, etag: ev.etag }
        });
      }
    }

    if (recordUndo) {
      const label =
        snapshots.length === 1
          ? `Slettede "${snapshots[0].title}"`
          : `Slettede ${snapshots.length} begivenheder`;

      pushUndo(label, async () => {
        for (const snap of snapshots) {
          await db.trash.delete(snap.id);
          await saveEvent(snap, false);
        }
        trashItems.value = await db.trash.orderBy('deletedAt').reverse().toArray();
      });

      notify(
        label,
        'Flyttet til den lokale 30-dages papirkurv (Tryk Ctrl+Z for at fortryde).',
        'info'
      );
    }
  }

  async function bulkDeleteEvents(ids: string[], moveToTrash = false): Promise<number> {
    if (isPublicShareMode.value || ids.length === 0) return 0;
    const targetIdSet = new Set(ids);
    const toDelete = events.value.filter(
      (e) => targetIdSet.has(e.id) && !isCalendarReadOnly(e.calendarId)
    );
    if (toDelete.length === 0) return 0;

    const snapshots = toDelete.map((e) => clonePlain(e));
    const deleteIdSet = new Set(snapshots.map((e) => e.id));

    events.value = events.value.filter((e) => !deleteIdSet.has(e.id));
    selectedEventIds.value = selectedEventIds.value.filter((id) => !deleteIdSet.has(id));

    const now = new Date();
    const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const newTrashEntries: TrashItem[] = moveToTrash
      ? snapshots.map((ev) => ({
          id: ev.id,
          event: clonePlain(ev),
          deletedAt: now.toISOString(),
          expiresAt: expires.toISOString()
        }))
      : [];

    await db.transaction('rw', db.events, db.trash, async () => {
      await db.events.bulkDelete([...deleteIdSet]);
      if (moveToTrash && newTrashEntries.length > 0) {
        await db.trash.bulkPut(newTrashEntries);
      }
    });

    if (moveToTrash) {
      trashItems.value = await db.trash.orderBy('deletedAt').reverse().toArray();
    }

    const remoteItems = snapshots
      .filter((ev) => Boolean(ev.caldavUrl))
      .map((ev) => ({
        id: ev.id,
        caldavUrl: ev.caldavUrl!,
        etag: ev.etag
      }));

    if (remoteItems.length > 0) {
      if (isOnline.value) {
        try {
          await apiBulkDeleteEvents(
            remoteItems.map((item) => ({ caldavUrl: item.caldavUrl, etag: item.etag }))
          );
        } catch {
          for (const item of remoteItems) {
            await enqueueSync({
              action: 'DELETE',
              eventId: item.id,
              payload: { caldavUrl: item.caldavUrl, etag: item.etag }
            });
          }
        }
      } else {
        for (const item of remoteItems) {
          await enqueueSync({
            action: 'DELETE',
            eventId: item.id,
            payload: { caldavUrl: item.caldavUrl, etag: item.etag }
          });
        }
      }
    }

    notify(
      `Slettede ${snapshots.length} gamle begivenheder`,
      moveToTrash
        ? 'Begivenhederne er flyttet til 30-dages papirkurven og fjernet fra serveren.'
        : 'Begivenhederne er slettet permanent fra kalenderen og serveren.',
      'success'
    );

    return snapshots.length;
  }

  async function restoreFromTrash(trashId: string) {
    if (isPublicShareMode.value) return;
    const item = trashItems.value.find((t) => t.id === trashId);
    if (!item) return;

    await db.trash.delete(trashId);
    trashItems.value = trashItems.value.filter((t) => t.id !== trashId);

    const targetCalId =
      getCalendarById(item.event.calendarId) && !isCalendarReadOnly(item.event.calendarId)
        ? item.event.calendarId
        : defaultWritableCalendar.value?.id || item.event.calendarId;

    await saveEvent({ ...clonePlain(item.event), calendarId: targetCalId }, false);
    notify('Begivenhed gendannet', `"${item.event.title}" er tilbage i kalenderen.`, 'success');
  }

  async function permanentlyDeleteFromTrash(trashId: string) {
    await db.trash.delete(trashId);
    trashItems.value = trashItems.value.filter((t) => t.id !== trashId);
  }

  async function emptyTrash() {
    await db.trash.clear();
    trashItems.value = [];
    notify('Papirkurv tømt', 'Alle slettede begivenheder blev fjernet permanent.', 'info');
  }

  function clearClipboard() {
    clipboard.value = {
      mode: null,
      events: [],
      sourceAnchorDate: null,
      copiedAt: null
    };
  }

  function copyOrCutSelection(mode: 'COPY' | 'CUT', explicitEvents?: CalendarEvent[]) {
    if (isPublicShareMode.value) return;

    let candidates: CalendarEvent[] = [];

    if (explicitEvents && explicitEvents.length > 0) {
      candidates = explicitEvents;
    } else if (selectedEventIds.value.length > 0) {
      const idSet = new Set(selectedEventIds.value);
      candidates = events.value.filter((e) => idSet.has(e.id));
    } else if (selectedDateStr.value) {
      const dayPrefix = selectedDateStr.value.slice(0, 10);
      candidates = visibleEvents.value.filter(
        (e) => e.calendarId !== BIRTHDAY_CALENDAR_ID && toDateOnlyString(new Date(e.start)) === dayPrefix
      );
    }

    if (candidates.length === 0) {
      notify(
        'Ingen begivenhed valgt',
        'Klik først på en begivenhed (eller en dag med begivenheder), og tryk derefter Ctrl+C.',
        'warning'
      );
      return;
    }

    const blockedMeetings = candidates.filter((e) => hasInvitedAttendees(e));
    const allowed = candidates.filter((e) => !hasInvitedAttendees(e));

    if (blockedMeetings.length > 0 && allowed.length === 0) {
      notify(
        'Kopiering spærret (Mødesikkerhed)',
        `"${blockedMeetings[0].title}" indeholder inviterede mødedeltagere. Ctrl+C er deaktiveret på møder med gæster.`,
        'error'
      );
      return;
    }

    const finalEvents =
      mode === 'CUT'
        ? allowed.filter((e) => !isCalendarReadOnly(e.calendarId))
        : allowed;

    if (mode === 'CUT' && finalEvents.length === 0) {
      notify(
        'Klip spærret (Read-Only)',
        'Du kan ikke klippe begivenheder ud fra en skrivebeskyttet kalender.',
        'error'
      );
      return;
    }

    const sorted = [...finalEvents].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );
    const anchorDate = toDateOnlyString(new Date(sorted[0].start));
    const plainCopied = sorted.map((e) => clonePlain(e));

    clipboard.value = {
      mode,
      events: plainCopied,
      sourceAnchorDate: anchorDate,
      copiedAt: new Date().toISOString()
    };

    const skippedNotice =
      blockedMeetings.length > 0
        ? ` (${blockedMeetings.length} møde med deltagere blev sprunget over)`
        : '';

    const titleSummary =
      plainCopied.length === 1
        ? `"${plainCopied[0].title}"`
        : `${plainCopied.length} begivenheder`;

    notify(
      mode === 'COPY' ? `Kopieret: ${titleSummary}` : `Klippet: ${titleSummary}`,
      `Klik på en ny dag i kalenderen og tryk Ctrl+V (eller højreklik -> Indsæt)${skippedNotice}.`,
      'success'
    );
  }

  async function pasteToDate(targetDateInput?: string) {
    if (isPublicShareMode.value) return;
    if (!clipboard.value.events.length || !clipboard.value.sourceAnchorDate) {
      notify(
        'Udklipsholderen er tom',
        'Kopiér først en begivenhed med Ctrl+C eller højreklik.',
        'warning'
      );
      return;
    }

    const targetRaw = targetDateInput || selectedDateStr.value;
    if (!targetRaw) {
      notify(
        'Vælg en dato først',
        'Klik på den dag i kalenderen, hvor du vil indsætte (Ctrl+V).',
        'warning'
      );
      return;
    }

    const targetDateOnly = targetRaw.slice(0, 10);
    const dayDiff = diffDaysBetween(clipboard.value.sourceAnchorDate, targetDateOnly);
    const hasSpecificTargetTime = targetRaw.includes('T') && clipboard.value.events.length === 1;

    const createdIds: string[] = [];
    const cutOriginalSnapshots =
      clipboard.value.mode === 'CUT'
        ? clipboard.value.events.map((e) => clonePlain(e))
        : [];

    for (const srcEvent of clipboard.value.events) {
      let targetCalId = srcEvent.calendarId;
      if (!getCalendarById(targetCalId) || isCalendarReadOnly(targetCalId)) {
        if (!defaultWritableCalendar.value) {
          notify(
            'Ingen skrivbar kalender',
            'Kan ikke indsætte (Ctrl+V), da alle kalendere er Read-Only.',
            'error'
          );
          return;
        }
        targetCalId = defaultWritableCalendar.value.id;
      }

      let newStartIso: string;
      let newEndIso: string;

      if (srcEvent.allDay) {
        const srcStartYmd = toDateOnlyString(new Date(srcEvent.start));
        const srcEndYmd = srcEvent.end
          ? toDateOnlyString(new Date(srcEvent.end))
          : srcStartYmd;
        const shiftedStart = addDaysToDateOnly(srcStartYmd, dayDiff);
        const durationDays = Math.max(1, diffDaysBetween(srcStartYmd, srcEndYmd));
        const shiftedEnd = addDaysToDateOnly(shiftedStart, durationDays);
        newStartIso = shiftedStart;
        newEndIso = shiftedEnd;
      } else if (hasSpecificTargetTime) {
        const durationMs = Math.max(
          15 * 60 * 1000,
          new Date(srcEvent.end).getTime() - new Date(srcEvent.start).getTime()
        );
        const startDt = new Date(targetRaw);
        const endDt = new Date(startDt.getTime() + durationMs);
        newStartIso = startDt.toISOString();
        newEndIso = endDt.toISOString();
      } else {
        const startDt = new Date(srcEvent.start);
        const endDt = new Date(srcEvent.end || srcEvent.start);
        const durationMs = Math.max(15 * 60 * 1000, endDt.getTime() - startDt.getTime());
        startDt.setDate(startDt.getDate() + dayDiff);
        const newEndDt = new Date(startDt.getTime() + durationMs);
        newStartIso = startDt.toISOString();
        newEndIso = newEndDt.toISOString();
      }

      const created = await saveEvent(
        {
          calendarId: targetCalId,
          title: srcEvent.title,
          start: newStartIso,
          end: newEndIso,
          allDay: srcEvent.allDay,
          description: srcEvent.description,
          location: srcEvent.location,
          videoUrl: srcEvent.videoUrl,
          timezone: srcEvent.timezone,
          attendees: [],
          reminderMinutes: srcEvent.reminderMinutes,
          uid: undefined,
          caldavUrl: undefined,
          etag: undefined,
          rawIcs: undefined
        },
        false
      );

      if (created) {
        createdIds.push(created.id);
      }
    }

    if (clipboard.value.mode === 'CUT' && cutOriginalSnapshots.length > 0) {
      await deleteEventsByIds(
        cutOriginalSnapshots.map((e) => e.id),
        false
      );
      clipboard.value.mode = 'COPY';
    }

    if (createdIds.length > 0) {
      selectedEventIds.value = createdIds;

      pushUndo(`Indsatte ${createdIds.length} begivenhed(er) på ${targetDateOnly}`, async () => {
        await deleteEventsByIds(createdIds, false);
        for (const orig of cutOriginalSnapshots) {
          await db.trash.delete(orig.id);
          await saveEvent(orig, false);
        }
        trashItems.value = await db.trash.orderBy('deletedAt').reverse().toArray();
      });

      notify(
        `Indsatte ${createdIds.length} begivenhed(er) (Ctrl+V)`,
        `Placeret på ${targetDateOnly} (Tryk Ctrl+Z for at fortryde).`,
        'success'
      );
    }
  }

  async function respondToInvite(eventId: string, partstat: RsvpStatus) {
    if (isPublicShareMode.value) return;
    const ev = events.value.find((e) => e.id === eventId);
    if (!ev) return;

    const userEmail = (session.value?.username || '').toLowerCase().trim();
    const updatedAttendees = (ev.attendees || []).map((a) =>
      a.email.toLowerCase().trim() === userEmail ? { ...a, partstat } : clonePlain(a)
    );

    if (userEmail && !updatedAttendees.some((a) => a.email.toLowerCase().trim() === userEmail)) {
      updatedAttendees.push({
        email: userEmail,
        name: userEmail.split('@')[0],
        partstat
      });
    }

    const updatedEvent: CalendarEvent = clonePlain({
      ...ev,
      attendees: updatedAttendees,
      updatedAt: new Date().toISOString(),
      pendingSync: session.value?.mode === 'CALDAV'
    });

    const idx = events.value.findIndex((e) => e.id === eventId);
    if (idx !== -1) {
      events.value[idx] = updatedEvent;
    }
    await db.events.put(clonePlain(updatedEvent));

    if (editingEvent.value?.id === eventId) {
      editingEvent.value = clonePlain(updatedEvent);
    }

    await enqueueSync({
      action: 'RSVP',
      eventId: updatedEvent.id,
      payload: { event: clonePlain(updatedEvent), partstat }
    });

    const labelMap: Record<RsvpStatus, string> = {
      ACCEPTED: 'Deltager',
      TENTATIVE: 'Måske',
      DECLINED: 'Afvist',
      'NEEDS-ACTION': 'Afventer svar'
    };

    notify('RSVP opdateret', `Dit svar på "${ev.title}" er sat til: ${labelMap[partstat]}.`, 'success');
  }

  function persistHiddenCalendars() {
    suiteStorage.setItem(HIDDEN_CAL_KEY, JSON.stringify(hiddenCalendarIds.value));
  }

  async function createCalendar(name: string, color: string, calendarUrl?: string) {
    if (isPublicShareMode.value || session.value?.mode !== 'CALDAV') return null;
    const trimmed = name.trim();
    const trimmedUrl = calendarUrl?.trim() || '';
    if (!trimmed && !trimmedUrl) {
      notify(
        'Navn eller URL mangler',
        'Giv kalenderen et navn eller indsæt et CalDAV-link.',
        'warning'
      );
      return null;
    }

    if (!isOnline.value) {
      notify(
        'Offline',
        'Du skal være online for at oprette eller tilføje en kalender på Mailcow.',
        'warning'
      );
      return null;
    }

    let newCal: CalendarSource;
    try {
      const created = await apiCreateCalendar(
        trimmed || 'SOGo Kalender',
        color,
        trimmedUrl || undefined
      );
      newCal = clonePlain({ ...created, visible: true });
    } catch (err: any) {
      notify('Kunne ikke oprette/tilføje kalender', err?.message || String(err), 'error', 9000);
      return null;
    }

    hiddenCalendarIds.value = hiddenCalendarIds.value.filter((id) => id !== newCal.id);
    persistHiddenCalendars();

    const existingIdx = calendars.value.findIndex((c) => c.id === newCal.id);
    if (existingIdx !== -1) {
      calendars.value[existingIdx] = newCal;
    } else {
      calendars.value.push(newCal);
    }
    await db.calendars.put(clonePlain(newCal));
    if (!newCal.readOnly) {
      activeTargetCalendarId.value = newCal.id;
    }
    notify('Kalender tilføjet', `"${newCal.name}" er klar.`, 'success');

    if (trimmedUrl) {
      void syncWithServer(true);
    }
    return newCal;
  }

  function loadLocalSubscriptions(): LocalSubscriptionHint[] {
    try {
      const raw = suiteStorage.getItem(SUBSCRIPTIONS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveLocalSubscription(hint: LocalSubscriptionHint) {
    const list = loadLocalSubscriptions().filter(
      (item) =>
        item.id !== hint.id &&
        item.subscriptionUrl.toLowerCase() !== hint.subscriptionUrl.toLowerCase()
    );
    list.push(hint);
    suiteStorage.setItem(SUBSCRIPTIONS_STORAGE_KEY, JSON.stringify(list));
  }

  function removeLocalSubscription(id: string, url?: string) {
    const list = loadLocalSubscriptions().filter(
      (item) =>
        item.id !== id && (!url || item.subscriptionUrl.toLowerCase() !== url.toLowerCase())
    );
    suiteStorage.setItem(SUBSCRIPTIONS_STORAGE_KEY, JSON.stringify(list));
  }

  function buildClientDanishHolidays(calendarId: string): CalendarEvent[] {
    const currentYear = new Date().getFullYear();
    const result: CalendarEvent[] = [];

    const getEaster = (year: number): Date => {
      const a = year % 19;
      const b = Math.floor(year / 100);
      const c = year % 100;
      const d = Math.floor(b / 4);
      const e = b % 4;
      const f = Math.floor((b + 8) / 25);
      const g = Math.floor((b - f + 1) / 3);
      const h = (19 * a + b - d - g + 15) % 30;
      const i = Math.floor(c / 4);
      const k = c % 4;
      const l = (32 + 2 * e + 2 * i - h - k) % 7;
      const m = Math.floor((a + 11 * h + 22 * l) / 451);
      const month = Math.floor((h + l - 7 * m + 114) / 31);
      const day = ((h + l - 7 * m + 114) % 31) + 1;
      return new Date(year, month - 1, day);
    };

    const addD = (base: Date, days: number): Date => {
      const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate());
      dt.setDate(dt.getDate() + days);
      return dt;
    };

    const lastSun = (year: number, monthIdx: number): Date => {
      const dt = new Date(year, monthIdx + 1, 0);
      dt.setDate(dt.getDate() - dt.getDay());
      return dt;
    };

    for (let year = currentYear - 1; year <= currentYear + 3; year++) {
      const easter = getEaster(year);
      const items: Array<{ date: Date; title: string; description: string }> = [
        { date: new Date(year, 0, 1), title: 'Nytårsdag', description: 'Officiel dansk helligdag' },
        { date: addD(easter, -49), title: 'Fastelavn', description: 'Dansk mærkedag' },
        { date: addD(easter, -7), title: 'Palmesøndag', description: 'Officiel dansk helligdag' },
        { date: addD(easter, -3), title: 'Skærtorsdag', description: 'Officiel dansk helligdag' },
        { date: addD(easter, -2), title: 'Langfredag', description: 'Officiel dansk helligdag' },
        { date: easter, title: 'Påskedag', description: 'Officiel dansk helligdag' },
        { date: addD(easter, 1), title: '2. Påskedag', description: 'Officiel dansk helligdag' },
        { date: new Date(year, 4, 1), title: '1. Maj', description: 'Arbejdernes internationale kampdag' },
        { date: addD(easter, 39), title: 'Kristi Himmelfartsdag', description: 'Officiel dansk helligdag' },
        { date: addD(easter, 49), title: 'Pinsedag', description: 'Officiel dansk helligdag' },
        { date: addD(easter, 50), title: '2. Pinsedag', description: 'Officiel dansk helligdag' },
        { date: new Date(year, 5, 5), title: 'Grundlovsdag', description: 'Dansk national mærkedag (5. juni)' },
        { date: new Date(year, 5, 23), title: 'Sankt Hans Aften', description: 'Dansk mærkedag (23. juni)' },
        { date: lastSun(year, 2), title: 'Sommertid starter (+1 time)', description: 'Urene stilles 1 time frem' },
        { date: lastSun(year, 9), title: 'Vintertid starter (-1 time)', description: 'Urene stilles 1 time tilbage' },
        { date: new Date(year, 10, 10), title: 'Mortensaften', description: 'Dansk mærkedag (10. november)' },
        { date: new Date(year, 11, 24), title: 'Juleaften', description: 'Dansk mærkedag (24. december)' },
        { date: new Date(year, 11, 25), title: 'Juledag', description: 'Officiel dansk helligdag' },
        { date: new Date(year, 11, 26), title: '2. Juledag', description: 'Officiel dansk helligdag' },
        { date: new Date(year, 11, 31), title: 'Nytårsaften', description: 'Dansk mærkedag (31. december)' }
      ];

      for (const h of items) {
        const startYmd = toDateOnlyString(h.date);
        const endYmd = toDateOnlyString(addD(h.date, 1));
        const slug = h.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const uid = `dk-holiday-${year}-${slug}`;
        result.push({
          id: `${calendarId}::${uid}`,
          uid,
          calendarId,
          title: h.title,
          start: startYmd,
          end: endYmd,
          allDay: true,
          description: h.description,
          location: 'Danmark',
          timezone: 'Europe/Copenhagen',
          attendees: [],
          reminderMinutes: null
        });
      }
    }
    return result;
  }

  async function subscribeToCalendar(subscriptionUrl: string, name?: string, color?: string) {
    if (isPublicShareMode.value || session.value?.mode !== 'CALDAV') return null;
    const trimmedUrl = subscriptionUrl.trim();
    if (!trimmedUrl) {
      notify(
        'URL mangler',
        'Indsæt et iCal / .ics link eller vælg Danske Helligdage.',
        'warning'
      );
      return null;
    }

    const isBuiltinDk =
      trimmedUrl === 'builtin://dk-holidays' || trimmedUrl.toLowerCase() === 'dk-holidays';

    if (!isBuiltinDk && !isOnline.value) {
      notify(
        'Offline',
        'Du skal være online for at abonnere på en ekstern kalender.',
        'warning'
      );
      return null;
    }

    try {
      let calObj: Omit<CalendarSource, 'visible'>;
      let fetchedEvents: CalendarEvent[];

      if (isBuiltinDk) {
        const id = 'sub::dk-holidays';
        const resolvedColor = color || '#e11d48';
        calObj = {
          id,
          url: 'builtin://dk-holidays',
          subscriptionUrl: 'builtin://dk-holidays',
          name: name?.trim() || 'Danske Helligdage',
          color: resolvedColor,
          serverColor: resolvedColor,
          readOnly: true,
          isShared: false,
          isSubscribed: true,
          owner: 'Indbygget abonnement',
          description: 'Officielle danske helligdage og mærkedage'
        };
        fetchedEvents = buildClientDanishHolidays(id);
        if (isOnline.value) {
          void apiSubscribeCalendar({
            name: calObj.name,
            subscriptionUrl: 'builtin://dk-holidays',
            color: resolvedColor,
            username: session.value?.username,
            serverUrl: session.value?.serverUrl
          }).catch(() => {});
        }
      } else {
        const result = await apiSubscribeCalendar({
          name: name?.trim() || undefined,
          subscriptionUrl: trimmedUrl,
          color,
          username: session.value?.username,
          serverUrl: session.value?.serverUrl
        });
        calObj = result.calendar;
        fetchedEvents = result.events || [];
      }

      const overrides = getColorOverrides();
      const localColor = overrides[calObj.id] || null;
      const newCal: CalendarSource = clonePlain({
        ...calObj,
        color: localColor || calObj.color,
        localColorOverride: localColor,
        visible: true,
        isSubscribed: true,
        readOnly: true
      });

      saveLocalSubscription({
        id: newCal.id,
        name: newCal.name,
        subscriptionUrl: newCal.subscriptionUrl || newCal.url,
        color: newCal.color
      });

      hiddenCalendarIds.value = hiddenCalendarIds.value.filter((id) => id !== newCal.id);
      persistHiddenCalendars();

      const existingIdx = calendars.value.findIndex((c) => c.id === newCal.id);
      if (existingIdx !== -1) {
        calendars.value[existingIdx] = newCal;
      } else {
        calendars.value.push(newCal);
      }

      const otherEvents = events.value.filter((e) => e.calendarId !== newCal.id);
      const subEvents = clonePlain(fetchedEvents);
      events.value = [...otherEvents, ...subEvents];

      await db.transaction('rw', db.calendars, db.events, async () => {
        await db.calendars.put(clonePlain(newCal));
        const oldIds = await db.events.where('calendarId').equals(newCal.id).primaryKeys();
        if (oldIds.length > 0) {
          await db.events.bulkDelete(oldIds);
        }
        if (subEvents.length > 0) {
          await db.events.bulkPut(subEvents);
        }
      });

      notify(
        'Abonnement tilføjet',
        `"${newCal.name}" (${subEvents.length} begivenheder) er nu aktiv.`,
        'success'
      );
      return newCal;
    } catch (err: any) {
      notify('Kunne ikke abonnere på kalender', err?.message || String(err), 'error', 9000);
      return null;
    }
  }

  async function deleteCalendar(calId: string) {
    if (isPublicShareMode.value || session.value?.mode !== 'CALDAV') return;
    const cal = getCalendarById(calId);
    if (!cal) return;

    if (cal.isSubscribed || cal.id.startsWith('sub::')) {
      removeLocalSubscription(cal.id, cal.subscriptionUrl || cal.url);
      if (isOnline.value) {
        await apiUnsubscribeCalendar(
          cal.id,
          session.value?.username,
          session.value?.serverUrl
        ).catch(() => {});
      }
      await removeCalendarLocally(calId);
      notify('Abonnement afmeldt', `"${cal.name}" er fjernet fra dine kalendere.`, 'info');
      return;
    }

    if (cal.readOnly || cal.isShared) {
      notify(
        'Kan ikke slettes',
        'Delte kalendere kan kun fjernes fra listen, ikke slettes.',
        'warning'
      );
      return;
    }

    try {
      await apiDeleteCalendar(cal.url);
    } catch (err: any) {
      notify('Kunne ikke slette kalender', err?.message || String(err), 'error', 9000);
      return;
    }

    await removeCalendarLocally(calId);
    notify('Kalender slettet', `"${cal.name}" og dens begivenheder er slettet.`, 'info');
  }

  async function syncBirthdaysToMailcow(silent = false): Promise<boolean> {
    if (isPublicShareMode.value || session.value?.mode !== 'CALDAV') return false;
    if (!isOnline.value) {
      if (!silent) {
        notify('Offline', 'Du skal være online for at synkronisere til Mailcow.', 'warning');
      }
      return false;
    }
    isSyncingBirthdaysToMailcow.value = true;
    try {
      const res = await apiSyncBirthdaysToMailcow();
      birthdayCalendarSyncEnabled.value = true;
      birthdayCalendarUrl.value = res.calendarUrl;
      await syncWithServer(true);
      if (!silent) {
        notify(
          'Synkroniseret til Mailcow',
          `${res.totalContactsEvents} fødselsdage/mærkedage ligger nu i en rigtig Mailcow-kalender (klar til telefon & Thunderbird).`,
          'success',
          6500
        );
      }
      return true;
    } catch (err: any) {
      if (!silent) {
        notify(
          'Synkronisering fejlede',
          err?.message || 'Kunne ikke oprette fødselsdagskalender på Mailcow.',
          'error',
          8000
        );
      }
      return false;
    } finally {
      isSyncingBirthdaysToMailcow.value = false;
    }
  }

  async function disableBirthdaysMailcowSync(deleteCalendar = false): Promise<void> {
    if (isPublicShareMode.value || session.value?.mode !== 'CALDAV') return;
    isSyncingBirthdaysToMailcow.value = true;
    try {
      const targetId = syncedBirthdayCalendar.value?.id;
      await apiDisableBirthdaysSync(deleteCalendar);
      birthdayCalendarSyncEnabled.value = false;
      if (deleteCalendar) {
        birthdayCalendarUrl.value = null;
        if (targetId) {
          await removeCalendarLocally(targetId);
        }
      }
      notify(
        deleteCalendar ? 'Kalender fjernet fra Mailcow' : 'Auto-synk stoppet',
        deleteCalendar
          ? 'Fødselsdage & Mærkedage vises nu igen kun lokalt fra dine kontakter.'
          : 'Kontakter synkroniseres ikke længere automatisk til Mailcow-kalenderen.',
        'info'
      );
    } catch (err: any) {
      notify(
        'Kunne ikke stoppe synk',
        err?.message || 'Fejl ved fjernelse af fødselsdagskalender fra Mailcow.',
        'error'
      );
    } finally {
      isSyncingBirthdaysToMailcow.value = false;
    }
  }

  watch(
    () => contactsStore.contactsMutationCounter,
    () => {
      if (
        (birthdayCalendarSyncEnabled.value || Boolean(syncedBirthdayCalendar.value)) &&
        isOnline.value &&
        !isPublicShareMode.value &&
        session.value?.mode === 'CALDAV'
      ) {
        void syncWithServer(true);
      }
    }
  );

  async function leaveSharedCalendar(calId: string): Promise<boolean> {
    if (isPublicShareMode.value || session.value?.mode !== 'CALDAV') return false;
    const cal = getCalendarById(calId);
    if (!cal || !cal.isShared || cal.isSubscribed || cal.id.startsWith('sub::')) {
      return false;
    }

    if (!isOnline.value) {
      notify(
        'Offline',
        'Du skal være online for at forlade en delt kalender og fjerne dine rettigheder.',
        'warning'
      );
      return false;
    }

    let res: { removedCount: number; removedOwners: string[]; unsubscribedInSogo?: boolean };
    try {
      res = await apiLeaveSharedCalendar({
        shareId: cal.userShareId,
        calendarUrl: cal.url
      });
    } catch (err: any) {
      notify('Kunne ikke forlade delt kalender', err?.message || String(err), 'error', 9000);
      return false;
    }

    const nameOverrides = getNameOverrides();
    delete nameOverrides[cal.id];
    delete nameOverrides[cal.url];
    delete nameOverrides[cal.id.toLowerCase()];
    delete nameOverrides[cal.url.toLowerCase()];
    saveNameOverrides(nameOverrides);

    const colorOverrides = getColorOverrides();
    delete colorOverrides[cal.id];
    delete colorOverrides[cal.url];
    saveColorOverrides(colorOverrides);

    if (hiddenCalendarIds.value.includes(calId)) {
      hiddenCalendarIds.value = hiddenCalendarIds.value.filter((id) => id !== calId);
      persistHiddenCalendars();
    }

    await removeCalendarLocally(calId);

    if (res.removedCount > 0) {
      notify(
        'Forlod delt kalender',
        `Dine adgangsrettigheder til "${cal.name}" er nu fjernet, og kalenderen er fjernet fra din oversigt.`,
        'success'
      );
    } else if (res.unsubscribedInSogo) {
      notify(
        'Forlod delt kalender',
        `Du er nu afmeldt "${cal.name}" i SOGo, og kalenderen er fjernet fra din oversigt i Sharedrive.`,
        'success'
      );
    } else {
      notify(
        'Delt kalender fjernet',
        `"${cal.name}" er fjernet fra din konto i Sharedrive. Hvis den blev delt direkte i SOGo, kan ejeren også fjerne delingen dér.`,
        'info'
      );
    }

    return true;
  }

  async function hideCalendar(calId: string) {
    const cal = getCalendarById(calId);
    if (!cal || calId === BIRTHDAY_CALENDAR_ID) return;
    if (!hiddenCalendarIds.value.includes(calId)) {
      hiddenCalendarIds.value.push(calId);
      persistHiddenCalendars();
    }
    await removeCalendarLocally(calId);
    notify(
      'Kalender fjernet fra listen',
      `"${cal.name}" vises ikke længere. Kan gendannes under "Skjulte kalendere".`,
      'info'
    );
  }

  async function restoreHiddenCalendars() {
    hiddenCalendarIds.value = [];
    persistHiddenCalendars();
    await syncWithServer(false);
  }

  async function restoreDismissedSharedCalendars() {
    if (isPublicShareMode.value || session.value?.mode !== 'CALDAV') return;
    try {
      await apiRestoreDismissedSharedCalendars();
      dismissedSharedCount.value = 0;
      await syncWithServer(false);
      notify(
        'Delte kalendere gendannet',
        'Tidligere forladte delte kalendere vises igen, hvis du stadig har adgang i SOGo.',
        'success'
      );
    } catch (err: any) {
      notify('Kunne ikke gendanne delte kalendere', err?.message || String(err), 'error');
    }
  }

  async function removeCalendarLocally(calId: string) {
    calendars.value = calendars.value.filter((c) => c.id !== calId);
    const evIds = events.value.filter((e) => e.calendarId === calId).map((e) => e.id);
    events.value = events.value.filter((e) => e.calendarId !== calId);
    selectedEventIds.value = selectedEventIds.value.filter((id) => !evIds.includes(id));
    clipboard.value.events = clipboard.value.events.filter((e) => e.calendarId !== calId);
    if (clipboard.value.events.length === 0) clearClipboard();
    await db.calendars.delete(calId);
    await db.events.bulkDelete(evIds);
    if (activeTargetCalendarId.value === calId) {
      activeTargetCalendarId.value = pickDefaultTargetCalendar()?.id || '';
    }
  }

  function openContextMenu(payload: Omit<ContextMenuState, 'visible'>) {
    if (isPublicShareMode.value) return;
    if (payload.event && payload.event.calendarId === BIRTHDAY_CALENDAR_ID) return;
    const menuWidth = 260;
    const menuHeight = 320;
    const x = Math.min(payload.x, window.innerWidth - menuWidth - 12);
    const y = Math.min(payload.y, window.innerHeight - menuHeight - 12);

    contextMenu.value = {
      ...payload,
      event: payload.event ? clonePlain(payload.event) : null,
      x: Math.max(8, x),
      y: Math.max(8, y),
      visible: true
    };
  }

  function closeContextMenu() {
    contextMenu.value.visible = false;
  }

  function openCreateEventModal(dateStr?: string, allDay = false) {
    if (isPublicShareMode.value) return;
    const cal = defaultWritableCalendar.value;
    if (!cal) {
      notify('Ingen skrivbar kalender', 'Alle aktive kalendere er Read-Only.', 'error');
      return;
    }

    const baseDate = dateStr || selectedDateStr.value || toDateOnlyString(new Date());
    let startIso: string;
    let endIso: string;

    if (allDay || (!baseDate.includes('T') && currentView.value === 'dayGridMonth')) {
      const startDay = baseDate.slice(0, 10);
      const startDt = new Date(`${startDay}T09:00:00`);
      const endDt = new Date(`${startDay}T10:00:00`);
      startIso = startDt.toISOString();
      endIso = endDt.toISOString();
    } else {
      const startDt = new Date(baseDate);
      const endDt = new Date(startDt.getTime() + 60 * 60 * 1000);
      startIso = startDt.toISOString();
      endIso = endDt.toISOString();
    }

    editingEvent.value = {
      id: '',
      uid: '',
      calendarId: cal.id,
      title: '',
      start: startIso,
      end: endIso,
      allDay: false,
      description: '',
      location: '',
      videoUrl: '',
      timezone: 'Europe/Copenhagen',
      attendees: [],
      reminderMinutes: null
    };
    isEventModalOpen.value = true;
  }

  function openCreateEventFromMail(msg: {
    subject: string;
    from: Array<{ name: string; address: string }>;
    to?: Array<{ name: string; address: string }>;
    date: string;
    textBody?: string;
  }) {
    if (isPublicShareMode.value) return;
    const cal = defaultWritableCalendar.value;
    if (!cal) {
      notify('Ingen skrivbar kalender', 'Vælg eller opret en skrivbar kalender først.', 'error');
      return;
    }

    const startDt = new Date();
    startDt.setMinutes(0, 0, 0);
    startDt.setHours(startDt.getHours() + 1);
    const endDt = new Date(startDt.getTime() + 60 * 60 * 1000);

    const myEmail = (session.value?.username || '').toLowerCase().trim();
    const sender = msg.from?.[0];
    const attendees =
      sender && sender.address && sender.address.toLowerCase().trim() !== myEmail
        ? [
            {
              email: sender.address,
              name: sender.name || sender.address.split('@')[0],
              partstat: 'NEEDS-ACTION' as RsvpStatus
            }
          ]
        : [];

    const senderLabel = sender
      ? sender.name
        ? `${sender.name} <${sender.address}>`
        : sender.address
      : 'Ukendt afsender';

    editingEvent.value = {
      id: '',
      uid: '',
      calendarId: cal.id,
      title: msg.subject.replace(/^(re|fwd|sv|vs):\s*/i, '').trim() || 'Ny aftale',
      start: startDt.toISOString(),
      end: endDt.toISOString(),
      allDay: false,
      description: `Oprettet fra e-mail fra ${senderLabel}\nModtaget: ${new Date(msg.date).toLocaleString('da-DK')}\n\n${(msg.textBody || '').slice(0, 1200)}`,
      location: '',
      videoUrl: '',
      timezone: 'Europe/Copenhagen',
      attendees,
      reminderMinutes: 15
    };
    isEventModalOpen.value = true;
  }

  function openEditEventModal(ev: CalendarEvent) {
    editingEvent.value = clonePlain(ev);
    isEventModalOpen.value = true;
  }

  return {
    session,
    calendars,
    events,
    birthdayEvents,
    showContactBirthdays,
    syncedBirthdayCalendar,
    isSyncingBirthdaysToMailcow,
    birthdayCalendarSyncEnabled,
    birthdayCalendarUrl,
    trashItems,
    syncQueue,
    shares,
    userShares,
    isLoadingUserShares,
    publicShareError,
    isOnline,
    isSyncing,
    lastSyncedAt,
    autoRefreshMinutes,
    setAutoRefreshMinutes,
    currentView,
    selectedEventIds,
    selectedDateStr,
    activeTargetCalendarId,
    searchQuery,
    clipboard,
    undoStack,
    contextMenu,
    isTrashModalOpen,
    isShareModalOpen,
    preselectedShareCalendarId,
    isImportExportModalOpen,
    preselectedImportExportCalendarId,
    isBulkDeleteModalOpen,
    editingEvent,
    isEventModalOpen,
    hiddenCalendarIds,
    dismissedSharedCount,

    isPublicShareMode,
    isAuthenticated,
    visibleCalendars: computed(() => calendars.value.filter((c) => c.visible)),
    writableCalendars,
    defaultWritableCalendar,
    visibleEvents,
    clipboardEventIds,
    searchResults,

    notify,
    logout,
    hydrateSession,
    hydrateAfterLogin,
    resetState,
    flushAndSyncOnReconnect,
    loadPublicSharedCalendar,
    getCalendarById,
    isCalendarReadOnly,
    hasInvitedAttendees,
    toggleContactBirthdays,
    findConflictingEvents,
    syncWithServer,
    openShareModal,
    loadShares,
    loadUserShares,
    getOutgoingSharesForCalendar,
    isSharedCalendarAlreadyAdded,
    searchSharedCalendars,
    subscribeSharedCalendar,
    shareCalendarWithUser,
    updateUserSharePermission,
    revokeUserShare,
    createShare,
    revokeShare,
    openImportExportModal,
    importIcsFile,
    exportCalendarIcs,
    toggleCalendarVisibility,
    setCalendarColorOverride,
    setCalendarNameOverride,
    saveEvent,
    deleteEventsByIds,
    bulkDeleteEvents,
    restoreFromTrash,
    permanentlyDeleteFromTrash,
    emptyTrash,
    clearClipboard,
    copyOrCutSelection,
    pasteToDate,
    triggerUndo,
    respondToInvite,
    openContextMenu,
    closeContextMenu,
    openCreateEventModal,
    openCreateEventFromMail,
    openEditEventModal,
    createCalendar,
    subscribeToCalendar,
    deleteCalendar,
    syncBirthdaysToMailcow,
    disableBirthdaysMailcowSync,
    leaveSharedCalendar,
    hideCalendar,
    restoreHiddenCalendars,
    restoreDismissedSharedCalendars
  };
});

export function toDateOnlyString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function diffDaysBetween(sourceYmd: string, targetYmd: string): number {
  const [sy, sm, sd] = sourceYmd.split('-').map(Number);
  const [ty, tm, td] = targetYmd.split('-').map(Number);
  const utcSource = Date.UTC(sy, sm - 1, sd);
  const utcTarget = Date.UTC(ty, tm - 1, td);
  return Math.round((utcTarget - utcSource) / (1000 * 60 * 60 * 24));
}

function addDaysToDateOnly(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
