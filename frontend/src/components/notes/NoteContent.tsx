import { Fragment } from 'react'

const URL_PATTERN = /(https?:\/\/[^\s]+|\/api\/v1\/files\/[a-f0-9-]+\/(?:preview|thumbnail))/gi
const IMAGE_PATTERN = /\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i

function cleanUrl(value: string): string {
  return value.replace(/[.,!?;:]+$/, '')
}

function isImageUrl(url: string): boolean {
  if (url.startsWith('/api/v1/files/')) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && IMAGE_PATTERN.test(parsed.pathname + parsed.search)
  } catch {
    return false
  }
}

export function NoteContent({ content, className = '' }: Readonly<{ content: string; className?: string }>) {
  const lines = content.split('\n')

  return (
    <div className={'whitespace-pre-wrap text-sm leading-7 ' + className}>
      {lines.map((line, lineIndex) => (
        <Fragment key={'line-' + lineIndex}>
          {lineIndex > 0 && <br />}
          {line.split(URL_PATTERN).map((part, partIndex) => {
            if (!/^(?:https?:\/\/|\/api\/v1\/files\/)/i.test(part)) return <Fragment key={'text-' + lineIndex + '-' + partIndex}>{part}</Fragment>
            const url = cleanUrl(part)
            if (!isImageUrl(url)) {
              return <a key={'url-' + lineIndex + '-' + partIndex} href={url} target="_blank" rel="noopener noreferrer" className="text-brand-600 underline underline-offset-2 hover:text-brand-700 dark:text-brand-400">{url}</a>
            }
            return (
              <span key={'image-' + lineIndex + '-' + partIndex} className="my-2 block">
                <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block">
                  <img src={url} alt="" loading="lazy" className="max-h-96 max-w-full rounded-lg border border-zinc-200 object-contain dark:border-zinc-700" />
                </a>
              </span>
            )
          })}
        </Fragment>
      ))}
    </div>
  )
}