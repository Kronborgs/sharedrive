import type {
  CalendarSource,
  CalendarEvent,
  RsvpStatus,
  PublicShareLink,
  UserCalendarShare,
  CalendarSharePermission,
  SharedCalendarSearchResult
} from '../types/calendar';

export interface SyncResponse {
  ok: boolean;
  calendars: Omit<CalendarSource, 'visible'>[];
  events: CalendarEvent[];
  nameOverrides?: Record<string, string>;
  colorOverrides?: Record<string, string>;
  dismissedSharedCount?: number;
  birthdayCalendarSync?: {
    enabled: boolean;
    calendarUrl: string | null;
    lastSyncedAt: string | null;
  };
  syncedAt: string;
  error?: string;
}

export interface PublicShareResponse {
  ok: boolean;
  label: string;
  owner: string;
  hideDetails: boolean;
  calendars: Omit<CalendarSource, 'visible'>[];
  events: CalendarEvent[];
  syncedAt: string;
  error?: string;
}

export interface LocalSubscriptionHint {
  id?: string;
  name?: string;
  subscriptionUrl: string;
  color?: string;
}

export async function apiSyncCalDav(
  timeRange?: { start: string; end: string },
  subscriptions?: LocalSubscriptionHint[],
  forceBirthdaySync = false
): Promise<SyncResponse> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/sync', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ timeRange, subscriptions, forceBirthdaySync })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Synkronisering med Mailcow/SOGo mislykkedes.');
  }
  return data;
}

export async function apiSaveEvent(event: CalendarEvent): Promise<CalendarEvent> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/events', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ event })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke gemme begivenheden på serveren.');
  }
  return data.event;
}

export async function apiDeleteEvent(caldavUrl: string, etag?: string): Promise<void> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/events', {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ caldavUrl, etag })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke slette begivenheden på serveren.');
  }
}

export async function apiBulkDeleteEvents(
  items: Array<{ caldavUrl: string; etag?: string }>
): Promise<{ deletedCount: number; failedCount: number }> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/events/bulk-delete', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ items })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke gennemføre bulk-sletning på serveren.');
  }
  return {
    deletedCount: data.deletedCount || 0,
    failedCount: data.failedCount || 0
  };
}

export async function apiUpdateRsvp(
  event: CalendarEvent,
  partstat: RsvpStatus
): Promise<CalendarEvent> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/rsvp', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ event, partstat })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke opdatere RSVP-status på serveren.');
  }
  return data.event;
}

export async function apiCreateCalendar(
  name: string,
  color: string,
  calendarUrl?: string
): Promise<Omit<CalendarSource, 'visible'>> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/calendars', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name, color, calendarUrl })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke oprette kalenderen på serveren.');
  }
  return data.calendar;
}

export async function apiDeleteCalendar(calendarUrl: string): Promise<void> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/calendars', {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ calendarUrl })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke slette kalenderen på serveren.');
  }
}

export async function apiListShares(): Promise<PublicShareLink[]> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/shares', {
    method: 'GET',
    credentials: 'include'
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke hente delingslinks.');
  }
  return data.shares || [];
}

export async function apiCreateShare(params: {
  label: string;
  calendarUrls: string[];
  calendarNames: string[];
  hideDetails: boolean;
  expiresAt?: string;
}): Promise<PublicShareLink> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/shares', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke oprette delingslink.');
  }
  return data.share;
}

export async function apiDeleteShare(token: string): Promise<void> {
  const res = await fetch(`/api/v1/me/mailcow/suite/caldav/shares/${encodeURIComponent(token)}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke slette delingslink.');
  }
}

export async function apiListUserShares(): Promise<UserCalendarShare[]> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/user-shares', {
    method: 'GET',
    credentials: 'include'
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke hente bruger-delinger.');
  }
  return data.userShares || [];
}

export async function apiUpsertUserShare(params: {
  calendarUrl: string;
  calendarName: string;
  calendarColor: string;
  recipientEmail: string;
  permission: CalendarSharePermission;
}): Promise<UserCalendarShare> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/user-shares', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke dele kalenderen med brugeren.');
  }
  return data.userShare;
}

export async function apiUpdateUserSharePermission(
  shareId: string,
  permission: CalendarSharePermission,
  meta?: { calendarName?: string; calendarColor?: string }
): Promise<UserCalendarShare> {
  const res = await fetch(`/api/v1/me/mailcow/suite/caldav/user-shares/${encodeURIComponent(shareId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      permission,
      calendarName: meta?.calendarName,
      calendarColor: meta?.calendarColor
    })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke opdatere rettighed.');
  }
  return data.userShare;
}

