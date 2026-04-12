import type { ActivityEvent, ApiResponse, PrepareDownloadRequest, PrepareDownloadResponse } from '@/types/api'

// Base URL — empty string means same origin (correct for both dev proxy and production)
const BASE = ''

class ApiClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {}
  let bodyContent: BodyInit | undefined

  if (body instanceof FormData) {
    bodyContent = body
    // Let browser set Content-Type with boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    bodyContent = JSON.stringify(body)
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: bodyContent,
    credentials: 'include', // send session + trust cookies
    signal,
  })

  // 204 No Content — nothing to parse
  if (res.status === 204) {
    return undefined as T
  }

  // Parse JSON envelope — the proxy (Cloudflare) may replace 5xx bodies with
  // its own HTML error page, so we must handle non-JSON responses gracefully.
  let json: ApiResponse<T>
  try {
    json = await res.json()
  } catch {
    throw new ApiClientError(
      'PROXY_ERROR',
      `Request failed with status ${res.status} — try again or check server logs`,
      res.status,
    )
  }

  if (json.error) {
    throw new ApiClientError(json.error.code, json.error.message, res.status)
  }

  return json.data as T
}

export const api = {
  get:    <T>(path: string, signal?: AbortSignal) => request<T>('GET',    path, undefined, signal),
  post:   <T>(path: string, body?: unknown)        => request<T>('POST',   path, body),
  put:    <T>(path: string, body?: unknown)        => request<T>('PUT',    path, body),
  patch:  <T>(path: string, body?: unknown)        => request<T>('PATCH',  path, body),
  delete: <T>(path: string)                        => request<T>('DELETE', path),
}

export function prepareDownload(req: PrepareDownloadRequest): Promise<PrepareDownloadResponse> {
  return request<PrepareDownloadResponse>('POST', '/api/v1/files/prepare-download', req)
}

export function fetchActivity(): Promise<ActivityEvent[]> {
  return api.get<ActivityEvent[]>('/api/v1/me/activity')
}

// ── TOTP ──────────────────────────────────────────────────────────────────────

export interface TOTPSetupData {
  secret: string
  provisioning_uri: string
}

export interface TOTPConfirmData {
  backup_codes: string[]
}

export function fetchTOTPSetup(): Promise<TOTPSetupData> {
  return api.get<TOTPSetupData>('/api/v1/me/totp/setup')
}

export function confirmTOTPSetup(code: string): Promise<TOTPConfirmData> {
  return api.post<TOTPConfirmData>('/api/v1/me/totp/confirm', { code })
}

export function disableTOTP(): Promise<void> {
  return api.delete('/api/v1/me/totp')
}

export function adminRevokeTOTP(userId: string): Promise<void> {
  return api.delete(`/api/v1/admin/users/${userId}/totp`)
}

export function adminRequireTOTP(userId: string): Promise<void> {
  return api.post(`/api/v1/admin/users/${userId}/require-totp`, {})
}

export function adminUnrequireTOTP(userId: string): Promise<void> {
  return api.delete(`/api/v1/admin/users/${userId}/require-totp`)
}

// ── Playlist ──────────────────────────────────────────────────────────────────

export interface PlaylistTrack {
  id: string
  name: string
  preview_url: string
  mime_type: string | null
}

export function fetchPlaylistTracks(fileId: string): Promise<PlaylistTrack[]> {
  return api.get<PlaylistTrack[]>(`/api/v1/files/${fileId}/playlist/tracks`)
}

export function createPlaylist(name: string, parentId: string | null, fileIds: string[]): Promise<{ id: string }> {
  return api.post<{ id: string }>('/api/v1/files/playlist', { name, parent_id: parentId, file_ids: fileIds })
}

export function updatePlaylistTracks(fileId: string, fileIds: string[]): Promise<void> {
  return api.put(`/api/v1/files/${fileId}/playlist/tracks`, { file_ids: fileIds })
}

// ── Per-user playlist state (cross-device persistence) ────────────────────────

export interface PersistedPlaylistState {
  id: string
  name: string
  index: number
  vol: number
  shuffle: boolean
}

export function fetchPersistedPlaylistState(): Promise<PersistedPlaylistState | null> {
  return api.get<PersistedPlaylistState | null>('/api/v1/me/playlist-state')
}

export function savePersistedPlaylistState(state: PersistedPlaylistState | null): Promise<void> {
  return api.put('/api/v1/me/playlist-state', state)
}

export { ApiClientError }
