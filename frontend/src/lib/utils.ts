import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso))
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['jpg','jpeg','png','gif','webp','svg','avif','bmp'].includes(ext)) return '🖼️'
  if (['mp4','mov','avi','mkv','webm'].includes(ext)) return '🎬'
  if (['mp3','wav','flac','ogg','m4a'].includes(ext)) return '🎵'
  if (['pdf'].includes(ext)) return '📄'
  if (['zip','tar','gz','7z','rar','bz2'].includes(ext)) return '🗜️'
  if (['doc','docx','odt','rtf'].includes(ext)) return '📝'
  if (['xls','xlsx','csv'].includes(ext)) return '📊'
  if (['ppt','pptx'].includes(ext)) return '📊'
  if (['txt','md','log'].includes(ext)) return '📃'
  if (['js','ts','jsx','tsx','py','go','rs','c','cpp','h','html','css','json','yaml','yml','sh'].includes(ext)) return '💻'
  return '📄'
}
