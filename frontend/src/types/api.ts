// ─── API types matching backend response shapes ───────────────────────────────

export interface ApiResponse<T> {
  data: T | null
  error: ApiError | null
}

export interface ApiError {
  code: string
  message: string
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface User {
  id: string
  email: string
  display_name: string
  role: 'user' | 'admin' | 'guest'
  is_admin: boolean
  is_active: boolean
  totp_enabled?: boolean
  force_totp_setup?: boolean
  quota_bytes: number
  quota_used_bytes: number
  bandwidth_limit_bytes_per_day: number | null
  max_upload_bytes: number | null
  webdav_enabled: boolean
  trash_retention_days: number | null
  invited_by: string | null
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export interface GuestSharedItem {
  resource_id: string
  name: string
  is_folder: boolean
  owner_email: string
}

export interface GuestUser {
  id: string
  email: string
  display_name: string
  last_login_at: string | null
  created_at: string
  invited_by_name: string | null
  shared_items: GuestSharedItem[]
}

export interface Session {
  id: string
  ip_address: string | null
  user_agent: string | null
  is_admin_session: boolean
  last_seen_at: string
  expires_at: string
  created_at: string
}

export interface LoginRequest {
  email: string
  password: string
  trust_device?: boolean
}

export interface LoginResponse {
  status: 'ok' | 'totp_required'
  pending_token?: string
  require_totp?: boolean
  require_password_change?: boolean
  reset_token?: string
}

export interface TOTPVerifyRequest {
  pending_token: string
  code: string
  trust_device?: boolean
}

// ── Files ─────────────────────────────────────────────────────────────────────

export interface FileItem {
  id: string
  parent_id: string | null
  owner_id: string
  is_folder: boolean
  name: string
  mime_type: string | null
  size_bytes: number
  checksum_sha256: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
  // resolved fields
  shared?: boolean
  permissions?: SharePermissions
  tags?: Array<{ id: string; name: string; color: string }>
}

export interface SharePermissions {
  can_view: boolean
  can_upload: boolean
  can_edit: boolean
  can_delete: boolean
  can_reshare: boolean
  is_owner: boolean
}

// ── Shares ────────────────────────────────────────────────────────────────────

export interface Share {
  id: string
  resource_id: string
  owner_id: string
  grantee_type: 'user' | 'group' | 'link' | 'pending'
  grantee_id?: string | null
  grantee_email?: string | null
  grantee_group_name?: string | null
  pending_email?: string | null
  token?: string | null
  can_view: boolean
  can_upload: boolean
  can_edit: boolean
  can_delete: boolean
  can_reshare: boolean
  created_by: string
  expires_at: string | null
  revoked_at: string | null
  created_at: string
}

export interface CreateShareRequest {
  resource_id: string
  grantee_type: 'user' | 'group' | 'link'
  can_view?: boolean
  can_upload?: boolean
  can_edit?: boolean
  can_delete?: boolean
  can_reshare?: boolean
  expires_at?: string | null
}

// ── Groups ────────────────────────────────────────────────────────────────────

export interface Group {
  id: string
  name: string
  description: string
  color: string
  created_by: string
  created_at: string
  member_count?: number
}

// ── Tags ──────────────────────────────────────────────────────────────────────

export interface Tag {
  id: string
  name: string
  color: string
  created_by: string
  created_at: string
}

// ── App passwords ─────────────────────────────────────────────────────────────

export interface AppPassword {
  id: string
  name: string
  scope: string
  resource_id?: string | null
  resource_label?: string | null
  last_used_at: string | null
  created_at: string
}

export interface CreatedAppPassword extends AppPassword {
  password: string // shown once only
}

export interface BackupPasswordStatus {
  has_password: boolean
  id?: string
  last_used_at?: string | null
  created_at?: string
}

export interface GeneratedBackupPassword {
  id: string
  token: string // shown exactly once — the raw backup token
}

export interface RestoreResult {
  files_restored: number
  folders_restored: number
  bytes_restored: number
  skipped: number
}

export interface BackupConfig {
  tertiary_enabled: boolean
  buddy_enabled: boolean
  disk_total_bytes?: number
  disk_free_bytes?: number
}

export interface BuddyUserConfig {
  user_id: string
  peer_configured: boolean
  peer_url: string
  has_receive_token: boolean
  receive_token_prefix: string
}

export interface GeneratedBuddyReceiveToken {
  token: string
  prefix: string
}

export interface TertiaryArchive {
  filename: string
  size_bytes: number
  created_at: string
}

export interface BuddyArchive {
  filename: string
  size_bytes: number
  received_at: string
}

export interface AutoBackupConfig {
  enabled: boolean
  interval_hours: number
  retention_days: number
  folder_ids: string[]
  last_run_at?: string | null
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export interface AuditLog {
  id: string
  event_type: string
  actor_id: string | null
  actor_email: string
  target_user_id: string | null
  target_email?: string | null
  resource_type: string
  resource_id: string | null
  resource_name: string
  metadata: Record<string, unknown> | null
  ip_address: string
  user_agent: string
  is_admin_action: boolean
  created_at: string
}

export interface BlockedIP {
  ip: string
  tier: string
  ttl_seconds: number | null // null = manual (no TTL)
  attempt_count: number
}

export interface IPWhitelistEntry {
  id: string
  ip_cidr: string
  description: string
  created_at: string
}

// ── System ────────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string
  db: string
  redis: string
  version?: string
  built?: string
}

export interface OnboardingStatus {
  required: boolean
}

// ── Pagination ────────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  cursor_next: string | null
}

// ── Preview & Download ────────────────────────────────────────────────────────

export interface PrepareDownloadRequest {
  ids: string[]
  use_password: boolean
  custom_password?: string
}

export interface PrepareDownloadResponse {
  token: string
  password?: string
  expires_in: number
}

// ── Activity ──────────────────────────────────────────────────────────────────

export interface ActivityEvent {
  id: string
  event_type: string
  resource_name: string | null
  ip_address: string
  created_at: string
}
