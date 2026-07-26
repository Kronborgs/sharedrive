import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { UploadRequest } from '@/components/files/UploadZone'
import {
  createDuplicateUploadQueue,
  fetchDuplicateHitsByName,
  partitionUploadRequests,
  renameUploadRequest,
  type DuplicateUploadEntry,
  type UploadConflictPair,
} from '@/lib/upload-duplicates'

interface UseUploadDuplicateWorkflowParams {
  folderId: string | null
  startUpload: (requests: UploadRequest[], targetFolderId?: string | null) => void
  t: (...args: any[]) => string
}

export function useUploadDuplicateWorkflow({
  folderId,
  startUpload,
  t,
}: Readonly<UseUploadDuplicateWorkflowParams>) {
  const [uploadConflictOpen, setUploadConflictOpen] = useState(false)
  const [uploadConflictQueue, setUploadConflictQueue] = useState<UploadConflictPair[]>([])
  const [uploadConflictResolved, setUploadConflictResolved] = useState<UploadRequest[]>([])
  const [uploadConflictApplyAll, setUploadConflictApplyAll] = useState(false)
  const [uploadConflictTargetFolderId, setUploadConflictTargetFolderId] = useState<string | null>(null)

  const [uploadDuplicateOpen, setUploadDuplicateOpen] = useState(false)
  const [uploadDuplicateQueue, setUploadDuplicateQueue] = useState<DuplicateUploadEntry[]>([])
  const [uploadDuplicatePending, setUploadDuplicatePending] = useState<UploadRequest[]>([])
  const [uploadDuplicateTargetFolderId, setUploadDuplicateTargetFolderId] = useState<string | null>(null)
  const [uploadDuplicateRenames, setUploadDuplicateRenames] = useState<Record<string, string>>({})

  const compareUpdatedLabel = useCallback((incoming: File, existing: { updated_at: string }) => {
    const existingTs = Date.parse(existing.updated_at)
    if (Number.isNaN(existingTs) || !incoming.lastModified) return t('upload.conflictUnknownTime')
    if (incoming.lastModified > existingTs) return t('upload.conflictIncomingNewer')
    if (incoming.lastModified < existingTs) return t('upload.conflictIncomingOlder')
    return t('upload.conflictSameTime')
  }, [t])

  const checkGlobalDuplicates = useCallback(async (requests: UploadRequest[], targetFolderId: string | null) => {
    if (requests.length === 0) return

    const duplicateHitsByName = await fetchDuplicateHitsByName([...new Set(requests.map(request => request.file.name))])
    const partitioned = partitionUploadRequests(requests, duplicateHitsByName, targetFolderId)

    if (partitioned.conflicts.length > 0) {
      setUploadConflictResolved(partitioned.immediate)
      setUploadConflictQueue(partitioned.conflicts)
      setUploadConflictApplyAll(false)
      setUploadConflictTargetFolderId(targetFolderId)
      setUploadConflictOpen(true)
      return
    }

    if (partitioned.globalDuplicates.length > 0) {
      const queue = createDuplicateUploadQueue(partitioned.globalDuplicates)
      setUploadDuplicateQueue(queue)
      setUploadDuplicateRenames(Object.fromEntries(queue.map(entry => [entry.id, entry.incoming.file.name])))
      setUploadDuplicatePending(partitioned.immediate)
      setUploadDuplicateTargetFolderId(targetFolderId)
      setUploadDuplicateOpen(true)
      return
    }

    startUpload(partitioned.immediate, targetFolderId)
  }, [startUpload])

  const beginUploadWithConflictCheck = useCallback(async (incomingFiles: File[], targetFolderId?: string | null) => {
    if (incomingFiles.length === 0) return

    // `null` is an explicit request to upload to root; `undefined` means use
    // the folder currently open in the file browser.
    const effectiveTargetFolderId = targetFolderId === undefined ? folderId : targetFolderId
    const requests = incomingFiles.map(file => ({ file, overwrite: false }))
    const duplicateHitsByName = await fetchDuplicateHitsByName([...new Set(incomingFiles.map(file => file.name))])
    const partitioned = partitionUploadRequests(requests, duplicateHitsByName, effectiveTargetFolderId)

    if (partitioned.conflicts.length > 0) {
      setUploadConflictResolved(partitioned.immediate)
      setUploadConflictQueue(partitioned.conflicts)
      setUploadConflictApplyAll(false)
      setUploadConflictTargetFolderId(effectiveTargetFolderId)
      setUploadConflictOpen(true)
      return
    }

    if (partitioned.globalDuplicates.length > 0) {
      const queue = createDuplicateUploadQueue(partitioned.globalDuplicates)
      setUploadDuplicateQueue(queue)
      setUploadDuplicateRenames(Object.fromEntries(queue.map(entry => [entry.id, entry.incoming.file.name])))
      setUploadDuplicatePending(partitioned.immediate)
      setUploadDuplicateTargetFolderId(effectiveTargetFolderId)
      setUploadDuplicateOpen(true)
      return
    }

    startUpload(partitioned.immediate, effectiveTargetFolderId)
  }, [folderId, startUpload])

  const closeUploadConflictDialog = useCallback(() => {
    setUploadConflictOpen(false)
    setUploadConflictQueue([])
    setUploadConflictResolved([])
    setUploadConflictApplyAll(false)
    setUploadConflictTargetFolderId(null)
  }, [])

  const resolveUploadConflict = useCallback((choice: 'overwrite' | 'skip') => {
    if (uploadConflictQueue.length === 0) {
      closeUploadConflictDialog()
      return
    }

    const [current, ...rest] = uploadConflictQueue
    const nextResolved = choice === 'overwrite'
      ? [...uploadConflictResolved, { file: current.incoming, overwrite: true }]
      : [...uploadConflictResolved]

    let nextQueue = rest
    if (uploadConflictApplyAll) {
      if (choice === 'overwrite') {
        for (const pair of rest) {
          nextResolved.push({ file: pair.incoming, overwrite: true })
        }
      }
      nextQueue = []
    }

    if (nextQueue.length > 0) {
      setUploadConflictQueue(nextQueue)
      setUploadConflictResolved(nextResolved)
      return
    }

    closeUploadConflictDialog()
    if (nextResolved.length === 0) {
      toast.info(t('upload.allConflictsSkipped'))
      return
    }
    checkGlobalDuplicates(nextResolved, uploadConflictTargetFolderId)
  }, [
    checkGlobalDuplicates,
    closeUploadConflictDialog,
    folderId,
    t,
    uploadConflictApplyAll,
    uploadConflictQueue,
    uploadConflictResolved,
    uploadConflictTargetFolderId,
  ])

  const closeUploadDuplicateDialog = useCallback(() => {
    setUploadDuplicateOpen(false)
    setUploadDuplicateQueue([])
    setUploadDuplicatePending([])
    setUploadDuplicateTargetFolderId(null)
    setUploadDuplicateRenames({})
  }, [])

  const confirmUploadDuplicate = useCallback(() => {
    const renamedQueue = uploadDuplicateQueue.map(entry => {
      const nextName = uploadDuplicateRenames[entry.id] ?? entry.incoming.file.name
      return renameUploadRequest(entry.incoming, nextName)
    })
    const targetFolder = uploadDuplicateTargetFolderId
    closeUploadDuplicateDialog()
    startUpload([...uploadDuplicatePending, ...renamedQueue], targetFolder)
  }, [
    closeUploadDuplicateDialog,
    folderId,
    startUpload,
    uploadDuplicatePending,
    uploadDuplicateQueue,
    uploadDuplicateRenames,
    uploadDuplicateTargetFolderId,
  ])

  return {
    uploadConflictOpen,
    uploadConflictQueue,
    uploadConflictApplyAll,
    uploadDuplicateOpen,
    uploadDuplicateQueue,
    uploadDuplicateRenames,
    compareUpdatedLabel,
    beginUploadWithConflictCheck,
    setUploadConflictApplyAll,
    closeUploadConflictDialog,
    resolveUploadConflict,
    setUploadDuplicateRenames,
    closeUploadDuplicateDialog,
    confirmUploadDuplicate,
  }
}
