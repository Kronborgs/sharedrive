import type { CalendarEvent } from '../types/calendar';

const notifiedEventKeys = new Set<string>();
let reminderIntervalId: number | null = null;

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) {
    return 'denied';
  }
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  return Notification.requestPermission();
}

export function startReminderWatcher(getEvents: () => CalendarEvent[]) {
  if (reminderIntervalId !== null) {
    window.clearInterval(reminderIntervalId);
  }

  const checkReminders = () => {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    const nowMs = Date.now();
    const events = getEvents();

    for (const ev of events) {
      if (typeof ev.reminderMinutes !== 'number' || ev.reminderMinutes < 0) continue;
      const startMs = new Date(ev.start).getTime();
      if (Number.isNaN(startMs)) continue;

      const triggerMs = startMs - ev.reminderMinutes * 60 * 1000;
      const diffMs = nowMs - triggerMs;

      // Udløs hvis vi er inden for et 90-sekunders vindue af VALARM tidspunktet
      const key = `${ev.id}::${ev.start}::${ev.reminderMinutes}`;
      if (diffMs >= 0 && diffMs <= 90_000 && !notifiedEventKeys.has(key)) {
        notifiedEventKeys.add(key);
        new Notification(`Påmindelse: ${ev.title}`, {
          body: `${ev.reminderMinutes === 0 ? 'Starter nu' : `Starter om ${ev.reminderMinutes} min.`}${ev.location ? ` • ${ev.location}` : ''}`,
          icon: '/mail/suite-ui/suite-icon.svg',
          tag: key
        });
      }
    }
  };

  reminderIntervalId = window.setInterval(checkReminders, 30_000);
  checkReminders();
}
