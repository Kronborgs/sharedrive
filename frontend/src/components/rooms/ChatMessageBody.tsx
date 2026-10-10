import { type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

interface LinkPreview { url: string; canonical_url?: string; title?: string; description?: string; image_url?: string; hostname: string }
const URL_SCHEME = /https?:\/\//gi
const TRAILING_PUNCTUATION = new Set(['.', ',', '!', '?', ';', ':', ')'])

function findURLs(body: string) {
  const links: { start: number; end: number; url: string }[] = []
  let match: RegExpExecArray | null
  while ((match = URL_SCHEME.exec(body)) !== null) {
    const start = match.index
    let end = start + match[0].length
    while (end < body.length && !/\s/.test(body[end]) && !'<>' .includes(body[end]) && body[end] !== '"' && body[end] !== "'") {
      end += 1
    }
    while (end > start + match[0].length && TRAILING_PUNCTUATION.has(body[end - 1])) {
      end -= 1
    }
    if (end > start + match[0].length) {
      links.push({ start, end, url: body.slice(start, end) })
    }
  }
  return links
}

function LinkPreviewCard({ url, endpoint }: Readonly<{ url: string; endpoint: string }>) {
  const preview = useQuery({ queryKey: ['rooms', 'link-preview', url], queryFn: ({ signal }) => api.get<LinkPreview>(`${endpoint}?url=${encodeURIComponent(url)}`, signal), staleTime: 15 * 60 * 1000, retry: false })
  if (!preview.data || (!preview.data.title && !preview.data.description && !preview.data.image_url)) return null
  const target = preview.data.canonical_url || url
  return <a href={target} target="_blank" rel="noopener noreferrer" className="mt-2 block max-w-md overflow-hidden rounded-xl border border-subtle bg-surface text-left transition hover:border-brand-400">
    {preview.data.image_url && <img src={preview.data.image_url} alt="" className="max-h-48 w-full object-cover" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }} />}
    <span className="block px-3 py-2">{preview.data.title && <span className="block line-clamp-2 text-sm font-semibold">{preview.data.title}</span>}{preview.data.description && <span className="mt-1 block line-clamp-2 text-xs text-muted">{preview.data.description}</span>}<span className="mt-2 block truncate text-[11px] text-muted">{preview.data.hostname}</span></span>
  </a>
}

export function ChatMessageBody({ body, className = '', previewEndpoint = '/api/v1/rooms/link-preview' }: Readonly<{ body: string; className?: string; previewEndpoint?: string }>) {
  const links = findURLs(body)
  const parts: ReactNode[] = []
  const linkClassName = className.includes('text-white')
    ? 'break-all text-zinc-950 underline decoration-zinc-700 underline-offset-2 hover:text-black'
    : 'break-all text-brand-600 underline decoration-brand-300 underline-offset-2 hover:text-brand-700'
  let cursor = 0
  for (const link of links) {
    if (link.start > cursor) {
      parts.push(body.slice(cursor, link.start))
    }
    parts.push(<a key={`${link.url}-${link.start}`} href={link.url} target="_blank" rel="noopener noreferrer" className={linkClassName}>{link.url}</a>)
    cursor = link.end
  }
  if (cursor < body.length) parts.push(body.slice(cursor))
  return <><p className={`whitespace-pre-wrap break-words text-sm ${className}`}>{parts.length > 0 ? parts : body}</p>{links[0]?.url && <LinkPreviewCard url={links[0].url} endpoint={previewEndpoint} />}</>
}