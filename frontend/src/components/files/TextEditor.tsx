import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Editor, { type OnMount } from '@monaco-editor/react'
import { X, Save, RotateCcw, Loader2, AlertTriangle, Lock, FileText, WrapText } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fileExtension, monacoLanguage, TEXT_EDITOR_MAX_EDIT_BYTES, TEXT_EDITOR_MAX_LOAD_BYTES } from '@/lib/file-types'
import type { FileItem } from '@/types/api'

interface Props {
  item: FileItem
  onClose: () => void
}

export function TextEditor({ item, onClose }: Props) {
  const qc = useQueryClient()
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const [dirty, setDirty] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [serverUpdatedAt, setServerUpdatedAt] = useState(item.updated_at)
  const originalContent = useRef('')

  const ext = fileExtension(item.name)
  const language = monacoLanguage(ext)

  const canWrite = item.permissions ? (item.permissions.can_edit || item.permissions.is_owner) : true
  const tooLargeToEdit = item.size_bytes > TEXT_EDITOR_MAX_EDIT_BYTES
  const tooLargeToLoad = item.size_bytes > TEXT_EDITOR_MAX_LOAD_BYTES
  const readOnly = !canWrite || tooLargeToEdit

  // Detect system/stored theme
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // Fetch file content
  const { data: content, isLoading, isError, error } = useQuery({
    queryKey: ['text-editor', item.id],
    queryFn: async ({ signal }) => {
      if (tooLargeToLoad) throw new Error('Filen er for stor til at åbne i editoren')
      const res = await fetch(`/api/v1/files/${item.id}/preview`, {
        credentials: 'include',
        signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      return text
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  })

  // Store original content once loaded
  useEffect(() => {
    if (content !== undefined) {
      originalContent.current = content
    }
  }, [content])

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor
    editor.onDidChangeModelContent(() => {
      const current = editor.getValue()
      setDirty(current !== originalContent.current)
    })
  }, [])

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!editorRef.current) throw new Error('Editor not ready')
      const newContent = editorRef.current.getValue()

      // Check for conflict: re-fetch file metadata to see if updated_at changed
      const latest = await api.get<FileItem>(`/api/v1/files/${item.id}`)
      if (latest.updated_at !== serverUpdatedAt) {
        throw new Error('CONFLICT')
      }

      // Save via PUT to text-content endpoint
      const res = await fetch(`/api/v1/files/${item.id}/content`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: newContent,
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
      }
      const result = await res.json()
      return result
    },
    onSuccess: (result) => {
      const newContent = editorRef.current?.getValue() ?? ''
      originalContent.current = newContent
      setDirty(false)
      setServerUpdatedAt(result?.data?.updated_at ?? new Date().toISOString())
      void qc.invalidateQueries({ queryKey: ['files'] })
      toast.success('Fil gemt')
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'CONFLICT') {
        toast.error('Filen er ændret af en anden — genindlæs for at se ændringerne')
      } else {
        toast.error(err instanceof Error ? err.message : 'Kunne ikke gemme filen')
      }
    },
  })

  // Revert
  const handleRevert = useCallback(() => {
    if (!editorRef.current) return
    editorRef.current.setValue(originalContent.current)
    setDirty(false)
  }, [])

  // Ctrl+S save shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (dirty && !readOnly && !saveMutation.isPending) {
          saveMutation.mutate()
        }
      }
      if (e.key === 'Escape' && !dirty) {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dirty, readOnly, saveMutation, onClose])

  // Warn on unload if dirty
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  const handleClose = useCallback(() => {
    if (dirty) {
      if (!confirm('Du har ændringer der ikke er gemt. Vil du lukke alligevel?')) return
    }
    onClose()
  }, [dirty, onClose])

  const editorOptions = useMemo(() => ({
    readOnly,
    minimap: { enabled: false },
    fontSize: 14,
    lineNumbers: 'on' as const,
    renderWhitespace: 'selection' as const,
    scrollBeyondLastLine: false,
    wordWrap: wordWrap ? 'on' as const : 'off' as const,
    automaticLayout: true,
    tabSize: 2,
    insertSpaces: true,
    formatOnPaste: false,
    formatOnType: false,
    find: { addExtraSpaceOnTop: false },
    padding: { top: 8, bottom: 8 },
  }), [readOnly, wordWrap])

  const sizeLabel = useMemo(() => {
    const bytes = item.size_bytes
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }, [item.size_bytes])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900 shrink-0">
        <FileText size={16} className="text-zinc-400 shrink-0" />
        <span className="flex-1 text-sm font-medium text-zinc-100 truncate">{item.name}</span>

        {/* Status indicators */}
        <span className="text-[11px] text-zinc-500 hidden sm:inline">{language}</span>
        <span className="text-[11px] text-zinc-500 hidden sm:inline">{sizeLabel}</span>

        {readOnly && (
          <span className="flex items-center gap-1 text-[11px] text-amber-400">
            <Lock size={10} />
            {tooLargeToEdit ? 'For stor til redigering' : 'Skrivebeskyttet'}
          </span>
        )}

        {dirty && (
          <span className="text-[11px] text-brand-400 font-medium">Ikke gemt</span>
        )}

        {/* Word wrap toggle */}
        <button
          onClick={() => setWordWrap(w => !w)}
          className={`p-1.5 rounded-lg transition-colors ${
            wordWrap
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
          }`}
          title={wordWrap ? 'Slå tekstombrydning fra' : 'Slå tekstombrydning til'}
        >
          <WrapText size={14} />
        </button>

        {/* Save */}
        {!readOnly && (
          <button
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-xs font-medium transition-colors"
          >
            {saveMutation.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Save size={12} />
            )}
            Gem
          </button>
        )}

        {/* Revert */}
        {dirty && (
          <button
            onClick={handleRevert}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-700 text-xs font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
            title="Fortryd ændringer"
          >
            <RotateCcw size={12} />
            <span className="hidden sm:inline">Fortryd</span>
          </button>
        )}

        {/* Close */}
        <button
          onClick={handleClose}
          className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors text-zinc-400 hover:text-zinc-200"
        >
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {isLoading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 size={28} className="animate-spin text-brand-500" />
          </div>
        )}
        {isError && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-zinc-400">
            <AlertTriangle size={48} className="text-zinc-600" />
            <p className="text-sm">
              {error instanceof Error ? error.message : 'Kunne ikke indlæse filen'}
            </p>
            <button
              onClick={handleClose}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-zinc-700 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              Luk
            </button>
          </div>
        )}
        {content !== undefined && (
          <Editor
            defaultValue={content}
            language={language}
            theme={theme === 'dark' ? 'vs-dark' : 'light'}
            options={editorOptions}
            onMount={handleEditorMount}
            loading={
              <div className="flex items-center justify-center h-full">
                <Loader2 size={28} className="animate-spin text-brand-500" />
              </div>
            }
          />
        )}
      </div>
    </div>
  )
}
