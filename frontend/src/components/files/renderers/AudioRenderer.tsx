import { Download, Music, AlertTriangle } from 'lucide-react'

interface AudioRendererProps {
  /** Authenticated preview URL */
  url: string
  fileName: string
  fileId: string
  mimeType: string
}

// Map file extensions to MIME types for cases where the stored type is wrong.
const EXT_MIME: Record<string, string> = {
  mp3:  'audio/mpeg',
  flac: 'audio/flac',
  wav:  'audio/wav',
  aac:  'audio/aac',
  m4a:  'audio/mp4',
  opus: 'audio/opus',
  ogg:  'audio/ogg',
  m4b:  'audio/mp4',
}

/** Returns a playable MIME type — falls back to extension lookup when stored type is generic. */
function resolvedMimeType(mimeType: string, fileName: string): string {
  const bad = !mimeType || mimeType === 'application/octet-stream' || mimeType === 'application/json'
  if (!bad) return mimeType
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? mimeType
}

/** Returns true when the browser declares it can play the given MIME type. */
function browserCanPlay(mimeType: string): boolean {
  try {
    const el = document.createElement('audio')
    // canPlayType returns '' (cannot), 'maybe', or 'probably'
    return el.canPlayType(mimeType) !== ''
  } catch {
    return false
  }
}

function isFlacFile(mimeType: string, fileName: string): boolean {
  return (
    mimeType === 'audio/flac' ||
    mimeType === 'audio/x-flac' ||
    fileName.toLowerCase().endsWith('.flac')
  )
}

export function AudioRenderer({ url, fileName, fileId, mimeType: rawMime }: AudioRendererProps) {
  const mimeType = resolvedMimeType(rawMime, fileName)
  const flac = isFlacFile(mimeType, fileName)
  const supported = flac
    ? browserCanPlay('audio/flac') || browserCanPlay('audio/x-flac')
    : browserCanPlay(mimeType)

  if (!supported) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-5 p-6 bg-zinc-50 dark:bg-[#0f1117]">
        <div className="w-16 h-16 rounded-2xl bg-zinc-100 dark:bg-[#2d3148] flex items-center justify-center">
          <Music size={28} className="text-zinc-400" />
        </div>
        <div className="flex flex-col items-center gap-2 text-center max-w-xs">
          <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
            <AlertTriangle size={16} />
            <span className="text-sm font-medium">Playback not supported</span>
          </div>
          <p className="text-xs text-muted">
            {flac
              ? 'Your browser cannot play FLAC audio natively.'
              : `Your browser cannot play this audio format (${mimeType || 'unknown'}).`}
          </p>
        </div>
        <a
          href={`/api/v1/files/${fileId}/download`}
          download={fileName}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
        >
          <Download size={14} />
          Download to play locally
        </a>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 p-6 bg-zinc-50 dark:bg-[#0f1117]">
      <div className="w-20 h-20 rounded-2xl bg-zinc-100 dark:bg-[#2d3148] flex items-center justify-center">
        <Music size={36} className="text-zinc-400" />
      </div>
      <p className="text-sm font-medium text-zinc-900 dark:text-slate-100 text-center max-w-xs truncate">
        {fileName}
      </p>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        src={url}
        controls
        className="w-full max-w-md"
        onError={() => {
          // If playback fails at runtime (e.g. codec issue) the browser shows its own error UI
        }}
      />
      <a
        href={`/api/v1/files/${fileId}/download`}
        download={fileName}
        className="flex items-center gap-1.5 text-xs text-muted hover:text-zinc-700 dark:hover:text-slate-300 transition-colors"
      >
        <Download size={12} />
        Download
      </a>
    </div>
  )
}