export async function apiDeleteUserShare(shareId: string): Promise<void> {
  const res = await fetch(`/api/v1/me/mailcow/suite/caldav/user-shares/${encodeURIComponent(shareId)}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke tilbagekalde bruger-deling.');
  }
}

export async function apiLeaveSharedCalendar(params: {
  shareId?: string;
  calendarUrl?: string;
}): Promise<{ removedCount: number; removedOwners: string[]; unsubscribedInSogo?: boolean }> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/user-shares/leave', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke forlade den delte kalender.');
  }
  return {
    removedCount: Number(data.removedCount || 0),
    removedOwners: Array.isArray(data.removedOwners) ? data.removedOwners : [],
    unsubscribedInSogo: Boolean(data.unsubscribedInSogo)
  };
}

export async function apiRestoreDismissedSharedCalendars(): Promise<void> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/user-shares/restore-dismissed', {
    method: 'POST',
    credentials: 'include'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke gendanne forladte delte kalendere.');
  }
}

export async function apiSearchSharedCalendars(
  query: string,
  candidateEmails?: string[]
): Promise<SharedCalendarSearchResult[]> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/shared-search', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ query, candidateEmails })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke søge efter delte kalendere.');
  }
  return Array.isArray(data.calendars) ? data.calendars : [];
}

export async function apiSubscribeSharedCalendar(params: {
  calendarUrl: string;
  owner?: string;
  name?: string;
  color?: string;
}): Promise<{
  calendar: Omit<CalendarSource, 'visible'>;
  events: CalendarEvent[];
  subscribedInSogo: boolean;
}> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/shared-subscribe', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke tilføje den delte kalender.');
  }
  return {
    calendar: data.calendar,
    events: Array.isArray(data.events) ? data.events : [],
    subscribedInSogo: Boolean(data.subscribedInSogo)
  };
}

export async function apiSetCalendarName(params: {
  calendarId: string;
  calendarUrl?: string;
  name: string | null;
  renameOnServer?: boolean;
}): Promise<{
  renamedOnServer: boolean;
  effectiveName: string | null;
  localNameOverride: string | null;
  fallbackReason?: string;
}> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/calendar-name', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke omdøbe kalenderen.');
  }
  return {
    renamedOnServer: Boolean(data.renamedOnServer),
    effectiveName: data.effectiveName ?? null,
    localNameOverride: data.localNameOverride ?? null,
    fallbackReason: data.fallbackReason
  };
}

export async function apiSetCalendarColor(params: {
  calendarId: string;
  calendarUrl?: string;
  color: string | null;
}): Promise<{
  syncedToServer: boolean;
  effectiveColor: string | null;
  localColorOverride: string | null;
  fallbackReason?: string;
}> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/calendar-color', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke opdatere kalenderfarven.');
  }
  return {
    syncedToServer: Boolean(data.syncedToServer),
    effectiveColor: data.effectiveColor ?? null,
    localColorOverride: data.localColorOverride ?? null,
    fallbackReason: data.fallbackReason
  };
}

export async function apiFetchPublicShare(token: string): Promise<PublicShareResponse> {
  const res = await fetch(`/api/v1/mailcow/public/${encodeURIComponent(token)}`);
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Delingslinket er ugyldigt eller udløbet.');
  }
  return data;
}

export async function apiImportIcs(
  calendarId: string,
  icsContent: string
): Promise<{ importedCount: number; events: CalendarEvent[] }> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/import', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ calendarId, icsContent })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke importere .ics-filen.');
  }
  return {
    importedCount: data.importedCount || 0,
    events: data.events || []
  };
}

export async function apiExportIcs(
  events: CalendarEvent[],
  calendarName: string
): Promise<string> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/export', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ events, calendarName })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke eksportere kalenderen.');
  }
  return data.icsContent;
}

export async function apiSubscribeCalendar(params: {
  name?: string;
  subscriptionUrl: string;
  color?: string;
  username?: string;
  serverUrl?: string;
}): Promise<{ calendar: Omit<CalendarSource, 'visible'>; events: CalendarEvent[] }> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/subscriptions', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke abonnere på kalenderen.');
  }
  return {
    calendar: data.calendar,
    events: data.events || []
  };
}

export async function apiUnsubscribeCalendar(
  id: string,
  username?: string,
  serverUrl?: string
): Promise<void> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/subscriptions', {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ id, username, serverUrl })
  });
  const data = await res.json().catch(() => ({ ok: res.ok }));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke afmelde kalender-abonnementet.');
  }
}

export interface BirthdaySyncResponse {
  synced: boolean;
  skipped?: boolean;
  calendarUrl: string | null;
  totalContactsEvents: number;
  createdOrUpdated: number;
  deleted: number;
  unchanged: number;
  lastSyncedAt: string | null;
}

export async function apiSyncBirthdaysToMailcow(): Promise<BirthdaySyncResponse> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/birthdays-sync', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke synkronisere fødselsdagskalenderen til Mailcow.');
  }
  return data as BirthdaySyncResponse;
}

export async function apiDisableBirthdaysSync(
  deleteCalendar = false
): Promise<{ disabled: boolean; deletedCalendar: boolean }> {
  const res = await fetch('/api/v1/me/mailcow/suite/caldav/birthdays-sync', {
    method: 'DELETE',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ deleteCalendar })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Kunne ikke stoppe fødselsdagssynkronisering.');
  }
  return {
    disabled: Boolean(data.disabled),
    deletedCalendar: Boolean(data.deletedCalendar)
  };
}
