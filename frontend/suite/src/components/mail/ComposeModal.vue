<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import DOMPurify from 'dompurify';
import {
  Send,
  X,
  Paperclip,
  AtSign,
  Plus,
  Check,
  Save,
  Trash2,
  User,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link,
  Eraser,
  FileCode,
  MessagesSquare
} from 'lucide-vue-next';
import { useMailStore } from '../../stores/mailStore';
import { useContactsStore } from '../../stores/contactsStore';
import { conversationForMail, sharedriveRoomLink, useRoomSettings } from '../../services/roomLinks';
import RoomLinkPicker from '../shared/RoomLinkPicker.vue';

const store = useMailStore();
const contactsStore = useContactsStore();
const { settings: roomSettings } = useRoomSettings(() => store.isComposeModalOpen);
const showRoomPicker = ref(false);
const roomLinkInput = ref('');
const roomLink = computed(() => sharedriveRoomLink(roomLinkInput.value, window.location.origin));
const insertedRoomLinks = new Set<string>();
const preparingChat = ref(false);

const selectedAliasEmail = ref('');
const customAliasMode = ref(false);
const customFromEmail = ref('');
const customFromName = ref('');
const rememberNewAlias = ref(true);

const toInput = ref('');
const ccInput = ref('');
const bccInput = ref('');
const showCcBcc = ref(false);
const subject = ref('');
const activeAutocompleteField = ref<'to' | 'cc' | 'bcc' | null>(null);

const useRichHtml = ref(true);
const richEditorRef = ref<HTMLDivElement | null>(null);
const textBody = ref('');

let signatureBlock = '';
let quotedBody = '';

const inReplyTo = ref<string | undefined>(undefined);
const references = ref<string[]>([]);
const replyFolder = ref<string | undefined>(undefined);
const replyUid = ref<number | undefined>(undefined);
const draftRef = ref<{ folder: string; uid: number } | undefined>(undefined);

const maxAttachmentBytes = 18 * 1024 * 1024;
const isReadingAttachments = ref(false);
let composeSession = 0;

const attachments = ref<
  Array<{
    filename: string;
    contentType: string;
    contentBase64: string;
    size: number;
  }>
>([]);

const activeAliasObj = computed(() =>
  store.aliases.find(
    (a) => a.email.toLowerCase().trim() === selectedAliasEmail.value.toLowerCase().trim()
  )
);

function getActiveToken(raw: string): string {
  const parts = raw.split(/[,;]/);
  return (parts[parts.length - 1] || '').trim();
}

const autocompleteSuggestions = computed(() => {
  if (!activeAutocompleteField.value) return [];
  const val =
    activeAutocompleteField.value === 'to'
      ? toInput.value
      : activeAutocompleteField.value === 'cc'
        ? ccInput.value
        : bccInput.value;
  const token = getActiveToken(val);
  if (!token) return [];
  return contactsStore.searchContactsForAutocomplete(token, 7);
});

function selectAutocompleteContact(
  field: 'to' | 'cc' | 'bcc',
  item: { name: string; email: string }
) {
  const formatted = item.name ? `${item.name} <${item.email}>` : item.email;
  const current =
    field === 'to' ? toInput.value : field === 'cc' ? ccInput.value : bccInput.value;
  const lastSep = Math.max(current.lastIndexOf(','), current.lastIndexOf(';'));
  const prefix = lastSep >= 0 ? `${current.slice(0, lastSep + 1)} ` : '';
  const updated = `${prefix}${formatted}, `;

  if (field === 'to') toInput.value = updated;
  else if (field === 'cc') ccInput.value = updated;
  else bccInput.value = updated;

  activeAutocompleteField.value = null;
}

function handleAutocompleteBlur() {
  window.setTimeout(() => {
    activeAutocompleteField.value = null;
  }, 160);
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function plainTextToHtml(plain: string): string {
  return escapeHtml(plain).replace(/\n/g, '<br>');
}

function formatSignature(signature?: string) {
  return signature?.trim() ? `\n\n-- \n${signature.trimEnd()}` : '';
}

function formatEditorText(text: string) {
  let html = plainTextToHtml(text);
  const links = new Set(insertedRoomLinks);
  const fileUrl = store.composePrefill?.sharedFileUrl;
  if (fileUrl) links.add(fileUrl);
  for (const url of links) {
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;
    html = html.replace(escapeHtml(url), () => link.outerHTML);
  }
  return html;
}

function renderEditorBody() {
  const suffix = signatureBlock + quotedBody;
  if (draftRef.value || !textBody.value.endsWith(suffix)) return formatEditorText(textBody.value);
  const body = textBody.value.slice(0, textBody.value.length - suffix.length);
  return formatEditorText(body) +
    `<span data-mail-signature>${plainTextToHtml(signatureBlock)}</span>` +
    plainTextToHtml(quotedBody);
}

function replaceComposerSignature(signature?: string) {
  if (draftRef.value) return;
  const replacement = formatSignature(signature);
  if (replacement === signatureBlock) return;

  if (useRichHtml.value) {
    const block = richEditorRef.value?.querySelector('span[data-mail-signature]');
    if (!block || block.innerHTML !== plainTextToHtml(signatureBlock)) return;
    block.innerHTML = plainTextToHtml(replacement);
  } else {
    const suffix = signatureBlock + quotedBody;
    if (!textBody.value.endsWith(suffix)) return;
    textBody.value = textBody.value.slice(0, textBody.value.length - suffix.length) + replacement + quotedBody;
  }
  signatureBlock = replacement;
}

watch(
  () => customAliasMode.value ? undefined : activeAliasObj.value?.signature,
  (signature) => {
    if (store.isComposeModalOpen) replaceComposerSignature(signature);
  }
);

function htmlToPlainText(html: string, trim = true): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n');
  const text = tmp.textContent || tmp.innerText || '';
  return trim ? text.trim() : text;
}

