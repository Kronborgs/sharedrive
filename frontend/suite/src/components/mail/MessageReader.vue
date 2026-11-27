<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import DOMPurify from 'dompurify';
import SaveOfflineMail from './SaveOfflineMail.vue';
import {
  Reply,
  ReplyAll,
  Forward,
  Pencil,
  Trash2,
  Star,
  MailOpen,
  Paperclip,
  Download,
  ExternalLink,
  Calendar,
  CalendarPlus,
  Mail,
  Sun,
  Moon,
  Copy,
  Scissors,
  Filter,
  ShieldAlert,
  ShieldCheck,
  Image as ImageIcon,
  FileCode,
  UserPlus,
  CheckCircle2,
  AlertTriangle,
  ChevronLeft
} from 'lucide-vue-next';
import { useMailStore } from '../../stores/mailStore';
import { useSuiteStore } from '../../stores/suiteStore';
import { useCalendarStore } from '../../stores/calendarStore';
import { useContactsStore } from '../../stores/contactsStore';
import { useTheme } from '../../composables/useTheme';
import { apiFetchContactPhoto } from '../../services/carddavApi';
import { getAttachmentDownloadUrl, getEmlDownloadUrl } from '../../services/mailApi';
import { openMailAttachment, sharedriveAttachmentEditor } from '../../services/mailAttachments';
import type { MailAddress, MailAttachment } from '../../types/mail';

const props = defineProps<{
  showMobileBack?: boolean;
}>();

const emit = defineEmits<{
  (e: 'mobile-back'): void;
}>();

const store = useMailStore();
const suiteStore = useSuiteStore();
const calendarStore = useCalendarStore();
const contactsStore = useContactsStore();
const { currentTheme } = useTheme();

const preferPlainText = ref(false);
const allowRemoteImages = ref(false);
const remoteImages = ref(new Map<string, string>());
const loadingRemoteImages = ref(false);
const inviteCalendarId = ref('');
const isAddingInvite = ref(false);
const addedInviteToCalendar = ref(false);
const openingAttachment = ref('');

async function openAttachment(attachment: MailAttachment) {
  const message = msg.value;
  if (!message || openingAttachment.value) return;
  openingAttachment.value = attachment.id;
  try {
    const target = await openMailAttachment(message, attachment);
    window.location.assign(target);
  } catch (error) {
    suiteStore.notify('Kunne ikke åbne filen', error instanceof Error ? error.message : undefined, 'error');
  } finally {
    openingAttachment.value = '';
  }
}

const msg = computed(() => store.activeMessageDetail);
const offlineText = computed(() => {
  if (msg.value?.textBody?.trim()) return msg.value.textBody;
  const text = DOMPurify.sanitize(msg.value?.htmlBody ?? '', {
    ALLOWED_TAGS: ['br', 'div', 'p', 'li'],
    ALLOWED_ATTR: [],
    RETURN_DOM_FRAGMENT: true
  });
  text.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  text.querySelectorAll('div, p, li').forEach(node => node.after('\n'));
  return text.textContent?.trim() ?? '';
});
const isLightPaper = computed(() => store.readerThemeMode === 'LIGHT_PAPER');

watch(
  () => msg.value?.id,
  () => {
    preferPlainText.value = false;
    allowRemoteImages.value = false;
    remoteImages.value = new Map();
    loadingRemoteImages.value = false;
    addedInviteToCalendar.value = false;
    if (!inviteCalendarId.value && calendarStore.defaultWritableCalendar) {
      inviteCalendarId.value = calendarStore.defaultWritableCalendar.id;
    }
  }
);

watch(
  () => calendarStore.defaultWritableCalendar?.id,
  (calId) => {
    if (calId && !inviteCalendarId.value) {
      inviteCalendarId.value = calId;
    }
  },
  { immediate: true }
);

const primarySender = computed(() => msg.value?.from?.[0] || null);
const senderAlreadyInContacts = computed(() => {
  if (!primarySender.value?.address) return true;
  return contactsStore.hasContactWithEmail(primarySender.value.address);
});

const senderExistingContact = computed(() => {
  if (!primarySender.value?.address) return null;
  return contactsStore.findContactByEmail(primarySender.value.address);
});

const senderNameMatchContact = computed(() => {
  if (senderExistingContact.value || !primarySender.value?.name) return null;
  return contactsStore.findBestWritableNameMatch(primarySender.value.name);
});

