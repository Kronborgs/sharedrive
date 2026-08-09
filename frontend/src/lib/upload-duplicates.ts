import { api } from '@/lib/api'
import type { UploadRequest } from '@/components/files/UploadZone'

export interface UploadConflictPair {
  incoming: UploadRequest
  existing: NameDuplicateHit
}

export interface NameDuplicateHit {
  id: string
  parent_id: string | null
  owner_id: string
  is_folder: boolean
  name: string
  updated_at: string
  full_path: string
}

export interface DuplicateUploadEntry {
  id: string
  incoming: UploadRequest
  matches: NameDuplicateHit[]
}

export async function fetchDuplicateHitsByName(names: string[]): Promise<Map<string, NameDuplicateHit[]>> {
  const pairs = await Promise.all(names.map(async name => {
    try {
      const hits = await api.get<NameDuplicateHit[]>(`/api/v1/files/duplicates?name=${encodeURIComponent(name)}`)
      return [name, hits] as const
    } catch {
      return [name, [] as NameDuplicateHit[]] as const
    }
  }))
  return new Map(pairs)
}

export function partitionUploadRequests(
  requests: UploadRequest[],
  duplicateHitsByName: Map<string, NameDuplicateHit[]>,
  targetFolderId: string | null,
): {
  conflicts: UploadConflictPair[]
  immediate: UploadRequest[]
  globalDuplicates: Array<{ incoming: UploadRequest; matches: NameDuplicateHit[] }>
} {
  const conflicts: UploadConflictPair[] = []
  const immediate: UploadRequest[] = []
  const globalDuplicates: Array<{ incoming: UploadRequest; matches: NameDuplicateHit[] }> = []

  for (const request of requests) {
    const matches = duplicateHitsByName.get(request.file.name) ?? []
    const requestTargetFolderId = request.targetFolderId === undefined
      ? targetFolderId
      : request.targetFolderId
    const sameFolderMatch = matches.find(match => match.parent_id === requestTargetFolderId)
    if (sameFolderMatch && !request.overwrite) {
      conflicts.push({ incoming: request, existing: sameFolderMatch })
      continue
    }

    const otherMatches = matches.filter(match => match.parent_id !== requestTargetFolderId)
    if (otherMatches.length > 0) {
      globalDuplicates.push({ incoming: request, matches: otherMatches })
      continue
    }

    immediate.push(request)
  }

  return { conflicts, immediate, globalDuplicates }
}

export function createDuplicateUploadQueue(entries: Array<{ incoming: UploadRequest; matches: NameDuplicateHit[] }>): DuplicateUploadEntry[] {
  return entries.map(entry => ({
    id: crypto.randomUUID(),
    incoming: entry.incoming,
    matches: entry.matches,
  }))
}

export function renameUploadRequest(request: UploadRequest, newName: string): UploadRequest {
  const trimmedName = newName.trim()
  if (!trimmedName || trimmedName === request.file.name) return request
  return {
    ...request,
    file: new File([request.file], trimmedName, {
      type: request.file.type,
      lastModified: request.file.lastModified,
    }),
  }
}
