export interface MailFolder {
  path: string;
  name: string;
  delimiter: string;
  specialUse: 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk' | 'custom';
  totalMessages: number;
  unreadMessages: number;
}

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  cid?: string;
  isInline: boolean;
  contentBase64?: string;
}

export interface MailHeader {
  id: string; // `${folder}::${uid}`
  uid: number;
  folder: string;
  messageId: string;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  date: string;
  size: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
}

export interface MailDetail extends MailHeader {
  bcc?: MailAddress[];
  replyTo: MailAddress[];
  inReplyTo?: string;
  references: string[];
  textBody: string;
  htmlBody: string;
  attachments: MailAttachment[];
  calendarInvite?: {
    uid?: string;
    method?: string;
    cancelled?: boolean;
    recurring?: boolean;
    occurrenceUpdate?: boolean;
    canAddDirectly?: boolean;
    summary: string;
    start?: string;
    end?: string;
    location?: string;
    organizer?: string;
    rawIcs: string;
  };
}

export interface SenderAlias {
  id: string;
  email: string;
  displayName: string;
  signature: string;
  isDefault: boolean;
  source?: 'primary' | 'mailcow' | 'manual';
  createdAt: string;
}

export interface SieveCondition {
  field: 'from' | 'to' | 'subject' | 'header' | 'size';
  customHeader?: string;
  comparator: 'contains' | 'is' | 'matches' | 'over' | 'under';
  value: string;
}

export interface SieveAction {
  type: 'fileinto' | 'redirect' | 'keep' | 'discard' | 'reject' | 'addflag_seen' | 'addflag_flagged';
  target?: string;
}

export interface SieveRule {
  id: string;
  name: string;
  enabled: boolean;
  matchType: 'allof' | 'anyof';
  conditions: SieveCondition[];
  actions: SieveAction[];
  stopProcessing: boolean;
}

export interface SieveScriptInfo {
  name: string;
  active: boolean;
}

export interface SieveOverview {
  supported: boolean;
  host: string;
  port: number;
  scripts: SieveScriptInfo[];
  activeScriptName: string;
  rawScript: string;
  rules: SieveRule[];
  hasUnparsedCustomBlocks: boolean;
}

export type ClipboardMode = 'COPY' | 'CUT' | null;

export interface MailClipboardState {
  mode: ClipboardMode;
  sourceFolder: string;
  messages: MailHeader[];
}

export interface MailUndoAction {
  id: string;
  label: string;
  createdAt: number;
  type: 'TRANSFER' | 'FLAGS';
  sourceFolder: string;
  targetFolder?: string;
  uids: number[];
  previousSeen?: boolean;
}

export interface ComposePrefill {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  textBody?: string;
  sharedFileUrl?: string;
}

export type ComposeMode = 'NEW' | 'REPLY' | 'REPLY_ALL' | 'FORWARD' | 'DRAFT';
export type LayoutMode = 'THREE_COL' | 'ROUNDCUBE_SPLIT';
export type ReaderThemeMode = 'SMART_DARK' | 'LIGHT_PAPER';
