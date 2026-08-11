import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useAuth } from '@/lib/auth-context'
import { z } from 'zod'
import { api, createPlaylist, fetchPlaylistTracks } from '@/lib/api'
import { usePlaylist } from '@/lib/playlist-context'
import type { FileItem, BackupPasswordStatus, AutoBackupConfig, BackupConfig } from '@/types/api'
import { FileList, FileGrid } from '@/components/files/FileViews'
import { FileContextMenu, type ContextAction } from '@/components/files/FileContextMenu'
import { DropZone, UploadProgress, useUploader } from '@/components/files/UploadZone'
import { ShareDialog } from '@/components/files/ShareDialog'
import { PreviewModal } from '@/components/files/PreviewModal'
import { DownloadDialog } from '@/components/files/DownloadDialog'
import { FolderPickerDialog } from '@/components/files/FolderPickerDialog'
import { ShareTargetDialog } from '@/components/files/ShareTargetDialog'
import { ShareTargetHint } from '@/components/files/ShareTargetHint'
import { PwaInstallButton } from '@/components/pwa/PwaInstallButton'
import { UploadConflictDialog, UploadGlobalDuplicateDialog } from '@/components/files/UploadDuplicateDialogs'
import { OnlyOfficeEditor } from '@/components/files/OnlyOfficeEditor'
import { TextEditor } from '@/components/files/TextEditor'
import { shouldOpenInOnlyOffice, shouldOpenInTextEditor } from '@/lib/file-types'
import { useShareTarget } from '@/hooks/useShareTarget'
import { useUploadDuplicateWorkflow } from '@/hooks/useUploadDuplicateWorkflow'
import { useI18n } from '@/lib/i18n'
import { ignorePromise } from '@/lib/ignore-promise'
import { LayoutList, LayoutGrid, Upload, FolderPlus, FolderUp, ChevronRight, Home, Share2, Pencil, Trash2, Download, X, ListMusic, MoreVertical, MoveRight, HardDrive, FilePlus } from 'lucide-react'
import { toast } from 'sonner'

const searchSchema = z.object({
  folder: z.string().optional(),
  oo: z.string().optional(),        // file ID currently open in OnlyOffice editor
  te: z.string().optional(),        // file ID currently open in text editor
  preview: z.string().optional(),   // file ID to open in preview modal
  highlight: z.string().optional(), // file ID to scroll into view + briefly highlight
})

export const Route = createFileRoute('/_auth/files/')({
  validateSearch: searchSchema,
  component: FilesPage,
})

type ViewMode = 'list' | 'grid'

interface ContextMenuState {
  item: FileItem
  x: number
  y: number
}

// ─── Playlist helpers ─────────────────────────────────────────────────────────

const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.opus', '.ogg', '.m4b']
const isAudioFile = (f: FileItem) =>
  !f.is_folder && AUDIO_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext))

function secureRandomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) return 0
  if (!globalThis.crypto?.getRandomValues) return 0

  // Rejection sampling keeps distribution uniform.
  const maxUint32 = 0x100000000
  const limit = Math.floor(maxUint32 / maxExclusive) * maxExclusive
  const buf = new Uint32Array(1)

  do {
    globalThis.crypto.getRandomValues(buf)
  } while (buf[0] >= limit)

  return buf[0] % maxExclusive
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function FilesPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { folder: folderId = null, oo: ooFileId = null, te: teFileId = null, preview: previewFileId = null, highlight: highlightFileId = null } = Route.useSearch()
  const qc = useQueryClient()
  const { setPlaylist, addTracks, tracks: playlistTracks, activePlaylistId, playlistMaxTracks } = usePlaylist()
  const { t } = useI18n()

  const [view, setView] = useState<ViewMode>('list')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [shareItem, setShareItem] = useState<FileItem | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [previewItem, setPreviewItem] = useState<FileItem | null>(null)
  const [downloadIds, setDownloadIds] = useState<string[] | null>(null)
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false)
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false)
  const [moveItem, setMoveItem] = useState<FileItem | null>(null)
  const [duplicateItem, setDuplicateItem] = useState<FileItem | null>(null)
  const [newDocOpen, setNewDocOpen] = useState(false)
  const [folderPlaylistJob, setFolderPlaylistJob] = useState<{
    folder: FileItem
    audioFiles: FileItem[]
    existingM3u: FileItem | null
  } | null>(null)
  const mobileMenuRef = useRef<HTMLDivElement>(null)

  const { uploads, startUpload, prepareFolderUpload, dismiss, directUpload } = useUploader(folderId)

  const {
    uploadConflictOpen,
    uploadConflictQueue,
    uploadConflictApplyAll,
    uploadDuplicateOpen,
    uploadDuplicateQueue,
    uploadDuplicateRenames,
    compareUpdatedLabel,
    beginUploadWithConflictCheck,
    beginUploadRequestsWithConflictCheck,
    setUploadConflictApplyAll,
    closeUploadConflictDialog,
    resolveUploadConflict,
    setUploadDuplicateRenames,
    closeUploadDuplicateDialog,
    skipUploadDuplicates,
    confirmUploadDuplicate,
  } = useUploadDuplicateWorkflow({
    folderId,
    startUpload,
    t,
  })

  // Handle files received via Android Web Share Target
  const { pendingFiles: shareTargetFiles, clearPending: clearShareTarget } = useShareTarget(!!user)

  const { data: breadcrumbs } = useQuery({
    queryKey: ['breadcrumbs', folderId],
    queryFn: ({ signal }) =>
      folderId
        ? api.get<FileItem[]>(`/api/v1/files/breadcrumbs?folder_id=${folderId}`, signal)
        : Promise.resolve<FileItem[]>([]),
  })

  const { data: systemSettings } = useQuery({
    queryKey: ['system', 'settings'],
    queryFn: ({ signal }) => api.get<{ direct_upload_url: string; onlyoffice_url: string }>('/api/v1/system/settings', signal),
    staleTime: 5 * 60 * 1000,
  })

  const { data: files, isLoading } = useQuery({
    queryKey: ['files', folderId],
    queryFn: ({ signal }) => {
      const query = folderId ? `parent_id=${folderId}` : ''
      return api.get<FileItem[]>(`/api/v1/files?${query}`, signal)
    },
  })

  const rename = useMutation({
    mutationFn: (body: { id: string; name: string }) =>
      api.patch(`/api/v1/files/${body.id}`, { name: body.name }),
    onSuccess: () => { ignorePromise(qc.invalidateQueries({ queryKey: ['files', folderId] })); setRenameId(null) },
    onError: () => toast.error(t('misc.renameFailed')),
  })

  const trash = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/files/${id}`),
    onSuccess: () => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['files', folderId] }))
      ignorePromise(qc.invalidateQueries({ queryKey: ['me'] }))
    },
    onError: () => toast.error(t('misc.trashFailed')),
  })

  const createFolder = useMutation({
    mutationFn: (name: string) => api.post<FileItem>('/api/v1/files', { name, parent_id: folderId }),
    onSuccess: (newFolder) => {
      qc.setQueryData<FileItem[]>(['files', folderId], prev =>
        prev ? [...prev, newFolder] : [newFolder]
      )
    },
    onError: () => toast.error(t('toast.createFolderFailed')),
  })

  const moveFile = useMutation({
    mutationFn: ({ id, destFolderId }: { id: string; destFolderId: string | null }) =>
      api.patch(`/api/v1/files/${id}`, { parent_id: destFolderId ?? '' }),
    onSuccess: (_, { destFolderId }) => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['files', folderId] }))
      if (destFolderId) ignorePromise(qc.invalidateQueries({ queryKey: ['files', destFolderId] }))
      setMoveItem(null)
      toast.success(t('toast.moved'))
    },
    onError: () => toast.error(t('toast.moveFailed')),
  })

  const copyFile = useMutation({
    mutationFn: ({ id, destFolderId }: { id: string; destFolderId: string | null }) =>
      api.post<FileItem>(`/api/v1/files/${id}/copy`, destFolderId ? { destination_folder_id: destFolderId } : {}),
    onSuccess: (_newFile, { destFolderId }) => {
      // Refresh the destination folder (or current folder if same)
      ignorePromise(qc.invalidateQueries({ queryKey: ['files', destFolderId ?? folderId] }))
      ignorePromise(qc.invalidateQueries({ queryKey: ['me'] }))
      setDuplicateItem(null)
      toast.success(t('toast.duplicated'))
    },
    onError: () => toast.error(t('toast.deleteFailed')),
  })

  const createDocument = useMutation({
    mutationFn: (opts: { type: 'word' | 'cell' | 'slide'; name: string }) =>
      api.post<{ id: string; name: string }>('/api/v1/onlyoffice/create', {
        type: opts.type,
        name: opts.name,
        parent_id: folderId ?? null,
      }),
    onSuccess: (result) => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['files', folderId] }))
      ignorePromise(qc.invalidateQueries({ queryKey: ['me'] }))
      setNewDocOpen(false)
      // Open the new document immediately in OO
      ignorePromise(navigate({ to: '/files', search: { folder: folderId ?? undefined, oo: result.id } }))
    },
    onError: () => toast.error(t('toast.createDocFailed')),
  })

  const createTextFile = useMutation({
    mutationFn: (opts: { name: string }) =>
      api.post<{ id: string; name: string }>('/api/v1/files/create-text', {
        name: opts.name,
        parent_id: folderId ?? null,
      }),
    onSuccess: (result) => {
      ignorePromise(qc.invalidateQueries({ queryKey: ['files', folderId] }))
      ignorePromise(qc.invalidateQueries({ queryKey: ['me'] }))
      setNewDocOpen(false)
      ignorePromise(navigate({ to: '/files', search: { folder: folderId ?? undefined, te: result.id } }))
    },
    onError: () => toast.error(t('toast.createDocFailed')),
  })

  // Derive OO item from URL param — avoids separate state that breaks back/forward
  const ooItem = ooFileId ? (files?.find(f => f.id === ooFileId) ?? null) : null
  const teItem = teFileId ? (files?.find(f => f.id === teFileId) ?? null) : null

  // Auto-open preview when ?preview=fileId is in URL (e.g. from search navigation)
  useEffect(() => {
    if (!previewFileId) return
    const fromList = files?.find(f => f.id === previewFileId)
    if (fromList) {
      setPreviewItem(fromList)
    } else {
      // File may be in a different folder (shared) — fetch it directly
      api.get<FileItem>(`/api/v1/files/${previewFileId}`).then(f => {
        if (f) setPreviewItem(f)
      }).catch(() => {/* ignore */})
    }
  }, [previewFileId, files])

  useEffect(() => {
    if (user?.role === 'guest') ignorePromise(navigate({ to: '/shares', replace: true }))
  }, [user, navigate])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node))
        setMobileActionsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSelect = useCallback((id: string, additive: boolean) => {
    setSelected(prev => {
      const next = new Set(additive ? prev : [])
      if (prev.has(id) && (additive || prev.size === 1)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleOpen = useCallback((item: FileItem) => {
    if (item.is_folder) {
      ignorePromise(navigate({ to: '/files', search: { folder: item.id } }))
      return
    }
    // Open in OnlyOffice if configured and file format is supported
    if (systemSettings?.onlyoffice_url && shouldOpenInOnlyOffice(item.name)) {
      ignorePromise(navigate({ to: '/files', search: { folder: folderId ?? undefined, oo: item.id } }))
      return
    }
    // Open in text editor if file format is supported
    if (shouldOpenInTextEditor(item.name)) {
      ignorePromise(navigate({ to: '/files', search: { folder: folderId ?? undefined, te: item.id } }))
      return
    }
    setPreviewItem(item)
  }, [navigate, systemSettings, folderId])

  const doCreateFolderPlaylist = useCallback(async (
    _folder: FileItem,
    audioFiles: FileItem[],
    existingM3u: FileItem | null,
    mode: 'all' | 'first50' | 'random50',
  ) => {
    let selectedFiles = audioFiles
    if (mode === 'random50') {
      selectedFiles = shuffleArray(audioFiles).slice(0, 50)
    } else if (mode === 'first50') {
      selectedFiles = audioFiles.slice(0, 50)
    }
    const ids = selectedFiles.map(f => f.id)

    // Soft-delete any existing .m3u in the folder (moves to trash)
    if (existingM3u) {
      try { await api.delete(`/api/v1/files/${existingM3u.id}`) } catch { /* ignore */ }
    }

    try {
      const result = await createPlaylist(null, null, ids) as any
      ignorePromise(qc.invalidateQueries({ queryKey: ['files', null] }))
      const displayName = result.name?.replace(/\.m3u$/i, '') ?? 'Playliste'
      toast.success(`Playlist oprettet — ${ids.length} ${ids.length === 1 ? 'nummer' : 'numre'}`)
      setFolderPlaylistJob(null)
      setPlaylist(result.id, displayName)
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Kunne ikke oprette playlist')
    }
  }, [qc, setPlaylist])

  const handleBackupContextAction = useCallback(async (item: FileItem) => {
    try {
      const [pwStatus, bkConfig, autoCfg] = await Promise.all([
        api.get<BackupPasswordStatus>('/api/v1/backup/password'),
        api.get<BackupConfig>('/api/v1/backup/config'),
        api.get<AutoBackupConfig>('/api/v1/backup/auto'),
      ])
      if (!pwStatus.has_password || !bkConfig.tertiary_enabled) {
        toast.info('Set up backup first')
        ignorePromise(navigate({ to: '/backup' }))
        return
      }
      const targetId = item.is_folder ? item.id : (item.parent_id ?? item.id)
      const existing = autoCfg.folder_ids ?? []
      if (existing.includes(targetId)) {
        toast.info(`"${item.name}" is already in auto backup`)
        return
      }
      const newIds = [...existing, targetId]
      await api.put('/api/v1/backup/auto', {
        enabled: true,
        interval_hours: autoCfg.interval_hours || 24,
        retention_days: autoCfg.retention_days || 30,
        folder_ids: newIds,
      })
      ignorePromise(qc.invalidateQueries({ queryKey: ['backup', 'auto'] }))
      toast.success(`"${item.name}" added to auto backup`)
    } catch (err) {
      console.error('Add to backup failed:', err)
      toast.error(t('toast.moveFailed'))
    }
  }, [navigate, qc, t])

  const handlePlaylistContextAction = useCallback(async (item: FileItem) => {
    try {
      const contents = await api.get<FileItem[]>(`/api/v1/files?parent_id=${item.id}`)
      const audio = contents.filter(isAudioFile)
      const existingM3u = contents.find(
        f => !f.is_folder && f.name.toLowerCase().endsWith('.m3u')
      ) ?? null
      if (audio.length === 0) {
        toast.info(t('toast.noAudioFiles'))
        return
      }
      if (activePlaylistId) {
        const result = await addTracks(audio.map(f => f.id))
        if (result.added > 0)
          toast.success(`${result.added} ${result.added === 1 ? 'nummer' : 'numre'} tilføjet til playlist`)
        else
          toast.info('Alle numre er allerede i playlisten eller den er fuld (max 50)')
        return
      }
      if (audio.length <= 50) {
        await doCreateFolderPlaylist(item, audio, existingM3u, 'all')
      } else {
        setFolderPlaylistJob({ folder: item, audioFiles: audio, existingM3u })
      }
    } catch {
      toast.error(t('toast.couldNotReadFolder'))
    }
  }, [activePlaylistId, addTracks, doCreateFolderPlaylist, t])

  const handleAddToQueueContextAction = useCallback(async (item: FileItem) => {
    try {
      const result = await addTracks([item.id])
      if (result.added > 0) {
        toast.success(`„${item.name}“ tilføjet til køen`)
      } else if (result.skipped > 0) {
        toast.info('Nummeret er allerede i køen eller køen er fuld (max 50)')
      }
    } catch {
      toast.error(t('toast.moveFailed'))
    }
  }, [addTracks, t])

  const handleAddToPlayerContextAction = useCallback(async (item: FileItem) => {
    try {
      const m3uTracks = await fetchPlaylistTracks(item.id)
      const trackIds = m3uTracks.map(tr => tr.id)
      if (trackIds.length === 0) {
        toast.info('M3U filen indeholder ingen tilgængelige numre')
        return
      }
      const result = await addTracks(trackIds)
      if (result.added > 0) {
        toast.success(`${result.added} ${result.added === 1 ? 'nummer' : 'numre'} tilføjet til musikafspilleren`)
      } else {
        toast.info(`Alle numre er allerede i afspilleren eller den er fuld (max ${playlistMaxTracks})`)
      }
    } catch {
      toast.error('Kunne ikke læse playlisten')
    }
  }, [addTracks, fetchPlaylistTracks, playlistMaxTracks])

  const handleTrashContextAction = useCallback((item: FileItem) => {
    const msg = item.is_folder
      ? `Flytte mappen "${item.name}" og alt dens indhold til papirkurven?`
      : `Flytte "${item.name}" til papirkurven?`
    if (confirm(msg)) {
      trash.mutate(item.id)
    }
  }, [trash])

  const handlePlayInPlayerContextAction = useCallback((item: FileItem) => {
    if (item.is_folder) {
      return
    }
    const displayName = item.name.replace(/\.m3u$/i, '')
    setPlaylist(item.id, displayName)
    toast.success(`Indlæser "${displayName}"`)
  }, [setPlaylist])

  const handleBasicContextMenuAction = useCallback((action: ContextAction, item: FileItem): boolean => {
    switch (action) {
      case 'open':
        handleOpen(item)
        return true
      case 'download':
        if (item.is_folder) {
          setDownloadIds([item.id])
        } else {
          window.open(`/api/v1/files/${item.id}/download`, '_blank')
        }
        return true
      case 'share':
        setShareItem(item)
        return true
      case 'rename':
        setRenameId(item.id)
        setRenameName(item.name)
        return true
      case 'move':
        setMoveItem(item)
        return true
      case 'copy':
        setDuplicateItem(item)
        return true
      case 'trash':
        handleTrashContextAction(item)
        return true
      case 'playInPlayer':
        handlePlayInPlayerContextAction(item)
        return true
      default:
        return false
    }
  }, [handleOpen, handlePlayInPlayerContextAction, handleTrashContextAction])

  const handleContextMenuAction = useCallback((action: ContextAction, item: FileItem) => {
    if (handleBasicContextMenuAction(action, item)) {
      return
    }
    if (action === 'backup') {
      ignorePromise(handleBackupContextAction(item))
      return
    }
    if (action === 'playlist') {
      if (item.is_folder) {
        ignorePromise(handlePlaylistContextAction(item))
      }
      return
    }
    if (action === 'addtoqueue') {
      if (!item.is_folder) {
        ignorePromise(handleAddToQueueContextAction(item))
      }
      return
    }
    if (action === 'addToPlayer' && !item.is_folder) {
      ignorePromise(handleAddToPlayerContextAction(item))
    }
  }, [handleBasicContextMenuAction, handleBackupContextAction, handlePlaylistContextAction, handleAddToQueueContextAction, handleAddToPlayerContextAction])

  const items = files ?? []


  const beginFolderUploadWithConflictCheck = useCallback(async (fileList: FileList) => {
    try {
      const prepared = await prepareFolderUpload(fileList)
      if (prepared.length === 0) return
      await beginUploadRequestsWithConflictCheck(prepared)
    } catch {
      toast.error(t('toast.createFolderFailed'))
    }
  }, [beginUploadRequestsWithConflictCheck, prepareFolderUpload, t])

  const sorted = [...items.filter(f => f.is_folder), ...items.filter(f => !f.is_folder)]

  const currentFolderItem: FileItem | null = folderId && breadcrumbs?.length
    ? {
        id: folderId,
        parent_id: null,
        owner_id: '',
        is_folder: true,
        name: breadcrumbs[breadcrumbs.length - 1].name,
        mime_type: null,
        size_bytes: 0,
        checksum_sha256: null,
        deleted_at: null,
        created_at: '',
        updated_at: '',
        permissions: { can_view: true, can_upload: true, can_edit: true, can_delete: true, can_reshare: true, is_owner: true },
      }
    : null

  const handleSelectAll = useCallback(() => {
    if (selected.size === sorted.length) setSelected(new Set())
    else setSelected(new Set(sorted.map(f => f.id)))
  }, [selected.size, sorted])

  const handleBulkDownload = useCallback(() => {
    setDownloadIds([...selected])
  }, [selected])

  const handleBulkTrash = useCallback(async () => {
    if (!confirm(`Flytte ${selected.size} element(er) til papirkurven? Mapper flyttes inklusiv indhold.`)) return
    // Delete sequentially to avoid race where folder delete cascades children that are also selected
    const ids = [...selected]
    let failed = 0
    for (const id of ids) {
      try { await api.delete(`/api/v1/files/${id}`) } catch { failed++ }
    }
    if (failed > 0) toast.error(`${failed} element(er) kunne ikke flyttes til papirkurven`)
    ignorePromise(qc.invalidateQueries({ queryKey: ['files', folderId] }))
    ignorePromise(qc.invalidateQueries({ queryKey: ['me'] }))
    setSelected(new Set())
  }, [selected, qc, folderId])

  const handleBulkMove = useCallback(async (destFolderId: string | null) => {
    setBulkMoveOpen(false)
    const ids = [...selected]
    const results = await Promise.allSettled(
      ids.map(id => api.patch(`/api/v1/files/${id}`, { parent_id: destFolderId ?? '' }))
    )
    const failed = results.filter(r => r.status === 'rejected').length
    ignorePromise(qc.invalidateQueries({ queryKey: ['files', folderId] }))
    if (destFolderId) ignorePromise(qc.invalidateQueries({ queryKey: ['files', destFolderId] }))
    setSelected(new Set())
    if (failed > 0) toast.error(`${failed} element(er) kunne ikke flyttes`)
    else toast.success(`${ids.length} element(er) flyttet`)
  }, [selected, folderId, qc])

  const handleBulkBackup = useCallback(async () => {
    try {
      const [pwStatus, bkConfig, autoCfg] = await Promise.all([
        api.get<BackupPasswordStatus>('/api/v1/backup/password'),
        api.get<BackupConfig>('/api/v1/backup/config'),
        api.get<AutoBackupConfig>('/api/v1/backup/auto'),
      ])
      if (!pwStatus.has_password || !bkConfig.tertiary_enabled) {
        toast.info('Set up backup first')
        ignorePromise(navigate({ to: '/backup' }))
        return
      }
      const existing: string[] = autoCfg.folder_ids ?? []
      const candidates = sorted
        .filter(f => selected.has(f.id))
        .map(f => f.is_folder ? f.id : (f.parent_id ?? null))
        .filter((id): id is string => id !== null && !existing.includes(id))
      const uniqueNew = [...new Set(candidates)]
      if (uniqueNew.length === 0) {
        toast.info('De valgte mapper er allerede i auto backup')
        return
      }
      await api.put('/api/v1/backup/auto', {
        enabled: true,
        interval_hours: autoCfg.interval_hours || 24,
        retention_days: autoCfg.retention_days || 30,
        folder_ids: [...existing, ...uniqueNew],
      })
      ignorePromise(qc.invalidateQueries({ queryKey: ['backup', 'auto'] }))
      toast.success(`${uniqueNew.length} mappe(r) tilføjet til auto backup`)
    } catch {
      toast.error(t('toast.moveFailed'))
    }
  }, [selected, sorted, navigate, qc])

  const handleCreatePlaylist = useCallback(async () => {
    try {
      const f = await createPlaylist(null, folderId, [...selected]) as any
      const displayName = f.name?.replace(/\.m3u$/i, '') ?? 'Playliste'
      toast.success(t('misc.playlistCreated'))
      ignorePromise(qc.invalidateQueries({ queryKey: ['files', folderId] }))
      setSelected(new Set())
      setPlaylist(f.id, displayName)
    } catch {
      toast.error(t('toast.createDocFailed'))
    }
  }, [selected, folderId, qc, setPlaylist, t])

  if (user?.role === 'guest') return null

  return (
    <DropZone folderId={folderId} onUploadStart={files => beginUploadWithConflictCheck(files)}>
      <div className="flex flex-col flex-1 min-h-0">
        {/* Toolbar */}
        <div className="sticky top-0 z-10 shrink-0 bg-zinc-50 dark:bg-[#0f1117]">
          {/* PWA install banner — touch devices only, dismissible */}
          <ShareTargetHint />
          <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 px-4 py-2.5 border-b border-zinc-100 dark:border-[#2d3148]">
          {selected.size > 0 ? (
            /* ── Bulk action bar ─────────────────────────────── */
            <>
              <button type="button" onClick={() => setSelected(new Set())} className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-slate-300 transition-colors" title="Clear selection">
                <X size={16} />
              </button>
              <span className="text-sm font-medium text-zinc-900 dark:text-slate-100 flex-1">
                {selected.size} {t('files.selected')}
              </span>
              <div className="flex items-center gap-1 flex-wrap shrink-0">
                {selected.size === 1 && (() => {
                  const item = sorted.find(f => selected.has(f.id))
                  return item ? (
                    <button type="button"
                      onClick={() => setShareItem(item)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                      title="Del"
                    >
                      <Share2 size={12} />
                      <span className="hidden sm:inline">{t('action.share')}</span>
                    </button>
                  ) : null
                })()}
                <button type="button"
                  onClick={() => setBulkMoveOpen(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                  title={t('action.move')}
                >
                  <MoveRight size={12} />
                  <span className="hidden sm:inline">{t('action.move')}</span>
                </button>
                <button type="button"
                  onClick={() => { ignorePromise(handleBulkBackup()) }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                  title={t('nav.backup')}
                >
                  <HardDrive size={12} />
                  <span className="hidden sm:inline">Backup</span>
                </button>
                <button type="button"
                  onClick={handleBulkDownload}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                >
                  <Download size={12} />
                  <span className="hidden sm:inline">Download</span>
                </button>
                <button type="button"
                  onClick={() => { ignorePromise(handleCreatePlaylist()) }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                  title="Opret M3U afspilningsliste fra valgte lydfiler"
                >
                  <ListMusic size={12} />
                  <span className="hidden sm:inline">{t('files.playlist')}</span>
                </button>
                <button type="button"
                  onClick={() => { ignorePromise(handleBulkTrash()) }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-200 dark:border-red-900/40 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  <Trash2 size={12} />
                  <span className="hidden sm:inline">{t('action.delete')}</span>
                </button>
              </div>
            </>
          ) : (
            /* ── Normal toolbar ──────────────────────────────── */
            <div className="flex w-full flex-col gap-1.5 lg:flex-row lg:items-center">
              <nav className="flex min-w-0 items-center gap-1 text-sm lg:flex-1">
                <button type="button"
                  onClick={() => ignorePromise(navigate({ to: '/files', search: {} }))}
                  className="flex items-center gap-1 text-muted hover:text-zinc-900 dark:hover:text-slate-100 transition-colors shrink-0"
                >
                  <Home size={14} />
                  {t('page.myFiles')}
                </button>
                {breadcrumbs?.map(bc => (
                  <span key={bc.id} className="flex items-center gap-1 min-w-0">
                    <ChevronRight size={13} className="text-zinc-300 dark:text-slate-600 shrink-0" />
                    <button type="button"
                      onClick={() => ignorePromise(navigate({ to: '/files', search: { folder: bc.id } }))}
                      className="text-muted hover:text-zinc-900 dark:hover:text-slate-100 transition-colors truncate max-w-[140px] sm:max-w-[160px]"
                    >
                      {bc.name}
                    </button>
                  </span>
                ))}
              </nav>
              <PwaInstallButton
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-[#2d3148] dark:text-slate-300 dark:hover:bg-[#2d3148] lg:hidden"
                title="Installér Sharedrive"
                label="Installér Sharedrive"
                iconSize={16}
              />
              <div className="flex shrink-0 items-center gap-1 lg:ml-auto">
                {/* Folder actions — desktop only (hidden on mobile) */}
                {folderId && currentFolderItem && (
                  <>
                    <button type="button"
                      onClick={() => setShareItem(currentFolderItem)}
                      className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    >
                      <Share2 size={12} />
                      {t('action.share')}
                    </button>
                    <button type="button"
                      onClick={() => { setRenameId(folderId); setRenameName(currentFolderItem.name) }}
                      className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    >
                      <Pencil size={12} />
                      {t('action.rename')}
                    </button>
                    <button type="button"
                      onClick={async () => {
                        if (!confirm(`Move "${currentFolderItem.name}" to trash?`)) return
                        try {
                          await api.delete(`/api/v1/files/${folderId}`)
                          const parentId = breadcrumbs && breadcrumbs.length > 1
                            ? breadcrumbs[breadcrumbs.length - 2].id
                            : null
                          ignorePromise(qc.invalidateQueries({ queryKey: ['files', parentId] }))
                          ignorePromise(qc.invalidateQueries({ queryKey: ['me'] }))
                          ignorePromise(navigate({ to: '/files', search: parentId ? { folder: parentId } : {} }))
                        } catch {
                          toast.error(t('toast.deleteFailed'))
                        }
                      }}
                      className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <Trash2 size={12} />
                      {t('action.delete')}
                    </button>
                  </>
                )}

                <PwaInstallButton
                  className="hidden items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-[#2d3148] dark:text-slate-300 dark:hover:bg-[#2d3148] lg:flex"
                  title="Installér Sharedrive"
                  label="Installér Sharedrive"
                  iconSize={12}
                />

                {/* Upload — always visible, label hidden on mobile */}
                <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium cursor-pointer transition-colors">
                  <Upload size={12} />
                  <span className="hidden lg:inline">{t('action.upload')}</span>
                  <input type="file" multiple className="sr-only" onChange={e => e.target.files && beginUploadWithConflictCheck(Array.from(e.target.files))} />
                </label>

                {/* Upload folder — desktop only */}
                <label className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors cursor-pointer">
                  <FolderUp size={12} />
                  {t('action.uploadFolder')}
                  <input type="file" className="sr-only" {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)} onChange={e => e.target.files && beginFolderUploadWithConflictCheck(e.target.files)} />
                </label>

                {/* New folder — desktop only */}
                <button type="button"
                  onClick={() => { const n = window.prompt('Folder name:'); if (n?.trim()) createFolder.mutate(n.trim()) }}
                  className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                >
                  <FolderPlus size={12} />
                  {t('action.newFolder')}
                </button>

                {/* New document dropdown — desktop only */}
                <div className="relative hidden lg:block">
                    <button type="button"
                      onClick={() => setNewDocOpen(v => !v)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-xs font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    >
                      <FilePlus size={12} />
                      {t('action.newDoc')}
                    </button>
                    {newDocOpen && (
                      <div className="absolute right-0 top-full mt-1 w-48 rounded-xl border border-zinc-200 dark:border-[#2d3148] bg-white dark:bg-[#1a1d27] shadow-xl z-40 py-1">
                        {systemSettings?.onlyoffice_url && ([
                          { type: 'word' as const,  icon: '📄', labelKey: 'doc.word' as const,       nameKey: 'doc.wordName' as const,       ext: '.docx' },
                          { type: 'cell' as const,  icon: '📊', labelKey: 'doc.excel' as const,      nameKey: 'doc.excelName' as const,      ext: '.xlsx' },
                          { type: 'slide' as const, icon: '📑', labelKey: 'doc.powerpoint' as const, nameKey: 'doc.powerpointName' as const, ext: '.pptx' },
                        ] as const).map(o => (
                          <button type="button"
                            key={o.type}
                            onClick={() => { createDocument.mutate({ type: o.type, name: `${t(o.nameKey)}${o.ext}` }) }}
                            disabled={createDocument.isPending}
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
                          >
                            <span>{o.icon}</span>
                            {t(o.labelKey)}
                          </button>
                        ))}
                        {systemSettings?.onlyoffice_url && <div className="h-px bg-zinc-100 dark:bg-[#2d3148] mx-2 my-1" />}
                        {([
                          { icon: '📝', labelKey: 'doc.textFile' as const,  nameKey: 'doc.textFileName' as const,  ext: '.txt' },
                          { icon: '📋', labelKey: 'doc.markdown' as const,  nameKey: 'doc.markdownName' as const,  ext: '.md' },
                          { icon: '{ }', labelKey: 'doc.jsonFile' as const,  nameKey: 'doc.jsonFileName' as const,  ext: '.json' },
                        ] as const).map(o => (
                          <button type="button"
                            key={o.ext}
                            onClick={() => { createTextFile.mutate({ name: `${t(o.nameKey)}${o.ext}` }) }}
                            disabled={createTextFile.isPending}
                            className="flex w-full items-center gap-2.5 px-3 py-2.5 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
                          >
                            <span className="w-4 text-center">{o.icon}</span>
                            {t(o.labelKey)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                {/* Compact actions for phones and narrow tablets */}
                <div className="lg:hidden" ref={mobileMenuRef}>
                  <button type="button"
                    onClick={() => setMobileActionsOpen(v => !v)}
                    className="flex items-center p-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    title="More actions"
                  >
                    <MoreVertical size={16} />
                  </button>
                </div>

                {/* View toggle */}
                <div className="flex items-center rounded-lg border border-zinc-200 dark:border-[#2d3148] overflow-hidden">
                  <button type="button" onClick={() => setView('list')} className={`p-1.5 transition-colors ${view === 'list' ? 'bg-zinc-100 dark:bg-[#2d3148] text-zinc-900 dark:text-slate-100' : 'text-zinc-400 hover:text-zinc-600'}`} title="List view"><LayoutList size={14} /></button>
                  <button type="button" onClick={() => setView('grid')} className={`p-1.5 transition-colors ${view === 'grid' ? 'bg-zinc-100 dark:bg-[#2d3148] text-zinc-900 dark:text-slate-100' : 'text-zinc-400 hover:text-zinc-600'}`} title="Grid view"><LayoutGrid size={14} /></button>
                </div>
              </div>
            </div>
          )}
          </div>
        </div>

        {/* Mobile bottom sheet — action menu */}
        {mobileActionsOpen && (
          <>
            {/* Backdrop */}
            <button
              type="button"
              aria-label={t('action.close')}
              className="fixed inset-0 z-40 bg-black/40 lg:hidden"
              onClick={() => setMobileActionsOpen(false)}
            />
            {/* Sheet */}
            <div className="fixed inset-x-0 bottom-0 z-50 flex max-h-[75vh] flex-col rounded-t-2xl border-t border-zinc-200 bg-white shadow-2xl dark:border-[#2d3148] dark:bg-[#1a1d27] lg:hidden">
              {/* Drag handle */}
              <div className="flex justify-center pt-3 pb-1 shrink-0">
                <div className="w-10 h-1 rounded-full bg-zinc-300 dark:bg-zinc-600" />
              </div>
              <div className="overflow-y-auto pb-6">
                <button type="button"
                  onClick={() => { setMobileActionsOpen(false); const n = window.prompt('Folder name:'); if (n?.trim()) createFolder.mutate(n.trim()) }}
                  className="flex w-full items-center gap-3 px-5 py-3.5 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                >
                  <FolderPlus size={17} />
                  {t('action.newFolder')}
                </button>
                {/* New document options */}
                <div className="h-px bg-zinc-100 dark:bg-[#2d3148] mx-4 my-1" />
                <p className="px-5 py-1.5 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">{t('action.newDoc')}</p>
                {systemSettings?.onlyoffice_url && ([
                  { type: 'word' as const,  icon: '📄', labelKey: 'doc.word' as const,       nameKey: 'doc.wordName' as const,       ext: '.docx' },
                  { type: 'cell' as const,  icon: '📊', labelKey: 'doc.excel' as const,      nameKey: 'doc.excelName' as const,      ext: '.xlsx' },
                  { type: 'slide' as const, icon: '📑', labelKey: 'doc.powerpoint' as const, nameKey: 'doc.powerpointName' as const, ext: '.pptx' },
                ] as const).map(o => (
                  <button type="button"
                    key={o.type}
                    onClick={() => { setMobileActionsOpen(false); createDocument.mutate({ type: o.type, name: `${t(o.nameKey)}${o.ext}` }) }}
                    disabled={createDocument.isPending}
                    className="flex w-full items-center gap-3 px-5 py-3.5 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
                  >
                    <span className="w-5 text-center text-base">{o.icon}</span>
                    {t(o.labelKey)}
                  </button>
                ))}
                {([
                  { icon: '📝', labelKey: 'doc.textFile' as const,  nameKey: 'doc.textFileName' as const,  ext: '.txt' },
                  { icon: '📋', labelKey: 'doc.markdown' as const,  nameKey: 'doc.markdownName' as const,  ext: '.md' },
                  { icon: '{ }', labelKey: 'doc.jsonFile' as const,  nameKey: 'doc.jsonFileName' as const,  ext: '.json' },
                ] as const).map(o => (
                  <button type="button"
                    key={o.ext}
                    onClick={() => { setMobileActionsOpen(false); createTextFile.mutate({ name: `${t(o.nameKey)}${o.ext}` }) }}
                    disabled={createTextFile.isPending}
                    className="flex w-full items-center gap-3 px-5 py-3.5 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors disabled:opacity-50"
                  >
                    <span className="w-5 text-center text-base">{o.icon}</span>
                    {t(o.labelKey)}
                  </button>
                ))}
                {folderId && currentFolderItem && (
                  <>
                    <div className="h-px bg-zinc-100 dark:bg-[#2d3148] mx-4 my-1" />
                    <p className="px-5 py-1.5 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">{currentFolderItem.name}</p>
                    <button type="button"
                      onClick={() => { setMobileActionsOpen(false); setShareItem(currentFolderItem) }}
                      className="flex w-full items-center gap-3 px-5 py-3.5 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    >
                      <Share2 size={17} />
                      {t('files.shareFolder')}
                    </button>
                    <button type="button"
                      onClick={() => { setMobileActionsOpen(false); setRenameId(folderId); setRenameName(currentFolderItem.name) }}
                      className="flex w-full items-center gap-3 px-5 py-3.5 text-sm text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
                    >
                      <Pencil size={17} />
                      {t('files.renameFolder')}
                    </button>
                    <div className="h-px bg-zinc-100 dark:bg-[#2d3148] mx-4 my-1" />
                    <button type="button"
                      onClick={async () => {
                        setMobileActionsOpen(false)
                        if (!confirm(`Move "${currentFolderItem.name}" to trash?`)) return
                        try {
                          await api.delete(`/api/v1/files/${folderId}`)
                          const parentId = breadcrumbs && breadcrumbs.length > 1
                            ? breadcrumbs[breadcrumbs.length - 2].id
                            : null
                          ignorePromise(qc.invalidateQueries({ queryKey: ['files', parentId] }))
                          ignorePromise(qc.invalidateQueries({ queryKey: ['me'] }))
                          ignorePromise(navigate({ to: '/files', search: parentId ? { folder: parentId } : {} }))
                        } catch {
                          toast.error(t('toast.deleteFailed'))
                        }
                      }}
                      className="flex w-full items-center gap-3 px-5 py-3.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <Trash2 size={17} />
                      {t('files.deleteFolder')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-1">
          {(() => {
            if (isLoading) {
              return <div className="flex items-center justify-center h-40 text-sm text-muted">{t('files.loading')}</div>
            }
            if (view === 'list') {
              return <FileList items={sorted} selectedIds={selected} onSelect={handleSelect} onOpen={handleOpen} onContextMenu={(item, x, y) => setContextMenu({ item, x, y })} onSelectAll={handleSelectAll} onQuickShare={item => setShareItem(item)} highlightId={highlightFileId ?? undefined} />
            }
            return <FileGrid items={sorted} selectedIds={selected} onSelect={handleSelect} onOpen={handleOpen} onContextMenu={(item, x, y) => setContextMenu({ item, x, y })} />
          })()}
        </div>
      </div>

      {contextMenu && <FileContextMenu item={contextMenu.item} x={contextMenu.x} y={contextMenu.y} canAddToQueue={!!activePlaylistId && playlistTracks.length < playlistMaxTracks} canAddToPlayer={!!activePlaylistId} onAction={handleContextMenuAction} onClose={() => setContextMenu(null)} />}
      {shareItem && <ShareDialog item={shareItem} onClose={() => setShareItem(null)} />}
      {previewItem && (
        <PreviewModal
          item={previewItem}
          siblings={files ?? []}
          onDelete={(itemToDelete) => {
            // Find which sibling to show next before the item disappears from the list
            const nonFolders = (files ?? []).filter(f => !f.is_folder)
            const idx = nonFolders.findIndex(f => f.id === itemToDelete.id)
            const next = idx >= 0 ? (nonFolders[idx + 1] ?? nonFolders[idx - 1] ?? null) : null
            trash.mutate(itemToDelete.id)
            if (next) {
              setPreviewItem(next)
            } else {
              setPreviewItem(null)
              if (previewFileId) ignorePromise(navigate({ to: '/files', search: { folder: folderId ?? undefined, highlight: highlightFileId ?? undefined }, replace: true }))
            }
          }}
          onClose={() => {
            setPreviewItem(null)
            // Clear ?preview= param from URL but keep highlight so the file stays marked
            if (previewFileId) ignorePromise(navigate({ to: '/files', search: { folder: folderId ?? undefined, highlight: highlightFileId ?? undefined }, replace: true }))
          }}
        />
      )}
      {ooItem && systemSettings?.onlyoffice_url && (
        <OnlyOfficeEditor
          item={ooItem}
          onlyofficeUrl={systemSettings.onlyoffice_url}
          backLabel={t('page.myFiles')}
          onClose={() => ignorePromise(navigate({ to: '/files', search: { folder: folderId ?? undefined, highlight: highlightFileId ?? undefined } }))}
        />
      )}
      {teItem && (
        <TextEditor
          item={teItem}
          onClose={() => ignorePromise(navigate({ to: '/files', search: { folder: folderId ?? undefined, highlight: highlightFileId ?? undefined } }))}
        />
      )}
      {downloadIds && <DownloadDialog ids={downloadIds} onClose={() => setDownloadIds(null)} />}
      {moveItem && (
        <FolderPickerDialog
          title={`${t('action.move')} "${moveItem.name}"`}
          confirmLabel={t('misc.moveHere')}
          excludeId={moveItem.id}
          onConfirm={destFolderId => moveFile.mutate({ id: moveItem.id, destFolderId })}
          onClose={() => setMoveItem(null)}
        />
      )}
      {bulkMoveOpen && (
        <FolderPickerDialog
          title={`${t('action.move')} ${selected.size} ${t('files.selected')}`}
          confirmLabel={t('misc.moveHere')}
          onConfirm={destFolderId => { ignorePromise(handleBulkMove(destFolderId)) }}
          onClose={() => setBulkMoveOpen(false)}
        />
      )}
      {duplicateItem && (
        <FolderPickerDialog
          title={`${t('action.copy')} "${duplicateItem.name}"`}
          confirmLabel={t('misc.duplicateHere')}
          excludeId={duplicateItem.id}
          onConfirm={destFolderId => copyFile.mutate({ id: duplicateItem.id, destFolderId })}
          onClose={() => setDuplicateItem(null)}
        />
      )}
      {folderPlaylistJob && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            aria-label="Close playlist dialog"
            className="absolute inset-0 bg-black/50"
            onClick={() => setFolderPlaylistJob(null)}
          />
          <div
            className="relative z-10 bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-5 w-80 space-y-4 shadow-xl"
          >
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100 mb-1">{t('playlist.addToPlaylist')}</h3>
              <p className="text-sm text-muted">
                Mappen “{folderPlaylistJob.folder.name}” indeholder{' '}
                <span className="font-medium text-zinc-700 dark:text-slate-200">{folderPlaylistJob.audioFiles.length}</span>{' '}
                lydfiler — en playlist kan max indeholde 50 numre.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <button type="button"
                onClick={() => ignorePromise(doCreateFolderPlaylist(
                  folderPlaylistJob.folder,
                  folderPlaylistJob.audioFiles,
                  folderPlaylistJob.existingM3u,
                  'first50',
                ))}
                className="w-full px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors"
              >
                {t('playlist.first50')}
              </button>
              <button type="button"
                onClick={() => ignorePromise(doCreateFolderPlaylist(
                  folderPlaylistJob.folder,
                  folderPlaylistJob.audioFiles,
                  folderPlaylistJob.existingM3u,
                  'random50',
                ))}
                className="w-full px-4 py-2 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm font-medium text-zinc-700 dark:text-slate-300 hover:bg-zinc-50 dark:hover:bg-[#2d3148] transition-colors"
              >
                {t('playlist.random50')}
              </button>
              <button type="button"
                onClick={() => setFolderPlaylistJob(null)}
                className="w-full px-4 py-2 rounded-lg text-sm text-muted hover:text-zinc-700 dark:hover:text-slate-200 transition-colors"
              >
                {t('action.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      <UploadProgress uploads={uploads} onDismiss={dismiss} directUpload={directUpload} />

      {shareTargetFiles.length > 0 && (
        <ShareTargetDialog
          files={shareTargetFiles}
          currentFolderId={folderId}
          onUpload={(files, targetFolderId) => beginUploadWithConflictCheck(files, targetFolderId)}
          onClose={clearShareTarget}
        />
      )}

      <UploadConflictDialog
        open={uploadConflictOpen}
        queue={uploadConflictQueue}
        applyAll={uploadConflictApplyAll}
        onApplyAllChange={setUploadConflictApplyAll}
        onClose={closeUploadConflictDialog}
        onResolve={resolveUploadConflict}
        compareUpdatedLabel={compareUpdatedLabel}
        t={t}
      />

      <UploadGlobalDuplicateDialog
        open={uploadDuplicateOpen}
        queue={uploadDuplicateQueue}
        renames={uploadDuplicateRenames}
        onRename={(id, value) => setUploadDuplicateRenames(prev => ({ ...prev, [id]: value }))}
        onClose={closeUploadDuplicateDialog}
        onSkipConflicts={skipUploadDuplicates}
        onConfirm={confirmUploadDuplicate}
        t={t}
      />

      {renameId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <form className="bg-white dark:bg-[#1a1d27] border border-zinc-200 dark:border-[#2d3148] rounded-xl p-5 w-80 space-y-3" onSubmit={e => { e.preventDefault(); rename.mutate({ id: renameId!, name: renameName }) }}>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">{t('action.rename')}</h3>
            <input autoFocus value={renameName} onChange={e => setRenameName(e.target.value)} className="w-full rounded-lg border border-zinc-200 dark:border-[#2d3148] bg-zinc-50 dark:bg-[#0f1117] px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRenameId(null)} className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-[#2d3148] text-sm text-muted">{t('action.cancel')}</button>
              <button type="submit" disabled={!renameName.trim() || rename.isPending} className="px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium disabled:opacity-50">{t('action.rename')}</button>
            </div>
          </form>
        </div>
      )}
    </DropZone>
  )
}





