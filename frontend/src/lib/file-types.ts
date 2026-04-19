// ── Centralized file-type configuration ────────────────────────────────────────
// Single source of truth for file routing decisions across Sharedrive.
// Used by: file-open routing, OnlyOffice integration, text editor, settings UI.

// ── OnlyOffice extensions ──────────────────────────────────────────────────────

export const ONLYOFFICE_DOCUMENT_EXTS = ['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt', 'ott'] as const
export const ONLYOFFICE_SPREADSHEET_EXTS = ['xls', 'xlsx', 'xlsm', 'xlsb', 'xltx', 'csv', 'ods', 'ots'] as const
export const ONLYOFFICE_PRESENTATION_EXTS = ['ppt', 'pptx', 'pptm', 'potx', 'odp', 'otp'] as const

export const ONLYOFFICE_EXTENSIONS = new Set([
  ...ONLYOFFICE_DOCUMENT_EXTS,
  ...ONLYOFFICE_SPREADSHEET_EXTS,
  ...ONLYOFFICE_PRESENTATION_EXTS,
])

// ── Text editor extensions ─────────────────────────────────────────────────────

export const TEXT_EDITOR_TEXT_MARKUP = [
  'txt', 'md', 'markdown', 'html', 'htm', 'xml',
  'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini',
  'env', 'conf', 'config', 'properties',
] as const

export const TEXT_EDITOR_WEB_SCRIPT = [
  'js', 'jsx', 'ts', 'tsx', 'css', 'scss', 'less',
  'sh', 'bash', 'zsh',
] as const

export const TEXT_EDITOR_PROGRAMMING = [
  'py', 'php', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'rb', 'pl', 'lua', 'sql',
] as const

export const TEXT_EDITOR_SYSTEM_MISC = [
  'log', 'dockerfile', 'gitignore',
] as const

export const TEXT_EDITOR_EXTENSIONS = new Set([
  ...TEXT_EDITOR_TEXT_MARKUP,
  ...TEXT_EDITOR_WEB_SCRIPT,
  ...TEXT_EDITOR_PROGRAMMING,
  ...TEXT_EDITOR_SYSTEM_MISC,
])

// ── Grouped metadata for settings UI ───────────────────────────────────────────

export const ONLYOFFICE_GROUPS = [
  { label: 'Tekstdokumenter', exts: ONLYOFFICE_DOCUMENT_EXTS },
  { label: 'Regneark', exts: ONLYOFFICE_SPREADSHEET_EXTS },
  { label: 'Præsentationer', exts: ONLYOFFICE_PRESENTATION_EXTS },
] as const

export const TEXT_EDITOR_GROUPS = [
  { label: 'Tekst & Markup', exts: TEXT_EDITOR_TEXT_MARKUP },
  { label: 'Web & Script', exts: TEXT_EDITOR_WEB_SCRIPT },
  { label: 'Programmering', exts: TEXT_EDITOR_PROGRAMMING },
  { label: 'System / Diverse', exts: TEXT_EDITOR_SYSTEM_MISC },
] as const

// ── Routing helpers ────────────────────────────────────────────────────────────

/** Extract the lowercase extension from a filename (without leading dot). */
export function fileExtension(name: string): string {
  const lc = name.toLowerCase()
  // Handle special filenames like "Dockerfile", ".gitignore"
  const base = lc.split('/').pop() ?? lc
  if (base === 'dockerfile') return 'dockerfile'
  if (base === '.gitignore' || base === 'gitignore') return 'gitignore'
  return base.split('.').pop() ?? ''
}

/** True if the file should be opened in OnlyOffice. */
export function isOnlyOfficeExtension(ext: string): boolean {
  return (ONLYOFFICE_EXTENSIONS as Set<string>).has(ext.toLowerCase())
}

/** True if the file should be opened in the text editor. */
export function isTextEditorExtension(ext: string): boolean {
  return (TEXT_EDITOR_EXTENSIONS as Set<string>).has(ext.toLowerCase())
}

/** Decide if a file item should open in OnlyOffice. */
export function shouldOpenInOnlyOffice(name: string): boolean {
  return isOnlyOfficeExtension(fileExtension(name))
}

/** Decide if a file item should open in the text editor. */
export function shouldOpenInTextEditor(name: string): boolean {
  return isTextEditorExtension(fileExtension(name))
}

// ── Monaco language mapping ────────────────────────────────────────────────────

const EXT_TO_LANGUAGE: Record<string, string> = {
  txt: 'plaintext',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  jsonc: 'json',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  ini: 'ini',
  toml: 'plaintext',
  conf: 'plaintext',
  config: 'plaintext',
  env: 'plaintext',
  properties: 'plaintext',
  log: 'plaintext',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  py: 'python',
  php: 'php',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  pl: 'perl',
  lua: 'lua',
  dockerfile: 'dockerfile',
  gitignore: 'plaintext',
}

/** Return the Monaco language id for a file extension. */
export function monacoLanguage(ext: string): string {
  return EXT_TO_LANGUAGE[ext.toLowerCase()] ?? 'plaintext'
}

// Max file size for in-browser editing (5 MB). Files above this open read-only.
export const TEXT_EDITOR_MAX_EDIT_BYTES = 5 * 1024 * 1024
// Max file size for loading at all (20 MB). Files above this refuse to open.
export const TEXT_EDITOR_MAX_LOAD_BYTES = 20 * 1024 * 1024
