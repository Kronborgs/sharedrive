import { useEffect, useRef, useState } from 'react'

const SHARE_CACHE = 'sharedrive-share-target'

interface ShareTargetFile {
  name: string
  type: string
  size: number
}

/**
 * Detects files received via the Web Share Target API.
 * The service worker stashes incoming files in a cache; this hook reads
 * them out and returns them as pending File objects so the UI can let the
 * user choose a destination folder before uploading.
 */
export function useShareTarget(enabled: boolean): {
  pendingFiles: File[]
  clearPending: () => void
} {
  const called = useRef(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])

  useEffect(() => {
    if (!enabled || called.current) return
    if (!('caches' in window)) return

    const params = new URLSearchParams(window.location.search)
    if (params.get('share-target') !== '1') return

    called.current = true

    // Remove the query param so a page refresh doesn't re-trigger
    const url = new URL(window.location.href)
    url.searchParams.delete('share-target')
    window.history.replaceState({}, '', url.pathname + url.search)

    // Read shared files from the SW cache
    ;(async () => {
      try {
        const cache = await caches.open(SHARE_CACHE)
        const manifestRes = await cache.match('/share-target-manifest')
        if (!manifestRes) return

        const manifest: ShareTargetFile[] = await manifestRes.json()
        const files: File[] = []

        for (const meta of manifest) {
          const res = await cache.match(`/share-target-file/${meta.name}`)
          if (!res) continue
          const blob = await res.blob()
          files.push(new File([blob], meta.name, { type: meta.type }))
        }

        // Clean up the cache
        await cache.delete('/share-target-manifest')
        for (const meta of manifest) {
          await cache.delete(`/share-target-file/${meta.name}`)
        }

        if (files.length > 0) {
          setPendingFiles(files)
        }
      } catch (err) {
        console.warn('[ShareTarget] Failed to read shared files:', err)
      }
    })()
  }, [enabled])

  const clearPending = () => setPendingFiles([])

  return { pendingFiles, clearPending }
}