const senderEmailImageCandidates = computed<string[]>(() => {
  const atts = msg.value?.attachments || [];
  const results: string[] = [];
  const seen = new Set<string>();
  for (const att of atts) {
    if (!att.contentBase64) continue;
    if (!/^image\/(jpeg|jpg|png|webp|gif)$/i.test(att.contentType || '')) continue;
    // Ignorér 1×1 tracking pixels eller kæmpe råfiler
    if (att.size > 0 && (att.size < 1500 || att.size > 3 * 1024 * 1024)) continue;
    const mime = (att.contentType || 'image/jpeg').split(';')[0].trim().toLowerCase();
    const dataUrl = `data:${mime};base64,${att.contentBase64}`;
    if (seen.has(dataUrl)) continue;
    seen.add(dataUrl);
    results.push(dataUrl);
    if (results.length >= 6) break;
  }
  return results;
});

const invite = computed(() => msg.value?.calendarInvite);
const inviteNotice = computed(() => {
  const method = invite.value?.method ?? invite.value?.rawIcs.match(/^METHOD:([A-Z]+)\s*$/im)?.[1]?.toUpperCase();
  if (invite.value?.cancelled || method === 'CANCEL') return 'Mødet er aflyst.';
  if (method === 'REPLY') return 'Beskeden indeholder et svar på mødet.';
  if (invite.value?.occurrenceUpdate) return 'Beskeden ændrer en enkelt forekomst i en mødeserie.';
  if (method && !['REQUEST', 'PUBLISH'].includes(method)) {
    return 'Beskeden indeholder en meddelelse om mødet.';
  }
  return '';
});
const existingInviteEvent = computed(() => {
  const uid = invite.value?.uid;
  if (!uid || inviteNotice.value || !invite.value?.canAddDirectly) return undefined;
  const matches = calendarStore.events.filter(event => event.uid === uid);
  return matches.find(event => Date.parse(event.end) >= Date.now()) ?? matches[0];
});
const inviteConflicts = computed(() => {
  const details = invite.value;
  if (!details?.start || inviteNotice.value) return [];
  return calendarStore.findConflictingEvents(details.start, details.end)
    .filter(event => !details.uid || event.uid !== details.uid);
});

function openInviteCalendar() {
  suiteStore.setActiveModule('calendar');
  const existing = existingInviteEvent.value;
  if (existing) calendarStore.openEditEventModal(existing);
}

