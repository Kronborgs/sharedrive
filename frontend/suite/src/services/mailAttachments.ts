import { fileExtension, shouldOpenInOnlyOffice, shouldOpenInTextEditor } from '../../../src/lib/file-types'
import { getAttachmentDownloadUrl } from './mailApi'
import type { MailDetail, MailAttachment } from '../types/mail'

type AttachmentEditor = 'oo' | 'te' | 'preview'

function attachmentFilename(filename: string) {
  return filename.split(/[\\/]/).pop()?.trim() || 'vedhaeftning'
}

export function sharedriveAttachmentEditor(filename: string): AttachmentEditor | undefined {
  const name = attachmentFilename(filename)
  if (shouldOpenInOnlyOffice(name)) return 'oo'
  if (shouldOpenInTextEditor(name)) return 'te'
  const extension = fileExtension(name)
  if (extension === 'stl' || extension === '3mf') return 'preview'
  return undefined
}

async function uploadCopy(file: Blob, filename: string) {
  const form = new FormData()
  form.set('file', file, filename)
  return fetch('/api/v1/files/upload', { method: 'POST', credentials: 'same-origin', body: form })
}

function uniqueFilename(filename: string) {
  const dot = filename.lastIndexOf('.')
  const suffix = ' (' + crypto.randomUUID().slice(0, 8) + ')'
  if (dot === 0) return 'kopi' + suffix + filename
  if (dot === -1) return filename + suffix + '.' + fileExtension(filename)
  return filename.slice(0, dot) + suffix + filename.slice(dot)
}

/** Imports a private, editable copy and returns the existing Sharedrive file URL. */
export async function openMailAttachment(message: Pick<MailDetail, 'folder' | 'uid'>, attachment: MailAttachment) {
  const downloadUrl = getAttachmentDownloadUrl(message.folder, message.uid, attachment.id)
  const editor = sharedriveAttachmentEditor(attachment.filename)
  if (editor === 'oo') {
    const settings = await fetch('/api/v1/system/settings', { credentials: 'same-origin' })
    if (!settings.ok) throw new Error('Kunne ikke hente Sharedrives dokumentindstillinger.')
    const result = await settings.json()
    if (!result.data?.onlyoffice_url) return downloadUrl
  }
  if (!editor) return downloadUrl

  const download = await fetch(downloadUrl, { credentials: 'same-origin' })
  if (!download.ok) throw new Error('Kunne ikke hente vedhæftningen fra mailen.')
  let filename = attachmentFilename(attachment.filename)
  // Declare text as inert and keep sender-supplied MIME types out of the file library.
  const type = { oo: 'application/vnd.ms-office', te: 'text/plain', preview: 'model/' + fileExtension(filename) }[editor]
  const file = new Blob([await download.blob()], { type })
  let upload = await uploadCopy(file, filename)
  if (upload.status === 409) {
    filename = uniqueFilename(filename)
    upload = await uploadCopy(file, filename)
  }
  if (!upload.ok) {
    if (upload.status === 413) throw new Error('Vedhæftningen overskrider kontoens maksimale uploadstørrelse.')
    if (upload.status === 422) throw new Error('Der er ikke nok ledig plads i Mine filer.')
    throw new Error('Kunne ikke gemme en kopi i Mine filer.')
  }
  const result = await upload.json()
  const id = result.data?.id
  if (typeof id !== 'string' || !id) throw new Error('Sharedrive returnerede ikke den gemte fil.')
  return '/files?' + new URLSearchParams({ [editor]: id })
}
