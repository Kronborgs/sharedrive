export interface UploadRoutingSettings {
  direct_upload_url?: string
  direct_uploads_enabled?: boolean
  upload_endpoint?: string
}

export interface UploadFileRequest {
  file: File
  overwrite?: boolean
}

interface MultipartUploadDependencies {
  post: (formData: FormData) => Promise<unknown>
  update: (patch: { status: 'uploading' | 'done' | 'error'; progress?: number; error?: string }) => void
  refresh: () => void
}

function trimTrailingSlashes(input: string): string {
  let output = input
  while (output.endsWith('/')) output = output.slice(0, -1)
  return output
}

export function resolveUploadRouting(settings?: UploadRoutingSettings): {
  endpoint: string
  directUpload: boolean
} {
  const directUploadURL = trimTrailingSlashes(settings?.direct_upload_url ?? '')
  const configuredEndpoint = trimTrailingSlashes(settings?.upload_endpoint ?? '')
  return {
    endpoint: configuredEndpoint || (directUploadURL ? `${directUploadURL}/upload/` : '/upload/'),
    directUpload: settings?.direct_uploads_enabled ?? directUploadURL !== '',
  }
}

export function isCrossOriginEndpoint(endpoint: string, currentOrigin: string): boolean {
  try {
    return new URL(endpoint, currentOrigin).origin !== currentOrigin
  } catch {
    return false
  }
}

export async function ensureDirectUploadAvailable(
  endpoint: string,
  currentOrigin: string,
  request: (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status'>> = fetch,
): Promise<void> {
  if (!isCrossOriginEndpoint(endpoint, currentOrigin)) return

  const response = await request(endpoint, { method: 'OPTIONS', mode: 'cors' })
  if (!response.ok) {
    throw new Error(`Direct upload unavailable (${response.status})`)
  }
}

export function shouldFallbackToMultipart(endpoint: string, currentOrigin: string, bytesUploaded: number): boolean {
  return isCrossOriginEndpoint(endpoint, currentOrigin) && bytesUploaded === 0
}

export function createTusMetadata(request: UploadFileRequest, targetFolderId: string | null): Record<string, string> {
  const metadata: Record<string, string> = { filename: request.file.name }
  if (targetFolderId) metadata.folder_id = targetFolderId
  if (request.overwrite) metadata.overwrite = '1'
  return metadata
}

export async function createTusHeaders(
  endpoint: string,
  currentOrigin: string,
  targetFolderId: string | null,
  issueToken: (payload: { folder_id?: string }) => Promise<{ token?: string }>,
): Promise<Record<string, string> | undefined> {
  if (!isCrossOriginEndpoint(endpoint, currentOrigin)) return undefined

  const issued = await issueToken(targetFolderId ? { folder_id: targetFolderId } : {})
  return issued.token ? { 'X-Upload-Token': issued.token } : undefined
}

export async function performMultipartUpload(
  request: UploadFileRequest,
  targetFolderId: string | null,
  dependencies: MultipartUploadDependencies,
): Promise<void> {
  try {
    const formData = new FormData()
    formData.append('file', request.file)
    if (targetFolderId) formData.append('folder_id', targetFolderId)
    if (request.overwrite) formData.append('overwrite', '1')
    dependencies.update({ status: 'uploading' })
    await dependencies.post(formData)
    dependencies.update({ progress: 100, status: 'done' })
    dependencies.refresh()
  } catch (error) {
    dependencies.update({
      status: 'error',
      error: error instanceof Error ? error.message : 'Upload failed',
    })
  }
}