function extractEditableDraftHtml(rawHtml: string): string {
  const clean = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form']
  });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  const firstChild = doc.body.firstElementChild as HTMLElement | null;
  if (
    firstChild &&
    doc.body.children.length === 1 &&
    firstChild.tagName === 'DIV' &&
    firstChild.getAttribute('style')?.includes('font-family:')
  ) {
    return firstChild.innerHTML;
  }
  return doc.body.innerHTML;
}

function formatDraftAddresses(list?: Array<{ name: string; address: string }>): string {
  if (!list || list.length === 0) return '';
  return list
    .filter((a) => Boolean(a.address?.trim()))
    .map((a) => {
      const cleanName = (a.name || '').replace(/[,;"]/g, ' ').replace(/\s+/g, ' ').trim();
      const cleanAddr = a.address.trim();
      return cleanName ? `${cleanName} <${cleanAddr}>` : cleanAddr;
    })
    .join(', ');
}

function detectBestAliasForMessage(): string {
  const src = store.composeSourceMessage;
  if (src && store.composeMode !== 'NEW') {
    const recipientEmails = [...(src.to || []), ...(src.cc || [])].map((a) =>
      a.address.toLowerCase().trim()
    );
    const matched = store.aliases.find((alias) =>
      recipientEmails.includes(alias.email.toLowerCase().trim())
    );
    if (matched) return matched.email;
  }
  return store.defaultAlias?.email || store.username || '';
}

watch(
  () =>
    [
      store.isComposeModalOpen,
      store.composeMode,
      store.composeSourceMessage,
      store.composePrefill
    ] as const,
  async ([isOpen]) => {
    composeSession++;
    isReadingAttachments.value = false;
    showRoomPicker.value = false;
    roomLinkInput.value = '';
    insertedRoomLinks.clear();
    if (!isOpen) return;

    customAliasMode.value = false;
    customFromEmail.value = '';
    attachments.value = [];
    activeAutocompleteField.value = null;
    draftRef.value = undefined;

    const bestEmail = detectBestAliasForMessage();
    selectedAliasEmail.value = bestEmail;
    const aliasObj = store.aliases.find(
      (a) => a.email.toLowerCase().trim() === bestEmail.toLowerCase().trim()
    );
    customFromName.value = aliasObj?.displayName || '';

    const src = store.composeSourceMessage;
    const mode = store.composeMode;
    const prefill = store.composePrefill;
    signatureBlock = formatSignature(aliasObj?.signature);
    quotedBody = '';
    let initialRichHtml: string | null = null;

    if (src && mode === 'DRAFT') {
      draftRef.value = { folder: src.folder, uid: src.uid };

      const draftSender = src.from?.[0];
      if (draftSender?.address) {
        const senderLower = draftSender.address.toLowerCase().trim();
        const matchedAlias = store.aliases.find(
          (a) => a.email.toLowerCase().trim() === senderLower
        );
        if (matchedAlias || senderLower === store.username.toLowerCase().trim()) {
          selectedAliasEmail.value = matchedAlias ? matchedAlias.email : draftSender.address.trim();
          customFromName.value = draftSender.name || matchedAlias?.displayName || '';
        } else {
          customAliasMode.value = true;
          customFromEmail.value = draftSender.address.trim();
          customFromName.value = draftSender.name || '';
        }
      }

      toInput.value = formatDraftAddresses(src.to);
      ccInput.value = formatDraftAddresses(src.cc);
      bccInput.value = formatDraftAddresses(src.bcc);
      showCcBcc.value = Boolean(ccInput.value.length > 0 || bccInput.value.length > 0);
      subject.value =
        src.subject === '(Kladde uden emne)' || src.subject === '(Intet emne)'
          ? ''
          : src.subject || '';
      textBody.value = src.textBody || '';
      if (src.htmlBody?.trim()) {
        initialRichHtml = extractEditableDraftHtml(src.htmlBody);
        if (!textBody.value.trim()) {
          textBody.value = htmlToPlainText(initialRichHtml);
        }
      }

      // Restore links inserted by this composer when reopening a saved draft.
      const draftText = textBody.value || (initialRichHtml ? htmlToPlainText(initialRichHtml) : '');
      for (const line of draftText.split('\n')) {
        const match = line.match(/^Deltag i Sharedrive-chatten:\s*(\S+)/);
        const url = match && sharedriveRoomLink(match[1], window.location.origin);
        if (url) insertedRoomLinks.add(url);
      }

      inReplyTo.value = src.inReplyTo;
      references.value = src.references || [];
      replyFolder.value = undefined;
      replyUid.value = undefined;

      attachments.value = (src.attachments || [])
        .filter((a) => !a.isInline && Boolean(a.contentBase64))
        .map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          contentBase64: a.contentBase64 as string,
          size: a.size
        }));
    } else if (!src || mode === 'NEW') {
      toInput.value = prefill?.to?.join(', ') || '';
      ccInput.value = prefill?.cc?.join(', ') || '';
      bccInput.value = prefill?.bcc?.join(', ') || '';
      showCcBcc.value = ccInput.value.length > 0 || bccInput.value.length > 0;
      subject.value = prefill?.subject || '';
      const initialBody = prefill?.textBody || '';
      textBody.value = initialBody || signatureBlock ? `${initialBody}\n${signatureBlock}` : '';
      inReplyTo.value = undefined;
      references.value = [];
      replyFolder.value = undefined;
      replyUid.value = undefined;
    } else {
      const quotedDate = new Date(src.date).toLocaleString('da-DK');
      const quotedSender = src.from[0]
        ? src.from[0].name
          ? `${src.from[0].name} <${src.from[0].address}>`
          : src.from[0].address
        : 'Afsender';
      const quotedText = (src.textBody || '')
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');

      if (mode === 'REPLY' || mode === 'REPLY_ALL') {
        const replyTarget = src.replyTo && src.replyTo.length > 0 ? src.replyTo : src.from;
        toInput.value = replyTarget.map((a) => a.address).join(', ');

        if (mode === 'REPLY_ALL') {
          const myEmails = new Set(store.aliases.map((a) => a.email.toLowerCase().trim()));
          myEmails.add(store.username.toLowerCase().trim());
          const extraCc = [...(src.to || []), ...(src.cc || [])]
            .map((a) => a.address)
            .filter(
              (addr) =>
                addr && !myEmails.has(addr.toLowerCase().trim()) && !toInput.value.includes(addr)
            );
          ccInput.value = Array.from(new Set(extraCc)).join(', ');
          showCcBcc.value = ccInput.value.length > 0;
        } else {
          ccInput.value = '';
          showCcBcc.value = false;
        }

        bccInput.value = '';
        subject.value = /^re:/i.test(src.subject) ? src.subject : `Re: ${src.subject}`;
        quotedBody = `\n\nDen ${quotedDate} skrev ${quotedSender}:\n${quotedText}`;
        textBody.value = `\n${signatureBlock}${quotedBody}`;
        inReplyTo.value = src.messageId;
        references.value = Array.from(new Set([...(src.references || []), src.messageId]));
        replyFolder.value = src.folder;
        replyUid.value = src.uid;
      } else if (mode === 'FORWARD') {
        toInput.value = '';
        ccInput.value = '';
        bccInput.value = '';
        showCcBcc.value = false;
        subject.value = /^fwd?:/i.test(src.subject) ? src.subject : `Fwd: ${src.subject}`;
        quotedBody = `\n\n---------- Videresendt besked ----------\nFra: ${quotedSender}\nDato: ${quotedDate}\nEmne: ${src.subject}\nTil: ${(src.to || []).map((a) => a.address).join(', ')}\n\n${src.textBody || ''}`;
        textBody.value = `\n${signatureBlock}${quotedBody}`;
        inReplyTo.value = undefined;
        references.value = [];
        replyFolder.value = undefined;
        replyUid.value = undefined;
      }
    }

    await nextTick();
    if (useRichHtml.value && richEditorRef.value) {
      richEditorRef.value.innerHTML =
        initialRichHtml ?? renderEditorBody();
    }
  },
  { immediate: true }
);

