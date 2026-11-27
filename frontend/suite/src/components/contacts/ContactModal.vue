<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import {
  X,
  Users,
  Plus,
  Trash2,
  Save,
  Star,
  Camera,
  ImagePlus,
  Search,
  Download,
  Check
} from 'lucide-vue-next';
import { useContactsStore } from '../../stores/contactsStore';
import { useSuiteStore } from '../../stores/suiteStore';
import { apiFetchContactPhoto } from '../../services/carddavApi';
import { processContactPhotoFile, processContactPhotoDataUrl } from '../../utils/contactPhoto';
import { getGravatarAvatarUrlForEmail, markGravatarFailed } from '../../utils/gravatar';
import type { Contact, ContactEmail, ContactPhone } from '../../types/contacts';

const store = useContactsStore();
const suiteStore = useSuiteStore();

const addressBookId = ref('');
const firstName = ref('');
const lastName = ref('');
const fullName = ref('');
const nickname = ref('');
const organization = ref('');
const title = ref('');
const emails = ref<ContactEmail[]>([]);
const phones = ref<ContactPhone[]>([]);
const birthday = ref('');
const anniversary = ref('');
const anniversaryLabel = ref('Bryllupsdag');
const street = ref('');
const postalCode = ref('');
const city = ref('');
const country = ref('');
const categoriesText = ref('');
const website = ref('');
const notes = ref('');
const starred = ref(false);
const photoDataUrl = ref<string | null | undefined>(undefined);
const isProcessingPhoto = ref(false);
const isDraggingPhoto = ref(false);
const mergeSearchQuery = ref('');
const isFetchingGravatar = ref(false);

const isExisting = computed(() => Boolean(store.editingContact?.id));

const mergeCandidates = computed<Contact[]>(() => {
  if (!store.senderContext || isExisting.value) return [];
  return store.findMatchingWritableContacts(
    store.senderContext.senderName,
    mergeSearchQuery.value,
    5
  );
});

const senderEmailImages = computed<string[]>(() => store.senderContext?.emailImages || []);

const canSaveGravatarToCardDav = computed<boolean>(
  () => !photoDataUrl.value && Boolean(autoGravatarUrl.value)
);

watch(
  () => store.isContactModalOpen,
  (isOpen) => {
    if (!isOpen) {
      store.senderContext = null;
      mergeSearchQuery.value = '';
    }
  }
);

const previewInitials = computed(() => {
  const composed =
    fullName.value.trim() ||
    [firstName.value.trim(), lastName.value.trim()].filter(Boolean).join(' ').trim() ||
    organization.value.trim();
  if (!composed) return '?';
  const parts = composed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return composed.slice(0, 2).toUpperCase();
});

const autoGravatarUrl = computed(() => {
  if (photoDataUrl.value) return null;
  for (const em of emails.value) {
    const url = getGravatarAvatarUrlForEmail(em.value, 160);
    if (url) return url;
  }
  return null;
});

const effectivePreviewSrc = computed(() => photoDataUrl.value || autoGravatarUrl.value || null);

watch(
  () => store.editingContact,
  (c) => {
    if (!c) return;
    addressBookId.value = c.addressBookId || store.defaultWritableAddressBook?.id || '';
    firstName.value = c.firstName || '';
    lastName.value = c.lastName || '';
    fullName.value = c.fullName || '';
    nickname.value = c.nickname || '';
    organization.value = c.organization || '';
    title.value = c.title || '';
    emails.value =
      c.emails && c.emails.length > 0
        ? c.emails.map((e) => ({ ...e }))
        : [{ type: 'home', value: '', pref: true }];
    phones.value =
      c.phones && c.phones.length > 0
        ? c.phones.map((p) => ({ ...p }))
        : [{ type: 'mobile', value: '', pref: true }];
    birthday.value = c.birthday || '';
    anniversary.value = c.anniversary || '';
    anniversaryLabel.value = c.anniversaryLabel || 'Bryllupsdag';
    street.value = c.address?.street || '';
    postalCode.value = c.address?.postalCode || '';
    city.value = c.address?.city || '';
    const hasCoreAddr = Boolean(
      street.value.trim() || postalCode.value.trim() || city.value.trim()
    );
    country.value = hasCoreAddr ? c.address?.country || '' : '';
    categoriesText.value = (c.categories || []).join(', ');
    website.value = c.website || '';
    notes.value = c.notes || '';
    starred.value = Boolean(c.starred);
    photoDataUrl.value = c.photoDataUrl;
  },
  { immediate: true }
);