function formatIcsDateLabel(raw?: string): string {
  if (!raw) return '';
  const compact = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  let dt: Date;
  if (compact) {
    const [, y, m, d, hh, mm, ss, z] = compact;
    dt = hh
      ? new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}${z || ''}`)
      : new Date(`${y}-${m}-${d}T00:00:00`);
  } else {
    dt = new Date(raw);
  }
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleString('da-DK', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function addInviteToCalendar() {
  const messageId = msg.value?.id;
  const details = invite.value;
  if (!details || inviteNotice.value || isAddingInvite.value) return;
  const targetCal =
    calendarStore.writableCalendars.find(calendar => calendar.id === inviteCalendarId.value)?.id ||
    calendarStore.defaultWritableCalendar?.id || '';
  if (!targetCal) {
    suiteStore.notify(
      'Ingen skrivbar kalender',
      'Åbn Kalender og vælg eller opret en skrivbar kalender først.',
      'warning'
    );
    return;
  }

  isAddingInvite.value = true;
  try {
    if (details.canAddDirectly) {
      const saved = await calendarStore.addCalendarInvitation(targetCal, details.rawIcs);
      if (msg.value?.id === messageId) addedInviteToCalendar.value = true;
      const title = saved.alreadyAdded ? 'Aftalen findes allerede' : 'Invitation tilføjet';
      suiteStore.notify(title, saved.event.title, 'success');
      return;
    }
    const imported = await calendarStore.importIcsFile(targetCal, details.rawIcs);
    if (msg.value?.id === messageId) addedInviteToCalendar.value = imported > 0;
  } catch (err: any) {
    suiteStore.notify(
      'Kunne ikke tilføje invitation',
      err?.message || 'Fejl ved import af .ics til CalDAV.',
      'error'
    );
  } finally {
    isAddingInvite.value = false;
  }
}

function parseCssRgb(colorStr: string): { r: number; g: number; b: number } | null {
  const c = colorStr.trim().toLowerCase();
  if (c === 'black' || c === '#000' || c === '#000000' || c === 'windowtext') {
    return { r: 0, g: 0, b: 0 };
  }
  if (c === 'white' || c === '#fff' || c === '#ffffff') {
    return { r: 255, g: 255, b: 255 };
  }
  const hex6 = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex6) {
    return {
      r: parseInt(hex6[1], 16),
      g: parseInt(hex6[2], 16),
      b: parseInt(hex6[3], 16)
    };
  }
  const hex3 = c.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (hex3) {
    return {
      r: parseInt(hex3[1] + hex3[1], 16),
      g: parseInt(hex3[2] + hex3[2], 16),
      b: parseInt(hex3[3] + hex3[3], 16)
    };
  }
  const rgbMatch = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    return {
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3])
    };
  }
  return null;
}

function getLuminance(rgb: { r: number; g: number; b: number }): number {
  return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

function secureImageUrl(value: string) {
  if (value.startsWith('//')) value = 'https:' + value;
  if (!/^https:\/\//i.test(value)) return '';
  return value;
}

function applySmartDarkModeContrastFix(cleanHtml: string): string {
  if (typeof DOMParser === 'undefined') return cleanHtml;

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${cleanHtml}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLElement | null;
  if (!root) return cleanHtml;

  const hasLightAncestorBg = (el: HTMLElement | null): boolean => {
    let curr: HTMLElement | null = el;
    while (curr && curr !== root) {
      const bgStyle = curr.style?.backgroundColor || curr.getAttribute('bgcolor') || '';
      if (bgStyle && bgStyle !== 'transparent' && bgStyle !== 'inherit') {
        const rgb = parseCssRgb(bgStyle);
        if (rgb && getLuminance(rgb) > 0.48) {
          return true;
        }
      }
      curr = curr.parentElement;
    }
    return false;
  };

  const allElements = root.querySelectorAll('*');
  allElements.forEach((node) => {
    const el = node as HTMLElement;

    if (el.tagName === 'IMG') {
      el.removeAttribute('srcset');
      const src = el.getAttribute('src') || '';
      if (/^(?:https?:)?\/\//i.test(src)) {
        const image = allowRemoteImages.value && remoteImages.value.get(secureImageUrl(src));
        if (image) el.setAttribute('src', image);
        else el.removeAttribute('src');
      }
    }

    if (!isLightPaper.value) {
      const inlineColor = el.style?.color || el.getAttribute('color') || '';
      if (inlineColor) {
        const rgb = parseCssRgb(inlineColor);
        if (rgb && getLuminance(rgb) < 0.38 && !hasLightAncestorBg(el)) {
          if (el.style?.color) {
            el.style.color = '#f1f5f9';
          }
          if (el.hasAttribute('color')) {
            el.setAttribute('color', '#f1f5f9');
          }
        }
      }
    }

    if (el.tagName === 'A' && el.getAttribute('href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });

  return root.innerHTML;
}

const remoteImageUrls = computed(() => {
  if (!msg.value?.htmlBody) return [];
  const sanitized = DOMPurify.sanitize(msg.value.htmlBody, { RETURN_DOM: true });
  return [...new Set(Array.from(sanitized.querySelectorAll('img[src]'), image =>
    secureImageUrl(image.getAttribute('src') || '')).filter(Boolean))].slice(0, 16);
});

async function toggleRemoteImages() {
  allowRemoteImages.value = !allowRemoteImages.value;
  if (!allowRemoteImages.value || remoteImages.value.size) return;
  const messageId = msg.value?.id;
  loadingRemoteImages.value = true;
  const images = await Promise.all(remoteImageUrls.value.map(async url => {
    try {
      const src = await apiFetchContactPhoto({ url });
      return src && /^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(src) ? [url, src] as const : null;
    } catch {
      return null;
    }
  }));
  if (msg.value?.id !== messageId) return;
  remoteImages.value = new Map(images.filter(entry => entry !== null));
  loadingRemoteImages.value = false;
  if (!remoteImages.value.size) {
    allowRemoteImages.value = false;
    suiteStore.notify('De eksterne billeder kunne ikke hentes', undefined, 'warning');
  }
}

const processedHtml = computed(() => {
  if (!msg.value?.htmlBody) return '';
  const clean = DOMPurify.sanitize(msg.value.htmlBody, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form']
  });
  return applySmartDarkModeContrastFix(clean);
});

const downloadableAttachments = computed(() => {
  if (!msg.value?.attachments) return [];
  return msg.value.attachments.filter((a) => !a.isInline);
});

const hasSharedriveAttachments = computed(() =>
  downloadableAttachments.value.some((attachment) => sharedriveAttachmentEditor(attachment.filename))
);

const imageAttachments = computed(() =>
  downloadableAttachments.value.filter((a) =>
    /^image\/(?:jpeg|png|gif|webp|avif|bmp)$/i.test(a.contentType)
  )
);

function toggleReaderTheme() {
  store.setReaderThemeMode(isLightPaper.value ? 'SMART_DARK' : 'LIGHT_PAPER');
}

function formatAddressList(list?: MailAddress[]): string {
  if (!list || list.length === 0) return '';
  return list
    .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
    .join(', ');
}

function formatFullDateTime(iso: string): string {
  const dt = new Date(iso);
  return dt.toLocaleString('da-DK', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function downloadIcsInvite() {
  if (!msg.value?.calendarInvite?.rawIcs) return;
  const blob = new Blob([msg.value.calendarInvite.rawIcs], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(msg.value.calendarInvite.summary || 'invitation').replace(/[^a-z0-9-_]/gi, '_')}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <main
    class="flex-1 flex flex-col min-w-0 h-full overflow-hidden transition-all duration-300"
    :class="
      currentTheme.wallpaper
        ? 'rounded-2xl border backdrop-blur-lg shadow-xl'
        : 'bg-slate-950'
    "
    :style="
      currentTheme.wallpaper
        ? { backgroundColor: currentTheme.gridBg, borderColor: currentTheme.border }
        : undefined
    "
  >
    <!-- Når ingen e-mail er åbnet -->
    <div
      v-if="!msg"
      class="flex-1 flex flex-col items-center justify-center p-8 text-center select-none"
    >
      <div class="w-14 h-14 rounded-2xl bg-slate-900/80 border border-white/10 flex items-center justify-center text-slate-500 mb-3">
        <Mail class="w-7 h-7" />
      </div>
      <h3 class="text-sm font-bold text-slate-200">Vælg en e-mail for at læse den</h3>
      <p class="text-xs text-slate-400 mt-1 max-w-sm">
        Brug piletasterne <kbd class="px-1.5 py-0.5 bg-black/40 border border-white/15 rounded text-slate-200">↑</kbd> / <kbd class="px-1.5 py-0.5 bg-black/40 border border-white/15 rounded text-slate-200">↓</kbd> til at bladre, eller tryk <kbd class="px-1.5 py-0.5 bg-black/40 border border-white/15 rounded text-slate-200">Ctrl+N</kbd> for at skrive en ny e-mail.
      </p>
    </div>

    <!-- Når en e-mail er valgt -->
    <template v-else>
      <div
        class="h-11 px-2.5 sm:px-4 border-b flex items-center justify-between gap-2 shrink-0 select-none overflow-x-auto"
        :class="currentTheme.wallpaper ? 'bg-black/25 border-white/10' : 'bg-slate-900/80 border-slate-800'"
      >
        <div class="flex items-center gap-1.5">
          <button
            v-if="props.showMobileBack"
            type="button"
            class="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 text-xs font-semibold shrink-0 transition"
            @click="emit('mobile-back')"
          >
            <ChevronLeft class="w-4 h-4" />
            <span>Tilbage</span>
          </button>

          <button
            v-if="store.isDraftMessage(msg)"
            type="button"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold shadow transition"
            title="Fortsæt med at skrive på denne kladde"
            @click="store.editDraftMessage(msg)"
          >
            <Pencil class="w-3.5 h-3.5" />
            <span>Redigér kladde</span>
          </button>

          <button
            type="button"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition"
            :class="
              store.isDraftMessage(msg)
                ? 'bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-medium'
                : 'dav-theme-btn'
            "
            title="Besvar"
            @click="store.openComposeModal('REPLY', msg)"
          >
            <Reply class="w-3.5 h-3.5" />
            <span>Besvar</span>
          </button>

          <button
            type="button"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition"
            title="Besvar alle"
            @click="store.openComposeModal('REPLY_ALL', msg)"
          >
            <ReplyAll class="w-3.5 h-3.5 text-blue-400" />
            <span class="hidden sm:inline">Besvar alle</span>
          </button>

          <button
            type="button"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition"
            title="Videresend"
            @click="store.openComposeModal('FORWARD', msg)"
          >
            <Forward class="w-3.5 h-3.5 text-emerald-400" />
            <span class="hidden sm:inline">Videresend</span>
          </button>

          <div class="h-4 w-px bg-slate-800 mx-0.5 hidden md:block"></div>

          <!-- Opret kalenderaftale direkte fra e-mail -->
          <button
            v-if="suiteStore.isAnyModuleEnabled('calendar')"
            type="button"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition"
            title="Opret en kalenderaftale ud fra denne e-mail"
            @click="suiteStore.createEventFromMail(msg)"
          >
            <CalendarPlus class="w-3.5 h-3.5 text-sky-400" />
            <span class="hidden xl:inline">Opret aftale</span>
          </button>

          <button
            type="button"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition"
            title="Opret Sieve-filterregel på Mailcow/SOGo ud fra denne afsender"
            @click="store.openSieveModal(msg)"
          >
            <Filter class="w-3.5 h-3.5 text-purple-400" />
            <span class="hidden lg:inline">Opret filter</span>
          </button>
        </div>

        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition"
            :class="isLightPaper
              ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
              : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'"
            :title="isLightPaper ? 'Aktiv: Lys papir-baggrund (Klik for Smart Dark Mode)' : 'Aktiv: Smart Dark Mode med auto-kontrast (Klik for Lys papir-baggrund)'"
            @click="toggleReaderTheme"
          >
            <Sun v-if="isLightPaper" class="w-3.5 h-3.5 text-amber-300" />
            <Moon v-else class="w-3.5 h-3.5 text-blue-400" />
            <span class="hidden xl:inline">{{ isLightPaper ? 'Lys baggrund' : 'Smart Dark' }}</span>
          </button>

          <button
            v-if="msg.htmlBody"
            type="button"
            class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
            :title="preferPlainText ? 'Vis formateret HTML' : 'Vis kun rå tekst'"
            @click="preferPlainText = !preferPlainText"
          >
            <FileCode class="w-3.5 h-3.5" :class="preferPlainText ? 'text-amber-400' : 'text-slate-400'" />
          </button>

          <button
            type="button"
            class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
            title="Kopiér til udklipsholder (Ctrl+C)"
            @click="store.copyOrCutSelection('COPY', [msg])"
          >
            <Copy class="w-3.5 h-3.5 text-emerald-400" />
          </button>
          <button
            type="button"
            class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
            title="Klip til udklipsholder (Ctrl+X)"
            @click="store.copyOrCutSelection('CUT', [msg])"
          >
            <Scissors class="w-3.5 h-3.5 text-amber-400" />
          </button>
          <button
            type="button"
            class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
            :title="msg.seen ? 'Markér som ulæst' : 'Markér som læst'"
            @click="store.toggleSeenForMessages([msg])"
          >
            <MailOpen class="w-3.5 h-3.5 text-blue-400" />
          </button>
          <button
            type="button"
            class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
            title="Stjernemarkér"
            @click="store.toggleFlaggedForMessages([msg])"
          >
            <Star
              class="w-3.5 h-3.5"
              :class="msg.flagged ? 'fill-amber-400 text-amber-400' : ''"
            />
          </button>
          <button
            type="button"
            class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition"
            :class="store.activeFolder?.specialUse === 'junk'
              ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-300'
              : 'bg-slate-800 hover:bg-orange-500/20 border-slate-700 hover:border-orange-500/40 text-slate-200 hover:text-orange-300'"
            :title="store.activeFolder?.specialUse === 'junk'
              ? 'Markér som Ikke-spam (flyt til Indbakke og træn Rspamd HAM)'
              : 'Markér som Spam (flyt til Spam-mappen så Rspamd lærer af det)'"
            @click="store.markMessagesAsSpam([msg])"
          >
            <ShieldCheck v-if="store.activeFolder?.specialUse === 'junk'" class="w-3.5 h-3.5 text-emerald-400" />
            <ShieldAlert v-else class="w-3.5 h-3.5 text-orange-400" />
            <span class="hidden lg:inline">
              {{ store.activeFolder?.specialUse === 'junk' ? 'Ikke spam' : 'Spam' }}
            </span>
          </button>

          <button
            type="button"
            class="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 border border-slate-700 hover:border-rose-500/40 text-slate-300 hover:text-rose-300 transition"
            title="Flyt til papirkurv (Del) • Hold Shift for permanent sletning (Shift+Del)"
            @click="store.deleteSelectedMessages([msg], $event.shiftKey)"
          >
            <Trash2 class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <!-- Besked-hoved -->
      <div class="px-5 py-3.5 bg-slate-900/40 border-b border-slate-800 space-y-2 shrink-0">
        <div class="flex items-start justify-between gap-4">
          <h1 class="text-base sm:text-lg font-bold text-slate-100 leading-snug break-words">
            {{ msg.subject }}
          </h1>
          <span class="text-xs text-slate-400 whitespace-nowrap shrink-0">
            {{ formatFullDateTime(msg.date) }}
          </span>
        </div>

        <div class="space-y-1 text-xs">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-slate-500 font-medium w-10 shrink-0">Fra:</span>
            <span class="text-slate-100 font-semibold break-all">
              {{ formatAddressList(msg.from) }}
            </span>
            <template v-if="primarySender?.address && suiteStore.isAnyModuleEnabled('contacts') && !senderAlreadyInContacts">
              <button
                v-if="senderNameMatchContact"
                type="button"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/45 text-blue-200 text-[10.5px] font-semibold transition"
                :title="`Tilføj e-mailen og evt. foto til eksisterende kontakt '${senderNameMatchContact.fullName}'`"
                @click="
                  suiteStore.mergeSenderIntoContact(
                    senderNameMatchContact,
                    primarySender.name,
                    primarySender.address,
                    senderEmailImageCandidates
                  )
                "
              >
                <UserPlus class="w-3 h-3" />
                <span>Flet med {{ senderNameMatchContact.fullName }}</span>
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 text-[10.5px] font-semibold transition"
                :title="
                  senderNameMatchContact
                    ? 'Opret som ny kontakt eller vælg en anden kontakt at flette med'
                    : 'Gem som ny kontakt eller tilføj til eksisterende kontakt i CardDAV'
                "
                @click="
                  suiteStore.saveSenderAsContact(
                    primarySender.name,
                    primarySender.address,
                    senderEmailImageCandidates
                  )
                "
              >
                <UserPlus class="w-3 h-3" />
                <span>{{ senderNameMatchContact ? 'Ny / anden kontakt' : 'Gem / Flet i kontakter' }}</span>
              </button>
            </template>
          </div>
          <div class="flex items-baseline gap-2">
            <span class="text-slate-500 font-medium w-10 shrink-0">Til:</span>
            <span class="text-slate-300 break-all">
              {{ formatAddressList(msg.to) }}
            </span>
          </div>
          <div v-if="msg.cc && msg.cc.length > 0" class="flex items-baseline gap-2">
            <span class="text-slate-500 font-medium w-10 shrink-0">Kopi:</span>
            <span class="text-slate-400 break-all">
              {{ formatAddressList(msg.cc) }}
            </span>
          </div>
          <div v-if="msg.bcc && msg.bcc.length > 0" class="flex items-baseline gap-2">
            <span class="text-slate-500 font-medium w-10 shrink-0">Bcc:</span>
            <span class="text-slate-400 break-all">
              {{ formatAddressList(msg.bcc) }}
            </span>
          </div>
        </div>

        <!-- Kladde-handlingsbjælke -->
        <div
          v-if="store.isDraftMessage(msg)"
          class="px-3.5 py-2 rounded-xl bg-amber-500/15 border border-amber-400/35 flex flex-wrap items-center justify-between gap-2 text-xs"
        >
          <span class="flex items-center gap-2 text-amber-200 font-medium">
            <Pencil class="w-3.5 h-3.5 text-amber-300 shrink-0" />
            <span>Dette er en gemt kladde — du kan fortsætte med at redigere og sende den.</span>
          </span>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="px-3 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-[11px] transition"
              @click="store.editDraftMessage(msg)"
            >
              Fortsæt redigering
            </button>
            <button
              type="button"
              class="px-2.5 py-1 rounded-lg bg-black/25 hover:bg-rose-500/25 border border-white/15 hover:border-rose-400/40 text-slate-200 hover:text-rose-200 font-medium text-[11px] transition"
              @click="store.deleteSelectedMessages([msg], $event.shiftKey)"
            >
              Kassér
            </button>
          </div>
        </div>

        <!-- Eksterne billeder kontrolbjælke -->
        <div
          v-if="remoteImageUrls.length && !preferPlainText"
          class="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-between gap-2 text-[11px]"
        >
          <span class="flex items-center gap-1.5 text-slate-400">
            <ShieldAlert class="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>{{ allowRemoteImages ? 'Eksterne billeder vises i denne e-mail' : 'Eksterne billeder er skjult mod tracking' }}</span>
          </span>
          <button
            type="button"
            class="text-blue-400 hover:text-blue-300 font-semibold"
            @click="toggleRemoteImages()"
            :disabled="loadingRemoteImages"
          >
            {{ loadingRemoteImages ? 'Henter billeder…' : allowRemoteImages ? 'Skjul eksterne billeder' : 'Vis eksterne billeder' }}
          </button>
        </div>

        <!-- Kalender-invitation (.ics) med direkte CalDAV konflikt-tjek & 1-kliks import -->
        <div
          v-if="msg.calendarInvite"
          class="p-3 rounded-xl bg-blue-600/15 border border-blue-500/40 flex flex-wrap items-center justify-between gap-3"
        >
          <div class="flex items-start gap-2.5 min-w-0 flex-1">
            <div class="w-8 h-8 rounded-lg bg-blue-600/30 flex items-center justify-center text-blue-300 shrink-0 mt-0.5">
              <Calendar class="w-4 h-4" />
            </div>
            <div class="min-w-0 space-y-0.5">
              <div class="text-xs font-bold text-slate-100 truncate">
                {{ inviteNotice ? 'Kalendermeddelelse' : 'Kalenderinvitation' }} · {{ msg.calendarInvite.summary }}
              </div>
              <p v-if="inviteNotice" class="text-xs text-amber-300">{{ inviteNotice }}</p>
              <div class="text-[11px] text-blue-200 truncate">
                <span v-if="msg.calendarInvite.start">{{ formatIcsDateLabel(msg.calendarInvite.start) }} • </span>
                <span v-if="msg.calendarInvite.location">{{ msg.calendarInvite.location }} • </span>
                <span v-if="msg.calendarInvite.organizer">Arrangør: {{ msg.calendarInvite.organizer }}</span>
              </div>
              <div
                v-if="suiteStore.isAnyModuleEnabled('calendar') && msg.calendarInvite.start && !inviteNotice"
                class="pt-0.5"
              >
                <span
                  v-if="inviteConflicts.length > 0"
                  class="inline-flex items-center gap-1 text-[10.5px] font-semibold text-amber-300"
                >
                  <AlertTriangle class="w-3 h-3 shrink-0" />
                  Konflikt med {{ inviteConflicts.length }} aftale(r): "{{ inviteConflicts[0].title }}"
                </span>
                <span
                  v-else-if="calendarStore.lastSyncedAt && !calendarStore.isSyncing"
                  class="inline-flex items-center gap-1 text-[10.5px] font-medium text-emerald-300"
                >
                  <CheckCircle2 class="w-3 h-3 shrink-0" />
                  Tidspunktet er ledigt i din kalender
                </span>
              </div>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <template v-if="suiteStore.isAnyModuleEnabled('calendar') && !inviteNotice">
              <button
                v-if="existingInviteEvent || addedInviteToCalendar"
                type="button"
                class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow transition"
                @click="openInviteCalendar"
              >
                <Calendar class="w-3.5 h-3.5" />
                <span>{{ existingInviteEvent ? 'Åbn aftalen i Kalender' : 'Åbn i Kalender' }}</span>
              </button>
              <template v-else-if="calendarStore.writableCalendars.length > 0">
              <select
                v-if="calendarStore.writableCalendars.length > 1"
                aria-label="Vælg kalender"
                v-model="inviteCalendarId"
                class="px-2 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-[11px] text-slate-200 focus:outline-none"
              >
                <option
                  v-for="cal in calendarStore.writableCalendars"
                  :key="cal.id"
                  :value="cal.id"
                >
                  {{ cal.name }}
                </option>
              </select>

              <button
                type="button"
                :disabled="isAddingInvite"
                class="px-3 py-1.5 rounded-lg dav-theme-btn text-xs font-semibold flex items-center gap-1.5 shadow transition disabled:opacity-50"
                @click="addInviteToCalendar"
              >
                <CalendarPlus class="w-3.5 h-3.5" />
                <span>{{ isAddingInvite ? 'Tilføjer…' : msg.calendarInvite.recurring && msg.calendarInvite.canAddDirectly ? 'Tilføj mødeserie' : 'Tilføj til kalender' }}</span>
              </button>
              </template>
            </template>

            <button
              type="button"
              class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1.5 transition"
              title="Download .ics fil"
              @click="downloadIcsInvite"
            >
              <Download class="w-3.5 h-3.5 text-blue-400" />
              <span>.ics</span>
            </button>
          </div>
        </div>

        <a
          :href="getEmlDownloadUrl(msg.folder, msg.uid)"
          class="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-blue-300"
          download
        >
          <Download class="h-3.5 w-3.5" />
          Eksportér mail (.eml)
        </a>

        <SaveOfflineMail v-if="suiteStore.isOnline && offlineText" :key="msg.id" :message="msg" :plain-body="offlineText" />

        <!-- Vedhæftede filer -->
        <div
          v-if="downloadableAttachments.length > 0"
          class="pt-2 border-t border-slate-800/80 flex flex-wrap items-center gap-2"
        >
          <span class="flex items-center gap-1 text-[11px] text-slate-400 font-medium">
            <Paperclip class="w-3.5 h-3.5 text-blue-400" />
            Vedhæftninger ({{ downloadableAttachments.length }}):
          </span>
          <p v-if="hasSharedriveAttachments" class="basis-full text-[11px] text-slate-400">
            Filer, der åbnes i en Sharedrive-editor, gemmes som en kopi i Mine filer.
          </p>
          <div
            v-for="att in downloadableAttachments"
            :key="att.id"
            class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
          >
            <button
              v-if="sharedriveAttachmentEditor(att.filename)"
              type="button"
              :disabled="Boolean(openingAttachment)"
              :title="`Gem en kopi af ${att.filename} i Mine filer og åbn den`"
              class="flex min-w-0 items-center gap-1 hover:text-blue-300 disabled:opacity-60"
              @click="openAttachment(att)"
            >
              <ExternalLink class="h-3 w-3 shrink-0 text-blue-400" />
              <span class="max-w-[180px] truncate">{{ openingAttachment === att.id ? 'Åbner…' : att.filename }}</span>
            </button>
            <a
              v-else
              :href="getAttachmentDownloadUrl(msg.folder, msg.uid, att.id, true)"
              target="_blank"
              rel="noopener noreferrer"
              class="max-w-[180px] truncate hover:text-blue-300"
            >{{ att.filename }}</a>
            <span class="text-[10px] text-slate-400">({{ formatBytes(att.size) }})</span>
            <a
              :href="getAttachmentDownloadUrl(msg.folder, msg.uid, att.id)"
              :aria-label="`Download ${att.filename}`"
              title="Download"
              class="rounded p-1 text-blue-400 hover:bg-slate-700"
            ><Download class="h-3 w-3" /></a>
          </div>
        </div>
      </div>

      <!-- Brødtekst -->
      <div class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
        <div
          v-if="store.isLoadingMessage"
          class="text-xs text-slate-400 animate-pulse"
        >
          Henter fuld besked fra IMAP-serveren...
        </div>

        <div
          v-if="msg.htmlBody && !preferPlainText"
          class="mail-html-body rounded-xl p-5 text-sm leading-relaxed overflow-x-auto transition-colors"
          :class="isLightPaper
            ? 'bg-white text-slate-900 shadow-inner border border-slate-200'
            : 'bg-slate-900/65 text-slate-100 border border-slate-800/90'"
          v-html="processedHtml"
        ></div>

        <pre
          v-else
          class="whitespace-pre-wrap font-sans text-sm leading-relaxed rounded-xl p-5 transition-colors"
          :class="isLightPaper
            ? 'bg-white text-slate-900 shadow-inner border border-slate-200'
            : 'bg-slate-900/50 text-slate-100 border border-slate-800/80'"
        >{{ msg.textBody || '(Tom besked)' }}</pre>

        <div v-if="imageAttachments.length > 0" class="pt-3 border-t border-slate-800 space-y-2">
          <div class="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
            <ImageIcon class="w-3.5 h-3.5 text-blue-400" />
            <span>Forhåndsvisning af vedhæftede billeder</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div
              v-for="imgAtt in imageAttachments"
              :key="imgAtt.id"
              class="p-2 rounded-xl bg-slate-900 border border-slate-800 space-y-1.5"
            >
              <img
                :src="getAttachmentDownloadUrl(msg.folder, msg.uid, imgAtt.id, true)"
                loading="lazy"
                :alt="imgAtt.filename"
                class="rounded-lg max-h-64 w-auto mx-auto object-contain"
              />
              <div class="text-[11px] text-slate-400 text-center truncate">
                {{ imgAtt.filename }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </main>
</template>