function execFormat(command: string, value?: string) {
  if (!richEditorRef.value) return;
  richEditorRef.value.focus();
  document.execCommand(command, false, value);
}

function promptInsertLink() {
  const url = window.prompt('Indtast link-URL (f.eks. https://...):', 'https://');
  if (url && url.trim()) {
    execFormat('createLink', url.trim());
  }
}

async function prepareConversationLink(url: string): Promise<string> {
  const path = new URL(url).pathname;
  const match = path.match(/^\/rooms\/direct\/([a-f0-9-]+)\/?$/i);
  if (!match) return url;
  const emails = [...parseEmailList(toInput.value), ...parseEmailList(ccInput.value)];
  if (!emails.length) throw new Error('Angiv mindst én modtager i Til eller Cc først.');
  const result = await conversationForMail(match[1], emails);
  if (result.failed_invitations.length) {
    store.notify('Invitation kunne ikke sendes', `Disse modtagere mangler en invitation: ${result.failed_invitations.join(', ')}.`, 'warning');
  }
  return sharedriveRoomLink('/rooms/direct/' + result.conversation.id, window.location.origin);
}

async function insertRoomLink() {
  let url = roomLink.value;
  if (!roomSettings.value?.rooms_enabled || !url || preparingChat.value) return;
  preparingChat.value = true;
  try { url = await prepareConversationLink(url); }
  catch (error) { store.notify('Chatten kunne ikke klargøres', error instanceof Error ? error.message : 'Prøv igen.', 'error'); return; }
  finally { preparingChat.value = false; }
  if (!url) return;
  insertedRoomLinks.add(url);

  if (useRichHtml.value && richEditorRef.value) {
    const editor = richEditorRef.value;
    const line = document.createElement('div');
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;
    line.append('Deltag i Sharedrive-chatten: ', link);
    const signature = editor.querySelector('[data-mail-signature]');
    if (signature) signature.before(line);
    else editor.append(line);
    editor.focus();
  } else {
    const suffix = signatureBlock + quotedBody;
    const offset = textBody.value.endsWith(suffix) ? textBody.value.length - suffix.length : textBody.value.length;
    const before = textBody.value.slice(0, offset).trimEnd();
    textBody.value = (before ? before + '\n\n' : '') + 'Deltag i Sharedrive-chatten: ' + url + textBody.value.slice(offset);
  }
  roomLinkInput.value = '';
  showRoomPicker.value = false;
}

