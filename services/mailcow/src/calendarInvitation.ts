import ICAL from 'ical.js';

export function readCalendarInvitation(rawIcs: string) {
  if (!rawIcs || rawIcs.length > 512 * 1024) return undefined;
  try {
    const calendar = new ICAL.Component(ICAL.parse(rawIcs));
    const events = calendar.getAllSubcomponents('vevent');
    if (calendar.name !== 'vcalendar' || !events.length) return undefined;
    const masters = events.filter(component => !component.hasProperty('recurrence-id'));
    const master = masters[0] ?? events[0];
    const event = new ICAL.Event(master, { exceptions: [] });
    const method = String(calendar.getFirstPropertyValue('method') ?? '').toUpperCase();
    const cancelled = method === 'CANCEL' || master.getFirstPropertyValue('status') === 'CANCELLED';
    const uid = event.uid || undefined;
    const start = event.startDate;
    const recurring = event.isRecurring() || events.length > 1;
    const oneSeries = masters.length === 1 && events.every(component => component.getFirstPropertyValue('uid') === uid);
    return {
      uid, method, cancelled, recurring,
      occurrenceUpdate: masters.length === 0 && event.isRecurrenceException(),
      canAddDirectly: Boolean(uid && oneSeries && start && !cancelled && ['', 'REQUEST', 'PUBLISH'].includes(method)),
      summary: event.summary || 'Mødeinvitation',
      start: start?.toString(),
      end: start ? event.endDate?.toString() : undefined,
      location: event.location || undefined,
      organizer: event.organizer?.replace(/^mailto:/i, ''),
      rawIcs
    };
  } catch {
    return undefined;
  }
}

export function buildInvitationSeries(rawIcs: string): string {
  const calendar = new ICAL.Component(ICAL.parse(rawIcs));
  calendar.removeAllProperties('method');
  for (const component of calendar.getAllSubcomponents()) {
    if (component.name === 'vevent') {
      component.removeAllSubcomponents();
      component.removeAllProperties('attach');
      const participants = [...component.getAllProperties('organizer'), ...component.getAllProperties('attendee')];
      for (const property of participants) property.setParameter('schedule-agent', 'NONE');
    } else if (component.name !== 'vtimezone') {
      calendar.removeSubcomponent(component);
    }
  }
  return calendar.toString();
}
