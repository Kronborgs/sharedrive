import ICAL from 'ical.js';

export interface AttendeeDTO {
  email: string;
  name?: string;
  partstat: 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';
  role?: string;
  isOrganizer?: boolean;
}

export interface CalendarEventDTO {
  id: string;
  uid: string;
  calendarId: string;
  title: string;
  start: string; // ISO 8601
  end: string;   // ISO 8601
  allDay: boolean;
  description?: string;
  location?: string;
  videoUrl?: string;
  timezone?: string;
  attendees: AttendeeDTO[];
  organizer?: string;
  reminderMinutes?: number | null;
  etag?: string;
  caldavUrl?: string;
  rawIcs?: string;
}

const VIDEO_URL_REGEX = /(https?:\/\/(?:[^\s"]*zoom\.us|teams\.microsoft\.com|meet\.google\.com|jitsi\.[^\s"]+|whereby\.com)[^\s">]*)/i;

/**
 * Sikrer at eksterne URL'er fra .ics-filer kun må være http:// eller https:// (blokerer javascript: / data: XSS).
 */
export function sanitizeHttpUrl(raw?: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sikrer korrekt dansk UTF-8 tekst (æøå / ÆØÅ):
 * 1) Dekoder eventuelle XML/HTML numeriske og hexadecimale entiteter (&#230;, &#xE6; osv.)
 * 2) Retter evt. ISO-8859-1 / Latin-1 mojibake (f.eks. Ã¦ -> æ, Ã¸ -> ø, Ã¥ -> å, Ã† -> Æ, Ã˜ -> Ø, Ã… -> Å)
 */
export function normalizeDanishText(input?: string | null): string {
  if (!input || typeof input !== 'string') return '';
  let text = input
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  // Hvis strengen indeholder typiske UTF-8-som-ISO-8859-1 sekvenser (Ã¦, Ã¸, Ã¥, Ã†, Ã˜, Ã…)
  if (/Ã[\u0080-\u00BF]/.test(text)) {
    try {
      const bytes = Buffer.from(text, 'latin1');
      const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      text = utf8;
    } catch {
      // behold eksisterende tekst hvis den ikke er ren latin1-mojibake
    }
  }

  return text;
}

function formatIcalDate(dt: ICAL.Time | null | undefined, allDay: boolean): string {
  if (!dt) return new Date().toISOString();
  if (allDay) {
    const y = String(dt.year).padStart(4, '0');
    const m = String(dt.month).padStart(2, '0');
    const d = String(dt.day).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return dt.toJSDate().toISOString();
}

/**
 * Parser en rå iCalendar (.ics) streng til strukturerede CalendarEventDTO-objekter.
 * Understøtter VTIMEZONE via ical.js TimezoneService, ATTENDEE/PARTSTAT (RSVP), VALARM og RRULE-udrulning for abonnementer.
 */
export function parseIcsToEvents(
  rawIcs: string,
  calendarId: string,
  caldavUrl?: string,
  etag?: string,
  includeRawIcs = false,
  expandRecurrences = false
): CalendarEventDTO[] {
  try {
    const jcalData = ICAL.parse(rawIcs);
    const vcalendar = new ICAL.Component(jcalData);

    // Registrér eventuelle indlejrede VTIMEZONE komponenter i ical.js (spring over hvis allerede registreret)
    const vtimezones = vcalendar.getAllSubcomponents('vtimezone');
    for (const vtz of vtimezones) {
      const tzid = vtz.getFirstPropertyValue('tzid');
      if (typeof tzid === 'string' && tzid && !ICAL.TimezoneService.has(tzid)) {
        ICAL.TimezoneService.register(vtz);
      }
    }

    const vevents = vcalendar.getAllSubcomponents('vevent');
    const keepRawIcs = includeRawIcs && vevents.length === 1;
    const results: CalendarEventDTO[] = [];

    const nowYear = new Date().getFullYear();
    const minExpandMs = new Date(nowYear - 1, 0, 1).getTime();
    const maxExpandMs = new Date(nowYear + 2, 11, 31, 23, 59, 59).getTime();

    for (const veventComp of vevents) {
      const event = new ICAL.Event(veventComp);
      // Spring enkelt-forekomster med RECURRENCE-ID over hvis vi ruller hovedbegivenheden ud i et abonnement
      if (expandRecurrences && event.isRecurrenceException()) {
        continue;
      }
      const uid = event.uid || crypto.randomUUID();
      const startDate = event.startDate;
      const endDate = event.endDate || startDate;

      const allDay = Boolean(startDate?.isDate);
      const timezone = startDate?.zone?.tzid || 'Europe/Copenhagen';

      const startIso = formatIcalDate(startDate, allDay);
      const endIso = formatIcalDate(endDate, allDay);

      const description = normalizeDanishText(event.description || '');
      const location = normalizeDanishText(event.location || '');

      // Udtræk evt. videomøde-link fra URL-felt, lokation eller beskrivelse (kun http/https tilladt)
      const urlProp = veventComp.getFirstPropertyValue('url');
      const customVideoProp = veventComp.getFirstPropertyValue('x-google-conference') ||
                              veventComp.getFirstPropertyValue('x-microsoft-skypeteamsmeetingurl');
      let videoUrl = sanitizeHttpUrl(urlProp) || sanitizeHttpUrl(customVideoProp);
      if (!videoUrl) {
        const match = `${location} ${description}`.match(VIDEO_URL_REGEX);
        if (match) {
          videoUrl = sanitizeHttpUrl(match[1]);
        }
      }

      // Parser arrangør (ORGANIZER)
      const organizerProp = veventComp.getFirstProperty('organizer');
      let organizer: string | undefined;
      if (organizerProp) {
        const orgVal = String(organizerProp.getFirstValue() || '');
        organizer = orgVal.replace(/^mailto:/i, '').trim();
      }

      // Parser deltagere (ATTENDEE) og deres RSVP status (PARTSTAT)
      const attendeeProps = veventComp.getAllProperties('attendee');
      const attendees: AttendeeDTO[] = attendeeProps.map((prop) => {
        const rawVal = String(prop.getFirstValue() || '');
        const email = rawVal.replace(/^mailto:/i, '').trim();
        const cn = prop.getParameter('cn');
        const partstatRaw = String(prop.getParameter('partstat') || 'NEEDS-ACTION').toUpperCase();
        const role = String(prop.getParameter('role') || 'REQ-PARTICIPANT');

        const validPartstats = ['NEEDS-ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE'] as const;
        const partstat = (validPartstats.includes(partstatRaw as any)
          ? partstatRaw
          : 'NEEDS-ACTION') as AttendeeDTO['partstat'];

        return {
          email,
          name: normalizeDanishText(typeof cn === 'string' ? cn : email.split('@')[0]),
          partstat,
          role,
          isOrganizer: organizer ? email.toLowerCase() === organizer.toLowerCase() : false
        };
      });

      // Parser påmindelse (VALARM)
      let reminderMinutes: number | null = null;
      const valarm = veventComp.getFirstSubcomponent('valarm');
      if (valarm) {
        const trigger = valarm.getFirstPropertyValue('trigger') as ICAL.Duration | null;
        if (trigger && typeof trigger.toSeconds === 'function') {
          reminderMinutes = Math.round(Math.abs(trigger.toSeconds()) / 60);
        }
      }

      const baseTitle = normalizeDanishText(event.summary) || '(Ingen titel)';

      if (expandRecurrences && event.isRecurring()) {
        try {
          const isBrogaardManaged =
            String(veventComp.getFirstPropertyValue('x-brogaard-managed') || '').toUpperCase() ===
            'TRUE';
          const originYearRaw = Number(veventComp.getFirstPropertyValue('x-brogaard-origin-year') || 0);
          const managedKind = String(veventComp.getFirstPropertyValue('x-brogaard-kind') || '');
          const managedName = normalizeDanishText(
            String(veventComp.getFirstPropertyValue('x-brogaard-name') || '')
          );
          const managedLabel = normalizeDanishText(
            String(veventComp.getFirstPropertyValue('x-brogaard-label') || '')
          );

          const windowMinMs = isBrogaardManaged
            ? new Date(nowYear - 2, 0, 1).getTime()
            : minExpandMs;
          const windowMaxMs = isBrogaardManaged
            ? new Date(nowYear + 4, 11, 31, 23, 59, 59).getTime()
            : maxExpandMs;

          const iter = event.iterator();
          let nextDt: ICAL.Time | null = iter.next();
          let count = 0;
          const maxIterations = isBrogaardManaged ? 300 : 200;
          while (nextDt && count < maxIterations) {
            const occMs = nextDt.toJSDate().getTime();
            if (occMs > windowMaxMs) break;
            if (occMs >= windowMinMs) {
              const details = event.getOccurrenceDetails(nextDt);
              const occAllDay = Boolean(details.startDate?.isDate);
              const occStart = formatIcalDate(details.startDate, occAllDay);
              const occEnd = formatIcalDate(details.endDate || details.startDate, occAllDay);
              const occUid = `${uid}_${occStart.slice(0, 10)}`;

              let occTitle = normalizeDanishText(details.item.summary) || baseTitle;
              if (isBrogaardManaged && managedName) {
                const occYear = details.startDate?.year || Number(occStart.slice(0, 4));
                const diffYears =
                  originYearRaw >= 1900 && occYear ? occYear - originYearRaw : -1;
                const yearsSuffix =
                  diffYears >= 0 && diffYears <= 130 ? ` (${diffYears} år)` : '';
                if (managedKind === 'birthday') {
                  occTitle = `🎂 ${managedName}${yearsSuffix}`;
                } else if (managedKind === 'anniversary') {
                  occTitle = `💍 ${managedName} – ${managedLabel || 'Bryllupsdag'}${yearsSuffix}`;
                }
              }

              results.push({
                id: `${calendarId}::${occUid}`,
                uid: occUid,
                calendarId,
                title: occTitle,
                start: occStart,
                end: occEnd,
                allDay: occAllDay,
                description,
                location,
                videoUrl,
                timezone,
                attendees,
                organizer,
                reminderMinutes
              });
            }
            nextDt = iter.next();
            count++;
          }
          continue;
        } catch {
          // Fald tilbage til enkeltstående begivenhed hvis RRULE-udrulning fejler
        }
      }

      results.push({
        id: `${calendarId}::${uid}`,
        uid,
        calendarId,
        title: baseTitle,
        start: startIso,
        end: endIso,
        allDay,
        description,
        location,
        videoUrl,
        timezone,
        attendees,
        organizer,
        reminderMinutes,
        etag,
        caldavUrl,
        rawIcs: keepRawIcs ? rawIcs : undefined
      });
    }

    return results;
  } catch (err) {
    console.error('Fejl ved parsing af ICS:', err);
    return [];
  }
}

/**
 * Bygger eller opdaterer en iCalendar (.ics) streng ud fra et CalendarEventDTO.
 * Hvis begivenheden allerede har rawIcs (f.eks. fra SOGo med VTIMEZONE og ekstra properties),
 * bevares eksisterende metadata og kun ændrede felter opdateres.
 */
export function buildIcsFromEvent(dto: Partial<CalendarEventDTO> & { title: string; start: string; end: string }): string {
  const uid = dto.uid || crypto.randomUUID();
  let vcalendar: ICAL.Component;
  let vevent: ICAL.Component;

  if (dto.rawIcs) {
    try {
      const jcal = ICAL.parse(dto.rawIcs);
      vcalendar = new ICAL.Component(jcal);
      const existingVevent = vcalendar.getFirstSubcomponent('vevent');
      if (existingVevent) {
        vevent = existingVevent;
      } else {
        vevent = new ICAL.Component('vevent');
        vcalendar.addSubcomponent(vevent);
      }
    } catch {
      vcalendar = createBaseCalendarComponent();
      vevent = new ICAL.Component('vevent');
      vcalendar.addSubcomponent(vevent);
    }
  } else {
    vcalendar = createBaseCalendarComponent();
    vevent = new ICAL.Component('vevent');
    vcalendar.addSubcomponent(vevent);
  }

  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue('uid', uid);
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
  vevent.updatePropertyWithValue('summary', dto.title);

  const startJs = new Date(dto.start);
  const endJs = new Date(dto.end);

  if (dto.allDay) {
    const startTime = ICAL.Time.fromJSDate(startJs, false);
    startTime.isDate = true;
    const endTime = ICAL.Time.fromJSDate(endJs, false);
    endTime.isDate = true;
    vevent.updatePropertyWithValue('dtstart', startTime);
    vevent.updatePropertyWithValue('dtend', endTime);
  } else {
    const startTime = ICAL.Time.fromJSDate(startJs, true);
    const endTime = ICAL.Time.fromJSDate(endJs, true);
    vevent.updatePropertyWithValue('dtstart', startTime);
    vevent.updatePropertyWithValue('dtend', endTime);
  }

  if (dto.description !== undefined) {
    vevent.updatePropertyWithValue('description', dto.description || '');
  }
  if (dto.location !== undefined) {
    vevent.updatePropertyWithValue('location', dto.location || '');
  }
  const safeVideoUrl = sanitizeHttpUrl(dto.videoUrl);
  if (safeVideoUrl) {
    vevent.updatePropertyWithValue('url', safeVideoUrl);
  }

  // Opdater deltagere / RSVP (PARTSTAT) hvis angivet
  if (dto.attendees && dto.attendees.length > 0) {
    vevent.removeAllProperties('attendee');
    for (const att of dto.attendees) {
      const prop = new ICAL.Property('attendee');
      prop.setParameter('cn', att.name || att.email);
      prop.setParameter('partstat', att.partstat || 'NEEDS-ACTION');
      prop.setParameter('role', att.role || 'REQ-PARTICIPANT');
      prop.setParameter('rsvp', 'TRUE');
      prop.setValue(`mailto:${att.email}`);
      vevent.addProperty(prop);
    }
  }

  // Opdater VALARM påmindelse
  vevent.removeAllSubcomponents('valarm');
  if (typeof dto.reminderMinutes === 'number' && dto.reminderMinutes >= 0) {
    const valarm = new ICAL.Component('valarm');
    valarm.updatePropertyWithValue('action', 'DISPLAY');
    valarm.updatePropertyWithValue('description', dto.title);
    const triggerProp = new ICAL.Property('trigger');
    const mins = Math.max(1, Math.round(dto.reminderMinutes));
    triggerProp.setValue(ICAL.Duration.fromString(`-PT${mins}M`));
    valarm.addProperty(triggerProp);
    vevent.addSubcomponent(valarm);
  }

  return vcalendar.toString();
}

function createBaseCalendarComponent(): ICAL.Component {
  const vcalendar = new ICAL.Component(['vcalendar', [], []]);
  vcalendar.updatePropertyWithValue('prodid', '-//Sharedrive//CalDAV Webkalender//DA');
  vcalendar.updatePropertyWithValue('version', '2.0');
  vcalendar.updatePropertyWithValue('calscale', 'GREGORIAN');
  return vcalendar;
}

/**
 * Bygger en samlet .ics fil (VCALENDAR med alle VEVENTs) til eksport af en hel kalender.
 */
export function buildCalendarExportIcs(events: CalendarEventDTO[], calendarName = 'Sharedrive'): string {
  const vcalendar = createBaseCalendarComponent();
  vcalendar.updatePropertyWithValue('x-wr-calname', calendarName);

  for (const dto of events) {
    try {
      const singleIcs = buildIcsFromEvent(dto);
      const parsed = ICAL.parse(singleIcs);
      const comp = new ICAL.Component(parsed);
      const vevent = comp.getFirstSubcomponent('vevent');
      if (vevent) {
        vcalendar.addSubcomponent(vevent);
      }
    } catch (err) {
      console.warn('Kunne ikke eksportere enkelt VEVENT:', err);
    }
  }

  return vcalendar.toString();
}