async function toggleEditorMode() {
  if (useRichHtml.value && richEditorRef.value) {
    textBody.value = htmlToPlainText(richEditorRef.value.innerHTML, false);
    useRichHtml.value = false;
  } else {
    useRichHtml.value = true;
    await nextTick();
    if (richEditorRef.value) {
      richEditorRef.value.innerHTML = renderEditorBody();
    }
  }
}

function onAliasSelectChange() {
  if (selectedAliasEmail.value === '__CUSTOM__') {
    customAliasMode.value = true;
    customFromEmail.value = '';
    return;
  }
  customAliasMode.value = false;
  const found = activeAliasObj.value;
  if (found) {
    customFromName.value = found.displayName || '';
  }
}

async function quickSaveCustomAlias() {
  const email = customFromEmail.value.trim();
  if (!email || !email.includes('@')) return;
  const ok = await store.saveAlias({
    email,
    displayName: customFromName.value.trim()
  });
  if (ok) {
    selectedAliasEmail.value = email;
    customAliasMode.value = false;
  }
}

function parseEmailList(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function encodeAttachment(file: File) {
  return new Promise<(typeof attachments.value)[number]>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      contentBase64: String(reader.result).split(',', 2)[1] || '',
      size: file.size
    });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length || isReadingAttachments.value) return;

  const total = [...attachments.value, ...files].reduce((sum, file) => sum + file.size, 0);
  if (total > maxAttachmentBytes) {
    store.notify('Vedhæftningerne er for store', 'Du kan vedhæfte op til 18 MiB i alt pr. mail.', 'warning');
    return;
  }

  const session = composeSession;
  isReadingAttachments.value = true;
  try {
    const loaded = await Promise.all(files.map(encodeAttachment));
    if (session === composeSession) attachments.value.push(...loaded);
  } catch {
    if (session === composeSession) store.notify('Kunne ikke læse vedhæftningerne', undefined, 'error');
  } finally {
    if (session === composeSession) isReadingAttachments.value = false;
  }
}

function removeAttachment(idx: number) {
  attachments.value.splice(idx, 1);
}

function collectEditorContent(): { text: string; html?: string } {
  if (useRichHtml.value && richEditorRef.value) {
    const rawHtml = richEditorRef.value.innerHTML.replaceAll(' data-mail-signature=""', '');
    return {
      text: htmlToPlainText(rawHtml),
      html: `<div style="font-family: Inter, system-ui, -apple-system, sans-serif; font-size: 14px; line-height: 1.5;">${rawHtml}</div>`
    };
  }
  return {
    text: textBody.value,
    html: undefined
  };
}

function handleComposeKeyDown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!store.isSendingMail) {
      void handleSubmitSend();
    }
  }
}

