import { api } from '@/lib/api'

export type NoteType = 'text' | 'checklist'
export type NotePermission = 'view' | 'check' | 'edit'

export interface NoteItem {
  id: string
  note_id: string
  content: string
  is_checked: boolean
  position: number
  created_at: string
  updated_at: string
}

export interface Note {
  id: string
  owner_id: string
  type: NoteType
  title: string
  content: string
  color?: string
  is_pinned: boolean
  is_archived: boolean
  hide_completed: boolean
  deleted_at?: string
  version: number
  created_at: string
  updated_at: string
  last_edited_by?: string
  items: NoteItem[]
}

export interface NoteShare {
  id: string
  note_id: string
  recipient_email: string
  permission: NotePermission
  expires_at?: string
  revoked_at?: string
  last_sent_at?: string
  last_opened_at?: string
  created_at: string
  updated_at: string
}

export interface GuestNote {
  note: Note
  recipient_email: string
  permission: NotePermission
  expires_at?: string
}

export interface NoteUpdate {
  version: number
  title?: string
  content?: string
  is_pinned?: boolean
  is_archived?: boolean
  hide_completed?: boolean
}

export function listNotes(params: URLSearchParams, signal?: AbortSignal) {
  return api.get<Note[]>(`/api/v1/notes?${params.toString()}`, signal)
}

export function getNote(id: string, includeDeleted = false, signal?: AbortSignal) {
  return api.get<Note>(`/api/v1/notes/${id}${includeDeleted ? '?include_deleted=true' : ''}`, signal)
}

export function createNote(type: NoteType) {
  return api.post<Note>('/api/v1/notes', { type, title: '', content: '', items: [] })
}

export function updateNote(id: string, update: NoteUpdate) {
  return api.patch<Note>(`/api/v1/notes/${id}`, update)
}

export function convertNoteToChecklist(id: string) {
  return api.post<Note>(`/api/v1/notes/${id}/checklist`)
}

export function createNoteItem(id: string, version: number, content = '', position?: number) {
  return api.post<Note>(`/api/v1/notes/${id}/items`, { version, content, position })
}

export function updateNoteItem(id: string, itemId: string, update: { version: number; content?: string; is_checked?: boolean }) {
  return api.patch<Note>(`/api/v1/notes/${id}/items/${itemId}`, update)
}

export function deleteNoteItem(id: string, itemId: string, version: number) {
  return api.delete<Note>(`/api/v1/notes/${id}/items/${itemId}?version=${version}`)
}

export function reorderNoteItems(id: string, version: number, itemIds: string[]) {
  return api.post<Note>(`/api/v1/notes/${id}/items/reorder`, { version, item_ids: itemIds })
}

export function listNoteShares(id: string, signal?: AbortSignal) {
  return api.get<NoteShare[]>(`/api/v1/notes/${id}/shares`, signal)
}

export function getGuestNote(id: string, signal?: AbortSignal) {
  return api.get<GuestNote>(`/api/v1/guest/notes/${id}`, signal)
}

export function updateGuestNote(id: string, update: NoteUpdate) {
  return api.patch<Note>(`/api/v1/guest/notes/${id}`, update)
}

export function updateGuestItem(id: string, itemId: string, update: { version: number; content?: string; is_checked?: boolean }) {
  return api.patch<Note>(`/api/v1/guest/notes/${id}/items/${itemId}`, update)
}

export function createGuestItem(id: string, version: number, content = '', position?: number) {
  return api.post<Note>(`/api/v1/guest/notes/${id}/items`, { version, content, position })
}

export function deleteGuestItem(id: string, itemId: string, version: number) {
  return api.delete<Note>(`/api/v1/guest/notes/${id}/items/${itemId}?version=${version}`)
}

export function reorderGuestItems(id: string, version: number, itemIds: string[]) {
  return api.post<Note>(`/api/v1/guest/notes/${id}/items/reorder`, { version, item_ids: itemIds })
}