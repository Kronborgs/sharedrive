import { useEffect, useRef } from 'react'
import { X, Loader, ArrowLeft } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { FileItem } from '@/types/api'

interface EditorConfig {
  document: {
    fileType: string
    key: string
    title: string
    url: string
    permissions: { edit: boolean; download: boolean }
  }
  documentType: string
  editorConfig: {
    callbackUrl: string
    lang: string
    mode: string
    user: { id: string; name: string }
  }
  token?: string
}

interface Props {
  item: FileItem
  onlyofficeUrl: string
  /** Called when the user clicks Close or the back button. */
  onClose: () => void
  /** Optional label for the back-navigation button, e.g. "My Files" or "Delt med mig". */
  backLabel?: string
  /** Link-share token. When provided the public config endpoint is used (no auth required). */
  shareToken?: string
}

export function OnlyOfficeEditor({ item, onlyofficeUrl, onClose, backLabel, shareToken }: Readonly<Props>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<unknown>(null)
  const { t } = useI18n()

  const configUrl = shareToken
    ? `/api/v1/public/onlyoffice/config/${item.id}?share_token=${encodeURIComponent(shareToken)}`
    : `/api/v1/onlyoffice/config/${item.id}`

  const { data: config, isLoading, isError } = useQuery({
    queryKey: ['onlyoffice', 'config', item.id, shareToken ?? ''],
    queryFn: ({ signal }) => api.get<EditorConfig>(configUrl, signal),
    staleTime: 0,
  })

  useEffect(() => {
    if (!config || !containerRef.current) return

    // Load OnlyOffice API script dynamically from document server
    const scriptId = 'onlyoffice-api-script'
    const existing = document.getElementById(scriptId)

    const initEditor = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const OTApi = (window as any).DocsAPI
      if (!OTApi) return

      editorRef.current = new OTApi.DocEditor('onlyoffice-editor-placeholder', {
        ...config,
        width: '100%',
        height: '100%',
        events: {
          onDocumentReady: () => { /* ready */ },
          onError: (e: unknown) => console.error('OnlyOffice error', e),
        },
      })
    }

    if (existing) {
      initEditor()
      return
    }

    const script = document.createElement('script')
    script.id = scriptId
    script.src = `${onlyofficeUrl.replace(/\/$/, '')}/web-apps/apps/api/documents/api.js`
    script.onload = initEditor
    script.onerror = () => console.error('Failed to load OnlyOffice API script')
    document.head.appendChild(script)

    return () => {
      // Destroy editor instance on unmount
      if (editorRef.current) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(editorRef.current as any).destroyEditor?.()
        } catch { /* ignore */ }
        editorRef.current = null
      }
    }
  }, [config, onlyofficeUrl])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <button type="button"
          onClick={onClose}
          className="flex items-center gap-1.5 p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-zinc-800 transition-colors shrink-0"
          title={t('oo.backToFolder')}
        >
          <ArrowLeft size={16} />
          {backLabel && <span className="text-xs hidden sm:inline">{backLabel}</span>}
        </button>
        <span className="text-sm font-medium text-slate-100 flex-1 truncate">{item.name}</span>
        <button type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-zinc-800 transition-colors"
          title={t('oo.closeEditor')}
        >
          <X size={16} />
        </button>
      </div>

      {/* Editor area */}
      <div className="flex-1 min-h-0 relative">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader size={24} className="animate-spin text-slate-400" />
          </div>
        )}
        {isError && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-red-400">{t('oo.loadFailed')}</p>
          </div>
        )}
        {/* OnlyOffice mounts its iframe inside this div */}
        <div
          ref={containerRef}
          id="onlyoffice-editor-placeholder"
          className="w-full h-full"
        />
      </div>
    </div>
  )
}