async function handleSubmitSend() {
  if (isReadingAttachments.value || preparingChat.value) return;
  const fromEmail = customAliasMode.value
    ? customFromEmail.value.trim()
    : selectedAliasEmail.value.trim() || store.username;

  if (!fromEmail || !fromEmail.includes('@')) {
    store.notify('Mangler afsender', 'Vælg eller indtast en gyldig afsenderadresse (alias).', 'warning');
    return;
  }

  const toList = parseEmailList(toInput.value);
  if (toList.length === 0) {
    store.notify('Mangler modtager', 'Angiv mindst én modtager i feltet "Til".', 'warning');
    return;
  }

  preparingChat.value = true;
  try {
    for (const oldUrl of [...insertedRoomLinks]) {
      const currentContent = collectEditorContent();
      if (!currentContent.text.includes(oldUrl) && !currentContent.html?.includes(oldUrl)) {
        insertedRoomLinks.delete(oldUrl);
        continue;
      }
      const newUrl = await prepareConversationLink(oldUrl);
      if (newUrl && newUrl !== oldUrl) {
        if (richEditorRef.value) {
          richEditorRef.value.querySelectorAll('a').forEach(anchor => {
            if (anchor.href === oldUrl) { anchor.href = newUrl; anchor.textContent = newUrl; }
          });
        }
        textBody.value = textBody.value.split(oldUrl).join(newUrl);
        insertedRoomLinks.delete(oldUrl);
        insertedRoomLinks.add(newUrl);
      }
    }
  } catch (error) {
    store.notify('Chatten kunne ikke klargøres', error instanceof Error ? error.message : 'Prøv igen.', 'error');
    return;
  } finally { preparingChat.value = false; }

  const content = collectEditorContent();

  await store.sendMail({
    fromEmail,
    fromName: customFromName.value.trim() || undefined,
    saveAlias: customAliasMode.value ? rememberNewAlias.value : true,
    to: toList,
    cc: parseEmailList(ccInput.value),
    bcc: parseEmailList(bccInput.value),
    subject: subject.value.trim() || '(Intet emne)',
    textBody: content.text,
    htmlBody: content.html,
    inReplyTo: inReplyTo.value,
    references: references.value,
    replyFolder: replyFolder.value,
    replyUid: replyUid.value,
    replaceDraft: draftRef.value,
    attachments: attachments.value.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      contentBase64: a.contentBase64
    }))
  });
}

async function handleSaveDraft() {
  if (isReadingAttachments.value) return;
  const fromEmail = customAliasMode.value
    ? customFromEmail.value.trim() || store.username
    : selectedAliasEmail.value.trim() || store.username;

  const content = collectEditorContent();

  await store.saveDraft({
    fromEmail,
    fromName: customFromName.value.trim() || undefined,
    to: parseEmailList(toInput.value),
    cc: parseEmailList(ccInput.value),
    bcc: parseEmailList(bccInput.value),
    subject: subject.value.trim() || '(Kladde uden emne)',
    textBody: content.text,
    htmlBody: content.html,
    inReplyTo: inReplyTo.value,
    references: references.value,
    replaceDraft: draftRef.value,
    attachments: attachments.value.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      contentBase64: a.contentBase64
    }))
  });
}

