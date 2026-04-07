import { useState } from 'react'
import type { FileItem } from '@/types/api'
import { getFileIcon, cn } from '@/lib/utils'

interface FileThumbnailProps {
  item: FileItem
  /** Rendered pixel size of the thumbnail square (default 40) */
  size?: number
  className?: string
}

function isRasterImage(mime: string | null): boolean {
  if (!mime) return false
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

export function FileThumbnail({ item, size = 40, className }: FileThumbnailProps) {
  const [error, setError] = useState(false)
  const mime = item.mime_type

  if (!item.is_folder && !error && isRasterImage(mime)) {
    return (
      <img
        src={`/api/v1/files/${item.id}/thumbnail`}
        alt=""
        width={size}
        height={size}
        className={cn('rounded object-cover shrink-0', className)}
        style={{ width: size, height: size, minWidth: size }}
        onError={() => setError(true)}
      />
    )
  }

  if (!item.is_folder && !error && mime === 'image/svg+xml') {
    return (
      <img
        src={`/api/v1/files/${item.id}/preview`}
        alt=""
        width={size}
        height={size}
        className={cn('rounded object-contain shrink-0', className)}
        style={{ width: size, height: size, minWidth: size }}
        onError={() => setError(true)}
      />
    )
  }

  const emoji = item.is_folder ? '📁' : getFileIcon(item.name)
  return (
    <span
      className={cn('shrink-0 select-none leading-none inline-block text-center', className)}
      style={{ fontSize: size * 0.75, width: size, height: size, lineHeight: `${size}px` }}
    >
      {emoji}
    </span>
  )
}
