export interface UploadRoutingSettings {
  direct_upload_url?: string
  direct_uploads_enabled?: boolean
  upload_endpoint?: string
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