async function handleDiscardDraft() {
  const src = store.composeSourceMessage;
  store.isComposeModalOpen = false;
  if (src && draftRef.value) {
    await store.deleteSelectedMessages([src], false);
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="store.isComposeModalOpen"
      class="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-0 sm:p-5"
      @click.self="store.isComposeModalOpen = false"
    >
      <div class="w-full max-w-3xl bg-slate-900 border border-slate-700 rounded-none sm:rounded-2xl shadow-2xl flex flex-col h-[100dvh] sm:h-auto sm:max-h-[92vh] overflow-hidden">
        <!-- Header -->
        <div class="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-lg bg-blue-600/20 border border-blue-500/40 flex items-center justify-center text-blue-400">
              <Send class="w-4 h-4" />
            </div>
            <div>
              <h3 class="text-sm font-bold text-slate-100">
                {{
                  store.composeMode === 'DRAFT'
                    ? 'Redigér kladde'
                    : store.composeMode === 'REPLY'
                      ? 'Besvar e-mail'
                      : store.composeMode === 'REPLY_ALL'
                        ? 'Besvar alle'
                        : store.composeMode === 'FORWARD'
                          ? 'Videresend e-mail'
                          : 'Skriv ny e-mail'
                }}
              </h3>
              <p class="text-[11px] text-slate-400">
                Vælg afsender-alias og søg direkte blandt dine Mailcow-kontakter
              </p>
            </div>
          </div>

          <button
            type="button"
            class="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200"
            @click="store.isComposeModalOpen = false"
          >
            <X class="w-4 h-4" />
          </button>
        </div>

        <form
          class="flex-1 overflow-y-auto p-5 space-y-3.5 text-xs"
          @submit.prevent="handleSubmitSend"
          @keydown="handleComposeKeyDown"
        >
          <!-- Afsender-Alias -->
          <div class="p-3 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2.5">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <label class="flex items-center gap-1.5 text-slate-300 font-semibold">
                <AtSign class="w-3.5 h-3.5 text-blue-400" />
                Fra (Afsender-alias):
              </label>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="text-[11px] text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1"
                  @click="customAliasMode = !customAliasMode"
                >
                  <Plus class="w-3 h-3" />
                  {{ customAliasMode ? 'Vælg fra gemte aliaser' : 'Indtast nyt alias' }}
                </button>
                <span class="text-slate-700">•</span>
                <button
                  type="button"
                  class="text-[11px] text-slate-400 hover:text-slate-200"
                  @click="store.isAliasModalOpen = true"
                >
                  Signaturer og afsendere
                </button>
              </div>
            </div>

            <div v-if="!customAliasMode" class="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <div class="sm:col-span-7">
                <select
                  v-model="selectedAliasEmail"
                  aria-label="Afsenderadresse"
                  class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                  @change="onAliasSelectChange"
                >
                  <option
                    v-for="alias in store.aliases"
                    :key="alias.id"
                    :value="alias.email"
                  >
                    {{ alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email }}
                    {{ alias.isDefault ? ' (Standard)' : '' }}
                  </option>
                  <option value="__CUSTOM__">+ Indtast et nyt afsender-alias...</option>
                </select>
              </div>
              <div class="sm:col-span-5 relative flex items-center">
                <User class="w-3.5 h-3.5 text-slate-500 absolute left-3 pointer-events-none" />
                <input
                  v-model="customFromName"
                  type="text"
                  placeholder="Visningsnavn (valgfrit)"
                  class="w-full pl-8 pr-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div v-else class="space-y-2">
              <div class="grid grid-cols-1 sm:grid-cols-12 gap-2">
                <div class="sm:col-span-6">
                  <input
                    v-model="customFromEmail"
                    type="email"
                    required
                    placeholder="nyt-alias@ditdomæne.dk"
                    class="w-full px-3 py-2 bg-slate-900 border border-blue-500/60 rounded-xl text-slate-100 focus:outline-none focus:border-blue-400"
                  />
                </div>
                <div class="sm:col-span-4">
                  <input
                    v-model="customFromName"
                    type="text"
                    placeholder="Visningsnavn (valgfrit)"
                    class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div class="sm:col-span-2">
                  <button
                    type="button"
                    class="w-full h-full py-2 px-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center justify-center gap-1 transition"
                    title="Gem dette alias nu"
                    @click="quickSaveCustomAlias"
                  >
                    <Check class="w-3.5 h-3.5" />
                    <span>Gem</span>
                  </button>
                </div>
              </div>
              <label class="inline-flex items-center gap-2 text-[11px] text-slate-300 cursor-pointer">
                <input
                  v-model="rememberNewAlias"
                  type="checkbox"
                  class="rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-0"
                />
                <span>Gem automatisk dette alias på min liste til fremtidige e-mails</span>
              </label>
            </div>
          </div>

          <!-- Til + Kontakt Auto-complete -->
          <div class="relative">
            <div class="flex items-center justify-between mb-1">
              <label class="text-slate-300 font-medium">Til (skriv navn eller e-mail, adskil med komma)</label>
              <button
                type="button"
                class="text-[11px] text-blue-400 hover:text-blue-300"
                @click="showCcBcc = !showCcBcc"
              >
                {{ showCcBcc ? 'Skjul CC / BCC' : '+ Tilføj CC / BCC' }}
              </button>
            </div>
            <input
              v-model="toInput"
              type="text"
              required
              placeholder="modtager@eksempel.dk eller søg i kontakter..."
              class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
              @focus="activeAutocompleteField = 'to'"
              @input="activeAutocompleteField = 'to'"
              @blur="handleAutocompleteBlur"
            />
            <div
              v-if="activeAutocompleteField === 'to' && autocompleteSuggestions.length > 0"
              class="absolute left-0 right-0 mt-1 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl max-h-48 overflow-y-auto z-50 divide-y divide-slate-800"
            >
              <button
                v-for="item in autocompleteSuggestions"
                :key="item.email"
                type="button"
                class="w-full px-3 py-2 text-left hover:bg-slate-800 flex items-center justify-between gap-2 transition"
                @mousedown.prevent="selectAutocompleteContact('to', item)"
              >
                <div class="truncate">
                  <span class="font-semibold text-slate-100">{{ item.name }}</span>
                  <span class="text-slate-400 ml-1.5">&lt;{{ item.email }}&gt;</span>
                </div>
                <span v-if="item.organization" class="text-[10px] text-slate-400 shrink-0">
                  {{ item.organization }}
                </span>
              </button>
            </div>
          </div>

          <!-- CC / BCC + Kontakt Auto-complete -->
          <div v-if="showCcBcc" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="relative">
              <label class="block text-slate-400 font-medium mb-1">CC (Kopi)</label>
              <input
                v-model="ccInput"
                type="text"
                placeholder="cc@eksempel.dk"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                @focus="activeAutocompleteField = 'cc'"
                @input="activeAutocompleteField = 'cc'"
                @blur="handleAutocompleteBlur"
              />
              <div
                v-if="activeAutocompleteField === 'cc' && autocompleteSuggestions.length > 0"
                class="absolute left-0 right-0 mt-1 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl max-h-44 overflow-y-auto z-50 divide-y divide-slate-800"
              >
                <button
                  v-for="item in autocompleteSuggestions"
                  :key="item.email"
                  type="button"
                  class="w-full px-3 py-2 text-left hover:bg-slate-800 truncate transition"
                  @mousedown.prevent="selectAutocompleteContact('cc', item)"
                >
                  <span class="font-semibold text-slate-100">{{ item.name }}</span>
                  <span class="text-slate-400 ml-1">&lt;{{ item.email }}&gt;</span>
                </button>
              </div>
            </div>
            <div class="relative">
              <label class="block text-slate-400 font-medium mb-1">BCC (Blind kopi)</label>
              <input
                v-model="bccInput"
                type="text"
                placeholder="bcc@eksempel.dk"
                class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
                @focus="activeAutocompleteField = 'bcc'"
                @input="activeAutocompleteField = 'bcc'"
                @blur="handleAutocompleteBlur"
              />
              <div
                v-if="activeAutocompleteField === 'bcc' && autocompleteSuggestions.length > 0"
                class="absolute left-0 right-0 mt-1 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl max-h-44 overflow-y-auto z-50 divide-y divide-slate-800"
              >
                <button
                  v-for="item in autocompleteSuggestions"
                  :key="item.email"
                  type="button"
                  class="w-full px-3 py-2 text-left hover:bg-slate-800 truncate transition"
                  @mousedown.prevent="selectAutocompleteContact('bcc', item)"
                >
                  <span class="font-semibold text-slate-100">{{ item.name }}</span>
                  <span class="text-slate-400 ml-1">&lt;{{ item.email }}&gt;</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Emne -->
          <div>
            <label class="block text-slate-300 font-medium mb-1">Emne</label>
            <input
              v-model="subject"
              type="text"
              lang="da"
              spellcheck="true"
              required
              placeholder="Indtast emne..."
              class="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <!-- Vedhæftede filer -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <label class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 cursor-pointer focus-within:ring-2 focus-within:ring-blue-400 transition">
                <Paperclip class="w-3.5 h-3.5 text-blue-400" />
                <span>{{ isReadingAttachments ? 'Læser filer…' : 'Vedhæft filer eller billeder' }}</span>
                <input
                  type="file"
                  multiple
                  aria-label="Vedhæft filer eller billeder"
                  :disabled="isReadingAttachments"
                  class="sr-only"
                  @change="handleFileUpload"
                />
              </label>
              <span v-if="attachments.length > 0" class="text-[11px] text-slate-400">
                {{ attachments.length }} fil(er) vedhæftet
              </span>
            </div>

            <div v-if="attachments.length > 0" class="flex flex-wrap gap-2">
              <div
                v-for="(att, idx) in attachments"
                :key="idx"
                class="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-slate-950 border border-slate-800 text-slate-200"
              >
                <Paperclip class="w-3 h-3 text-blue-400" />
                <span class="truncate max-w-[180px]">{{ att.filename }}</span>
                <button
                  type="button"
                  class="text-slate-500 hover:text-rose-400"
                  :aria-label="`Fjern ${att.filename}`"
                  @click="removeAttachment(idx)"
                >
                  <Trash2 class="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>

          <div v-if="roomSettings?.rooms_enabled" class="space-y-2">
            <button
              type="button"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
              :aria-expanded="showRoomPicker"
              @click="showRoomPicker = !showRoomPicker"
            >
              <MessagesSquare class="w-3.5 h-3.5 text-blue-400" />
              Indsæt chatlink
            </button>
            <div v-if="showRoomPicker" class="rounded-xl border border-slate-700 p-3 space-y-2">
              <RoomLinkPicker v-model="roomLinkInput" />
              <p v-if="roomLinkInput.trim() && !roomLink" class="text-rose-300">Indsæt et Rooms-link fra denne Sharedrive.</p>
              <button
                type="button"
                class="rounded-lg bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-500 disabled:opacity-50"
                :disabled="!roomLink || preparingChat"
                @click="insertRoomLink"
              >
                Indsæt i mail
              </button>
            </div>
          </div>

          <!-- Rich-Text Editor -->
          <div class="rounded-xl border border-slate-700 bg-slate-950 overflow-hidden">
            <div class="px-2.5 py-1.5 bg-slate-900 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div v-if="useRichHtml" class="flex items-center gap-1">
                <button
                  type="button"
                  class="p-1.5 rounded hover:bg-slate-800 text-slate-300"
                  title="Fed (Ctrl+B)"
                  @click="execFormat('bold')"
                >
                  <Bold class="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  class="p-1.5 rounded hover:bg-slate-800 text-slate-300"
                  title="Kursiv (Ctrl+I)"
                  @click="execFormat('italic')"
                >
                  <Italic class="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  class="p-1.5 rounded hover:bg-slate-800 text-slate-300"
                  title="Understreget (Ctrl+U)"
                  @click="execFormat('underline')"
                >
                  <Underline class="w-3.5 h-3.5" />
                </button>
                <div class="h-4 w-px bg-slate-800 mx-1"></div>
                <button
                  type="button"
                  class="p-1.5 rounded hover:bg-slate-800 text-slate-300"
                  title="Punktopstilling"
                  @click="execFormat('insertUnorderedList')"
                >
                  <List class="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  class="p-1.5 rounded hover:bg-slate-800 text-slate-300"
                  title="Nummereret liste"
                  @click="execFormat('insertOrderedList')"
                >
                  <ListOrdered class="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  class="p-1.5 rounded hover:bg-slate-800 text-slate-300"
                  title="Indsæt link"
                  @click="promptInsertLink"
                >
                  <Link class="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  class="p-1.5 rounded hover:bg-slate-800 text-slate-300"
                  title="Fjern formatering"
                  @click="execFormat('removeFormat')"
                >
                  <Eraser class="w-3.5 h-3.5" />
                </button>
              </div>
              <div v-else class="text-[11px] text-slate-400 px-1">
                Ren tekst-tilstand (Plain text)
              </div>

              <button
                type="button"
                class="flex items-center gap-1 px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-300 transition"
                @click="toggleEditorMode"
              >
                <FileCode class="w-3 h-3 text-blue-400" />
                <span>{{ useRichHtml ? 'Skift til ren tekst' : 'Skift til HTML-editor' }}</span>
              </button>
            </div>

            <div
              v-if="useRichHtml"
              ref="richEditorRef"
              contenteditable="true"
              lang="da"
              spellcheck="true"
              class="min-h-[220px] max-h-[340px] overflow-y-auto p-3.5 text-sm text-slate-100 leading-relaxed focus:outline-none"
            ></div>

            <textarea
              v-else
              v-model="textBody"
              lang="da"
              spellcheck="true"
              rows="10"
              placeholder="Skriv din besked her..."
              class="w-full p-3.5 bg-slate-950 text-slate-100 text-sm leading-relaxed focus:outline-none resize-y"
            ></textarea>
            <p class="px-3.5 pb-2 text-[11px] text-slate-400">Dansk stavekontrol bruger browserens ordbog. Højreklik på et markeret ord for forslag.</p>
          </div>

          <!-- Bundknapper -->
          <div class="pt-3 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <button
                type="button"
                :disabled="store.isSendingMail || isReadingAttachments"
                class="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-medium flex items-center gap-1.5 transition"
                @click="handleSaveDraft"
              >
                <Save class="w-3.5 h-3.5 text-amber-400" />
                <span>{{ draftRef ? 'Opdatér kladde' : 'Gem som kladde' }}</span>
              </button>

              <button
                v-if="draftRef"
                type="button"
                :disabled="store.isSendingMail || isReadingAttachments"
                class="px-3 py-2 rounded-xl bg-slate-900 hover:bg-rose-500/20 border border-slate-800 hover:border-rose-500/40 text-slate-300 hover:text-rose-300 font-medium flex items-center gap-1.5 transition"
                title="Flyt kladden til papirkurven"
                @click="handleDiscardDraft"
              >
                <Trash2 class="w-3.5 h-3.5" />
                <span>Kassér kladde</span>
              </button>
            </div>

            <div class="flex items-center gap-2">
              <button
                type="button"
                class="px-3 py-2 rounded-xl text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition"
                @click="store.isComposeModalOpen = false"
              >
                Annullér
              </button>
              <button
                type="submit"
                :disabled="store.isSendingMail || isReadingAttachments"
                title="Send e-mail (Ctrl+Enter)"
                class="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold flex items-center gap-1.5 shadow transition"
              >
                <Send class="w-3.5 h-3.5" />
                <span>{{ store.isSendingMail ? 'Sender...' : 'Send e-mail' }}</span>
                <kbd class="hidden sm:inline-block ml-1 px-1.5 py-0.5 rounded bg-blue-700/80 text-blue-100 text-[10px] font-normal">
                  Ctrl+Enter
                </kbd>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>