async function applyPhotoFile(file: File) {
  isProcessingPhoto.value = true;
  try {
    photoDataUrl.value = await processContactPhotoFile(file);
  } catch (err: any) {
    suiteStore.notify(
      'Billedfejl',
      err?.message || 'Kunne ikke indlæse det valgte billede.',
      'error'
    );
  } finally {
    isProcessingPhoto.value = false;
  }
}

function handlePhotoInput(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) {
    void applyPhotoFile(file);
  }
}

function handlePhotoDrop(e: DragEvent) {
  isDraggingPhoto.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    void applyPhotoFile(file);
  }
}

function removePhoto() {
  photoDataUrl.value = null;
}

function switchToExistingContact(target: Contact) {
  const ctx = store.senderContext;
  const senderEmail = ctx?.senderEmail || emails.value.find((e) => e.value.trim())?.value.trim() || '';
  if (!senderEmail && senderEmailImages.value.length === 0) return;
  store.openMergeSenderIntoContact(target, {
    fullName: ctx?.senderName || fullName.value,
    email: senderEmail,
    emailImages: senderEmailImages.value
  });
}

async function saveGravatarPhotoToCardDav() {
  const candidateEmail =
    emails.value.find((e) => Boolean(getGravatarAvatarUrlForEmail(e.value, 160)))?.value.trim() ||
    '';
  if (!candidateEmail) return;

  isFetchingGravatar.value = true;
  try {
    const fetched = await apiFetchContactPhoto({ email: candidateEmail });
    if (fetched) {
      photoDataUrl.value = fetched;
      suiteStore.notify(
        'Profilbillede hentet',
        'Billedet er indlæst i kontakten og gemmes i CardDAV, når du trykker Gem kontakt.',
        'success'
      );
    } else {
      suiteStore.notify(
        'Intet offentligt billede fundet',
        'Kunne ikke hente et billede fra Gravatar for denne e-mailadresse.',
        'info'
      );
    }
  } catch (err: any) {
    suiteStore.notify(
      'Billedhentning fejlede',
      err?.message || 'Kunne ikke hente profilbillede.',
      'error'
    );
  } finally {
    isFetchingGravatar.value = false;
  }
}

async function useEmailImageAsPhoto(rawDataUrl: string) {
  isProcessingPhoto.value = true;
  try {
    photoDataUrl.value = await processContactPhotoDataUrl(rawDataUrl, 256);
    suiteStore.notify(
      'Billede fra e-mail valgt',
      'Billedet er beskåret og klar til at blive gemt i kontakten.',
      'success'
    );
  } catch (err: any) {
    suiteStore.notify(
      'Billedfejl',
      err?.message || 'Kunne ikke bruge billedet fra e-mailen.',
      'error'
    );
  } finally {
    isProcessingPhoto.value = false;
  }
}

function addEmailRow() {
  emails.value.push({ type: 'work', value: '' });
}

function removeEmailRow(idx: number) {
  emails.value.splice(idx, 1);
  if (emails.value.length === 0) {
    emails.value.push({ type: 'home', value: '' });
  }
}

function addPhoneRow() {
  phones.value.push({ type: 'mobile', value: '' });
}

function removePhoneRow(idx: number) {
  phones.value.splice(idx, 1);
  if (phones.value.length === 0) {
    phones.value.push({ type: 'mobile', value: '' });
  }
}

async function handleSubmit() {
  const composedFull =
    fullName.value.trim() ||
    [firstName.value.trim(), lastName.value.trim()].filter(Boolean).join(' ').trim() ||
    organization.value.trim() ||
    emails.value.find((e) => e.value.trim())?.value.trim() ||
    '';

  if (!composedFull) return;

  const categories = categoriesText.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  await store.saveContact({
    id: store.editingContact?.id || '',
    uid: store.editingContact?.uid || '',
    addressBookId: addressBookId.value,
    fullName: composedFull,
    firstName: firstName.value.trim(),
    lastName: lastName.value.trim(),
    nickname: nickname.value.trim() || undefined,
    organization: organization.value.trim() || undefined,
    title: title.value.trim() || undefined,
    emails: emails.value.filter((e) => e.value.trim().length > 0),
    phones: phones.value.filter((p) => p.value.trim().length > 0),
    birthday: birthday.value.trim() || undefined,
    anniversary: anniversary.value.trim() || undefined,
    anniversaryLabel: anniversary.value.trim()
      ? anniversaryLabel.value.trim() || 'Bryllupsdag'
      : undefined,
    address:
      street.value.trim() || city.value.trim() || postalCode.value.trim()
        ? {
            street: street.value.trim(),
            city: city.value.trim(),
            postalCode: postalCode.value.trim(),
            country: country.value.trim()
          }
        : undefined,
    website: website.value.trim() || undefined,
    notes: notes.value.trim() || undefined,
    categories,
    starred: starred.value,
    photoDataUrl: photoDataUrl.value,
    vcardUrl: store.editingContact?.vcardUrl,
    etag: store.editingContact?.etag,
    rawVcard: store.editingContact?.rawVcard
  });
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.isContactModalOpen && store.editingContact"
      class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4"
      @click.self="store.isContactModalOpen = false"
    >
      <form
        class="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-none sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[100dvh] sm:h-auto sm:max-h-[92vh]"
        @submit.prevent="handleSubmit"
      >
        <!-- Fast Header med Annullér & Gem -->
        <div class="px-4 sm:px-5 py-3 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0 bg-slate-900">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400 shrink-0">
              <Users class="w-4 h-4" />
            </div>
            <h3 class="text-sm sm:text-base font-bold text-slate-100 truncate">
              {{ isExisting ? 'Redigér kontakt' : 'Opret ny kontakt' }}
            </h3>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              class="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
              @click="store.isContactModalOpen = false"
            >
              Annullér
            </button>
            <button
              type="submit"
              :disabled="store.isSaving"
              class="px-3.5 py-1.5 rounded-xl dav-theme-btn text-xs font-semibold flex items-center gap-1.5 shadow transition disabled:opacity-50"
            >
              <Save class="w-3.5 h-3.5" />
              <span>{{ store.isSaving ? 'Gemmer...' : 'Gem kontakt' }}</span>
            </button>
            <button
              type="button"
              class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
              title="Luk"
              @click="store.isContactModalOpen = false"
            >
              <X class="w-4 h-4" />
            </button>
          </div>
        </div>

        <div class="p-4 space-y-3 overflow-y-auto text-xs flex-1 min-h-0">
          <!-- Smart flette-hjælper ved oprettelse fra afsender i Mail -->
          <div
            v-if="store.senderContext && !isExisting"
            class="p-3.5 rounded-2xl bg-blue-500/10 border border-blue-400/30 space-y-2.5"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div class="text-xs font-bold text-blue-200">
                  Tilføj e-mailen til en eksisterende kontakt?
                </div>
                <p class="text-[11px] text-slate-300 mt-0.5">
                  Har du allerede oprettet personen (f.eks. kun med telefonnummer), kan du flette <strong class="text-white">{{ store.senderContext.senderEmail }}</strong> ind på det eksisterende kort.
                </p>
              </div>
            </div>

            <div class="relative flex items-center">
              <Search class="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
              <input
                v-model="mergeSearchQuery"
                type="text"
                placeholder="Søg eksisterende kontakt (navn, telefon, firma)..."
                class="w-full pl-8 pr-3 py-1.5 bg-slate-950/90 border border-slate-700/80 rounded-xl text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-400"
              />
            </div>

            <div v-if="mergeCandidates.length > 0" class="space-y-1.5 max-h-40 overflow-y-auto">
              <button
                v-for="cand in mergeCandidates"
                :key="cand.id"
                type="button"
                class="w-full px-3 py-2 rounded-xl bg-slate-900/90 hover:bg-blue-600/20 border border-slate-700/80 hover:border-blue-400/45 flex items-center justify-between gap-3 text-left transition"
                @click="switchToExistingContact(cand)"
              >
                <div class="min-w-0">
                  <div class="font-semibold text-slate-100 truncate">{{ cand.fullName }}</div>
                  <div class="text-[11px] text-slate-400 truncate">
                    {{
                      cand.phones[0]?.value ||
                      cand.emails[0]?.value ||
                      cand.organization ||
                      'Ingen telefon eller e-mail endnu'
                    }}
                  </div>
                </div>
                <span class="px-2.5 py-1 rounded-lg bg-blue-500/20 border border-blue-400/40 text-blue-200 text-[11px] font-semibold shrink-0">
                  Flet e-mail ind
                </span>
              </button>
            </div>
            <div v-else class="text-[11px] text-slate-400 italic">
              Ingen matchende eksisterende kontakter fundet — gem formularen nedenfor for at oprette som ny.
            </div>
          </div>

          <div
            v-else-if="store.senderContext && isExisting"
            class="p-3 rounded-2xl bg-emerald-500/12 border border-emerald-400/35 text-xs text-emerald-200 flex items-center gap-2"
          >
            <Check class="w-4 h-4 text-emerald-300 shrink-0" />
            <span>
              Opdaterer eksisterende kontakt —
              <strong v-if="store.senderContext.senderEmail">{{ store.senderContext.senderEmail }}</strong>
              {{ store.senderContext.senderEmail ? 'er tilføjet.' : 'klar til foto-opdatering.' }}
              Tryk <strong>Gem kontakt</strong> for at synkronisere til Mailcow.
            </span>
          </div>

          <!-- Kontaktbillede & Favorit -->
          <div
            class="p-3.5 rounded-2xl bg-slate-950/80 border transition flex flex-wrap items-center justify-between gap-4"
            :class="isDraggingPhoto ? 'border-blue-400 bg-blue-500/10' : 'border-slate-800'"
            @dragover.prevent="isDraggingPhoto = true"
            @dragleave.prevent="isDraggingPhoto = false"
            @drop.prevent="handlePhotoDrop"
          >
            <div class="flex items-center gap-3.5">
              <label
                class="group relative w-16 h-16 rounded-2xl bg-blue-600/25 border border-white/15 flex items-center justify-center text-lg font-bold text-white overflow-hidden shadow cursor-pointer shrink-0"
                title="Klik eller træk et billede hertil"
              >
                <img
                  v-if="effectivePreviewSrc"
                  :src="effectivePreviewSrc"
                  alt="Kontaktbillede"
                  referrerpolicy="no-referrer"
                  class="w-full h-full object-cover"
                  @error="markGravatarFailed(effectivePreviewSrc)"
                />
                <span v-else>{{ previewInitials }}</span>
                <span
                  class="absolute inset-0 bg-black/55 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity"
                >
                  <Camera class="w-4 h-4 text-white" />
                </span>
                <input
                  type="file"
                  accept="image/*"
                  class="hidden"
                  @change="handlePhotoInput"
                />
              </label>

              <div class="space-y-1.5">
                <div class="font-semibold text-slate-200">Kontaktbillede</div>
                <div class="flex flex-wrap items-center gap-2">
                  <label
                    class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-medium cursor-pointer transition"
                  >
                    <ImagePlus class="w-3.5 h-3.5 text-blue-400" />
                    <span>{{ isProcessingPhoto ? 'Behandler...' : photoDataUrl ? 'Skift billede' : 'Vælg billede' }}</span>
                    <input
                      type="file"
                      accept="image/*"
                      class="hidden"
                      @change="handlePhotoInput"
                    />
                  </label>
                  <button
                    v-if="photoDataUrl"
                    type="button"
                    class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-slate-900 hover:bg-rose-500/20 border border-slate-800 hover:border-rose-500/40 text-slate-400 hover:text-rose-300 transition"
                    @click="removePhoto"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                    <span>Fjern</span>
                  </button>
                </div>
                <p class="text-[10.5px] text-slate-500">
                  {{
                    photoDataUrl
                      ? 'Eget billede valgt — synkroniseres til CardDAV.'
                      : 'Henter automatisk offentligt profilbillede (hvis tilgængeligt), indtil du vælger eget.'
                  }}
                </p>

                <button
                  v-if="canSaveGravatarToCardDav"
                  type="button"
                  :disabled="isFetchingGravatar || isProcessingPhoto"
                  class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 border border-blue-400/40 text-blue-200 text-[11px] font-semibold transition disabled:opacity-50"
                  @click="saveGravatarPhotoToCardDav"
                >
                  <Download class="w-3.5 h-3.5" />
                  <span>{{ isFetchingGravatar ? 'Henter billede...' : 'Gem profilbillede i CardDAV' }}</span>
                </button>
              </div>
            </div>

            <button
              type="button"
              class="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border font-semibold transition"
              :class="
                starred
                  ? 'bg-amber-500/20 border-amber-400/50 text-amber-200'
                  : 'bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-300'
              "
              @click="starred = !starred"
            >
              <Star
                class="w-3.5 h-3.5"
                :class="starred ? 'fill-amber-400 text-amber-400' : 'text-amber-300'"
              />
              <span>{{ starred ? 'Favorit' : 'Markér som favorit' }}</span>
            </button>

            <div
              v-if="senderEmailImages.length > 0"
              class="w-full pt-2.5 border-t border-slate-800/80 space-y-1.5"
            >
              <div class="text-[11px] text-slate-400">
                Billeder fra e-mailen (klik for at bruge som kontaktbillede):
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-for="(imgUrl, idx) in senderEmailImages"
                  :key="idx"
                  type="button"
                  :disabled="isProcessingPhoto"
                  class="w-11 h-11 rounded-xl overflow-hidden border border-slate-700 hover:border-blue-400 transition bg-slate-900 shrink-0"
                  title="Brug dette billede som kontaktbillede"
                  @click="useEmailImageAsPhoto(imgUrl)"
                >
                  <img :src="imgUrl" alt="Billede fra e-mail" class="w-full h-full object-cover" />
                </button>
              </div>
            </div>
          </div>

          <!-- Adressebog (hvis flere skrivbare) -->
          <div v-if="store.writableAddressBooks.length > 1 && !isExisting">
            <label class="block text-slate-400 font-medium mb-1">Adressebog</label>
            <select
              v-model="addressBookId"
              class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
            >
              <option
                v-for="book in store.writableAddressBooks"
                :key="book.id"
                :value="book.id"
              >
                {{ book.name }}
              </option>
            </select>
          </div>

          <!-- Navn -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label class="block text-slate-400 font-medium mb-1">Fornavn</label>
              <input
                v-model="firstName"
                type="text"
                placeholder="F.eks. Anna"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label class="block text-slate-400 font-medium mb-1">Efternavn</label>
              <input
                v-model="lastName"
                type="text"
                placeholder="F.eks. Jensen"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label class="block text-slate-400 font-medium mb-1">Visningsnavn</label>
              <input
                v-model="fullName"
                type="text"
                placeholder="Udfyldes evt. automatisk"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <!-- Firma, Titel, Kaldenavn -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label class="block text-slate-400 font-medium mb-1">Firma / Organisation</label>
              <input
                v-model="organization"
                type="text"
                placeholder="Virksomhed..."
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label class="block text-slate-400 font-medium mb-1">Titel / Stilling</label>
              <input
                v-model="title"
                type="text"
                placeholder="Stilling..."
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label class="block text-slate-400 font-medium mb-1">Kaldenavn</label>
              <input
                v-model="nickname"
                type="text"
                placeholder="Evt. kaldenavn..."
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <!-- E-mails -->
          <div class="space-y-2 p-3 rounded-xl bg-slate-950/80 border border-slate-800">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-slate-200">E-mailadresser</span>
              <button
                type="button"
                class="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                @click="addEmailRow"
              >
                <Plus class="w-3 h-3" /> Tilføj e-mail
              </button>
            </div>
            <div
              v-for="(em, idx) in emails"
              :key="idx"
              class="flex items-center gap-2"
            >
              <select
                v-model="em.type"
                class="w-28 px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-200"
              >
                <option value="home">Privat</option>
                <option value="work">Arbejde</option>
                <option value="other">Anden</option>
              </select>
              <input
                v-model="em.value"
                type="email"
                placeholder="navn@eksempel.dk"
                class="flex-1 px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                class="p-2 text-slate-500 hover:text-rose-400"
                @click="removeEmailRow(idx)"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <!-- Telefonnumre -->
          <div class="space-y-2 p-3 rounded-xl bg-slate-950/80 border border-slate-800">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-slate-200">Telefonnumre</span>
              <button
                type="button"
                class="text-[11px] text-blue-400 hover:text-blue-300 flex items-center gap-1"
                @click="addPhoneRow"
              >
                <Plus class="w-3 h-3" /> Tilføj telefon
              </button>
            </div>
            <div
              v-for="(ph, idx) in phones"
              :key="idx"
              class="flex items-center gap-2"
            >
              <select
                v-model="ph.type"
                class="w-28 px-2.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-200"
              >
                <option value="mobile">Mobil</option>
                <option value="home">Privat</option>
                <option value="work">Arbejde</option>
                <option value="other">Anden</option>
              </select>
              <input
                v-model="ph.value"
                type="tel"
                placeholder="+45 12 34 56 78"
                class="flex-1 px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                class="p-2 text-slate-500 hover:text-rose-400"
                @click="removePhoneRow(idx)"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <!-- Fødselsdag & Mærkedag (Bryllupsdag m.v.) -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-400 font-medium mb-1">Fødselsdag (vises i kalender)</label>
              <input
                v-model="birthday"
                type="date"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
              />
            </div>
            <div>
              <div class="flex items-center justify-between gap-2 mb-1">
                <label class="text-slate-400 font-medium">Mærkedag (vises i kalender)</label>
                <input
                  v-model="anniversaryLabel"
                  type="text"
                  maxlength="40"
                  placeholder="Bryllupsdag"
                  title="Navn på mærkedag (f.eks. Bryllupsdag, Årsdag, Jubilæum)"
                  class="w-32 px-2 py-0.5 text-[11px] bg-slate-950 border border-slate-700 rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500 text-right"
                />
              </div>
              <input
                v-model="anniversary"
                type="date"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
              />
            </div>
          </div>

          <!-- Grupper / Tags & Hjemmeside -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-400 font-medium mb-1">Grupper / Tags (komma)</label>
              <input
                v-model="categoriesText"
                type="text"
                placeholder="Familie, Venner, Arbejde"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
              />
            </div>
            <div>
              <label class="block text-slate-400 font-medium mb-1">Hjemmeside</label>
              <input
                v-model="website"
                type="url"
                placeholder="https://..."
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
              />
            </div>
          </div>

          <!-- Adresse -->
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div class="sm:col-span-5">
              <label class="block text-slate-400 font-medium mb-1">Gade &amp; husnummer</label>
              <input
                v-model="street"
                type="text"
                placeholder="Vejnavn 12"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
              />
            </div>
            <div class="sm:col-span-2">
              <label class="block text-slate-400 font-medium mb-1">Postnr.</label>
              <input
                v-model="postalCode"
                type="text"
                placeholder="8000"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
              />
            </div>
            <div class="sm:col-span-3">
              <label class="block text-slate-400 font-medium mb-1">By</label>
              <input
                v-model="city"
                type="text"
                placeholder="Aarhus C"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
              />
            </div>
            <div class="sm:col-span-2">
              <label class="block text-slate-400 font-medium mb-1">Land</label>
              <input
                v-model="country"
                type="text"
                placeholder="Danmark"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
              />
            </div>
          </div>

          <!-- Noter -->
          <div>
            <label class="block text-slate-400 font-medium mb-1">Noter</label>
            <textarea
              v-model="notes"
              rows="2"
              placeholder="Valgfrie noter..."
              class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100"
            ></textarea>
          </div>
        </div>
      </form>
    </div>
  </Teleport>
</template>
